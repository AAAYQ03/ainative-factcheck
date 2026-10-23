import { beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "@/lib/pipeline";
import { SAMPLES } from "@/lib/samples";
import { applyRevisions } from "@/lib/revise";
import { mockFetch, NOW } from "./mock";

beforeAll(() => {
  process.env.FUYAO_API_KEY = "test";
  process.env.DEEPSEEK_API_KEY = "test";
});

const wrong = SAMPLES.find((s) => s.id === "wrong-numbers")!.text;
const risky = SAMPLES.find((s) => s.id === "compliance")!.text;

// 模拟 LLM 对 ② 号稿件的抽取结果
const wrongExtraction = {
  claims: [
    { quote: "10月21日，宁德时代大跌8.5%", value_text: "8.5%", entity: "宁德时代", entity_type: "stock", metric: "price_change_pct", value: -8.5, approximate: false, comparator: "eq", as_of_date: "2026-10-21" },
    { quote: "宁德时代2025年营业收入4237.02亿元", value_text: "4237.02亿元", entity: "宁德时代", entity_type: "stock", metric: "revenue", value: 4237.02, fiscal_year: 2025 },
    { quote: "同比增长27%", value_text: "27%", entity: "宁德时代", entity_type: "stock", metric: "revenue_yoy_pct", value: 27, fiscal_year: 2025 },
    { quote: "归母净利润722亿元", value_text: "722亿元", entity: "宁德时代", entity_type: "stock", metric: "parent_net_profit", value: 722, fiscal_year: 2025 },
    { quote: "同比增长超过40%", value_text: "40%", entity: "宁德时代", entity_type: "stock", metric: "parent_net_profit_yoy_pct", value: 40, comparator: "gt", fiscal_year: 2025 },
    { quote: "同日，贵州茅台小幅上涨0.5%", value_text: "0.5%", entity: "贵州茅台", entity_type: "stock", metric: "price_change_pct", value: 0.5, as_of_date: "2026-10-21" },
    { quote: "这句话稿件里根本没有", value_text: "99%", entity: "贵州茅台", entity_type: "stock", metric: "price_change_pct", value: 99 },
  ],
  statements: [{ quote: "白酒板块表现稳健", kind: "opinion" }],
};

describe("主链路", () => {
  it("逐条核对数字：不符、方向相反、方向性表述、编造引用", async () => {
    const r = await runCheck(wrong, "none", mockFetch({ extraction: wrongExtraction }), NOW);
    const by = (m: string, v: number) => r.claims.find((c) => c.metric === m && c.value === v)!;

    expect(r.claims).toHaveLength(6); // 原文中不存在的引用被丢弃
    expect(by("price_change_pct", -8.5).status).toBe("mismatch");
    expect(by("price_change_pct", -8.5).actual).toBeCloseTo(-12.035, 2);
    expect(by("price_change_pct", -8.5).suggested_text).toBe("12.03%");
    expect(by("price_change_pct", -8.5).evidence?.source).toBe("/api/a-share/prices/historical");
    expect(by("revenue", 4237.02).status).toBe("match");
    expect(by("revenue_yoy_pct", 27).status).toBe("mismatch");
    expect(by("parent_net_profit", 722).status).toBe("match");
    expect(by("parent_net_profit_yoy_pct", 40).status).toBe("match"); // "超过40%"，实际 42.28%
    const flip = by("price_change_pct", 0.5);
    expect(flip.status).toBe("mismatch");
    expect(flip.reason).toContain("方向相反");
    expect(flip.suggested_text).toBeNull();
    expect(r.verdict).toBe("needs_revision");
  });

  it("每条已核实结论都带来源、字段、时点、口径", async () => {
    const r = await runCheck(wrong, "none", mockFetch({ extraction: wrongExtraction }), NOW);
    for (const c of r.claims.filter((x) => x.status !== "unverifiable")) {
      expect(c.evidence).toMatchObject({ source: expect.any(String), field: expect.any(String), as_of: expect.any(String), method: expect.any(String), unit: expect.any(String) });
    }
  });

  it("修订稿只应用采纳项", async () => {
    const r = await runCheck(wrong, "none", mockFetch({ extraction: wrongExtraction }), NOW);
    const target = r.claims.find((c) => c.value === -8.5)!;
    expect(applyRevisions(wrong, r, {})).toBe(wrong);
    const revised = applyRevisions(wrong, r, { [target.id]: "accepted" });
    expect(revised).toContain("大跌12.03%");
    expect(applyRevisions(wrong, r, { [target.id]: "rejected" })).toBe(wrong);
  });
});

describe("数据缺失 / 接口失败", () => {
  it("扶摇不可用：全部标为无法核实，不输出“通过”", async () => {
    const r = await runCheck(wrong, "fuyao_down", mockFetch({ extraction: wrongExtraction }), NOW);
    expect(r.claims.every((c) => c.status === "unverifiable")).toBe(true);
    expect(r.verdict).not.toBe("pass_pending_signoff");
    expect(r.trace.some((t) => !t.ok)).toBe(true);
  });

  it("数据过期：快照类结论不输出", async () => {
    const ext = { claims: [{ quote: "贵州茅台小幅上涨0.5%", value_text: "0.5%", entity: "贵州茅台", entity_type: "stock", metric: "price_change_pct", value: 0.5 }] };
    const r = await runCheck(wrong, "stale", mockFetch({ extraction: ext }), NOW);
    expect(r.claims[0].status).toBe("unverifiable");
    expect(r.claims[0].reason).toContain("过期");
  });

  it("标的不存在、非交易日、年报未披露 → 无法核实并说明原因", async () => {
    const text = "某某科技10月18日上涨3%。贵州茅台10月18日上涨1%。宁德时代2026年营业收入5000亿元。";
    const ext = {
      claims: [
        { quote: "某某科技10月18日上涨3%", value_text: "3%", entity: "某某科技", metric: "price_change_pct", value: 3, as_of_date: "2026-10-18" },
        { quote: "贵州茅台10月18日上涨1%", value_text: "1%", entity: "贵州茅台", metric: "price_change_pct", value: 1, as_of_date: "2026-10-18" },
        { quote: "宁德时代2026年营业收入5000亿元", value_text: "5000亿元", entity: "宁德时代", metric: "revenue", value: 5000, fiscal_year: 2026 },
      ],
    };
    const r = await runCheck(text, "none", mockFetch({ extraction: ext }), NOW);
    expect(r.claims.map((c) => c.status)).toEqual(["unverifiable", "unverifiable", "unverifiable"]);
    expect(r.claims[0].reason).toContain("找不到标的");
    expect(r.claims[1].reason).toContain("非交易日");
    expect(r.claims[2].reason).toContain("2026 年年报");
    expect(r.verdict).toBe("needs_review");
  });

  it("LLM 返回非法 JSON：核查未完成，但规则合规扫描仍生效", async () => {
    const r = await runCheck(risky, "none", mockFetch({ llmBroken: true }), NOW);
    expect(r.verdict).toBe("incomplete");
    expect(r.claims).toHaveLength(0);
    expect(r.compliance.length).toBeGreaterThan(0);
    expect(r.compliance.every((f) => f.detector === "rule")).toBe(true);
  });

  it("不支持的陈述类型不会被静默判为一致", async () => {
    const ext = { claims: [{ quote: "宁德时代经过连续调整已经跌出价值", value_text: "", entity: "宁德时代", metric: "market_share", value: 37 }] };
    const r = await runCheck(risky, "none", mockFetch({ extraction: ext }), NOW);
    expect(r.claims[0].metric).toBe("unsupported");
    expect(r.claims[0].status).toBe("unverifiable");
  });
});

describe("合规边界", () => {
  it("LLM 给出原文中不存在的片段时丢弃", async () => {
    const issues = { issues: [{ quote: "保证年化20%", category: "收益承诺", reason: "x", rewrite: "y" }, { quote: "龙头地位无可撼动", category: "夸大或误导", reason: "绝对化", rewrite: "具备一定竞争优势" }] };
    const r = await runCheck(risky, "none", mockFetch({ issues }), NOW);
    const llmFlags = r.compliance.filter((f) => f.detector === "llm");
    expect(llmFlags.map((f) => f.quote)).toEqual(["龙头地位无可撼动"]);
  });

  it("“观点未标注”仅为建议，不阻断发布", async () => {
    const text = "贵州茅台10月22日上涨0.67%，白酒板块表现稳健。";
    const ext = { claims: [{ quote: "贵州茅台10月22日上涨0.67%", value_text: "0.67%", entity: "贵州茅台", metric: "price_change_pct", value: 0.67, as_of_date: "2026-10-22" }] };
    const issues = { issues: [{ quote: "白酒板块表现稳健", category: "观点未标注", reason: "主观判断", rewrite: "我们认为白酒板块表现相对稳健" }] };
    const r = await runCheck(text, "none", mockFetch({ extraction: ext, issues }), NOW);
    expect(r.claims[0].status).toBe("match");
    expect(r.verdict).toBe("pass_pending_signoff");
    expect(r.verdict_reasons.join()).toContain("签字");
  });
});
