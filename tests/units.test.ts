import { describe, expect, it } from "vitest";
import { ruleCheck } from "@/lib/compliance";
import { sanitizeExtraction } from "@/lib/extract";
import { compare, formatSuggestion } from "@/lib/verify";
import { SAMPLES } from "@/lib/samples";
import type { Claim } from "@/lib/types";

const claim = (o: Partial<Claim>): Claim => ({
  id: "c1", quote: "", value_text: "", entity: "", entity_type: "stock", metric: "price_change_pct", value: 0,
  approximate: false, comparator: "eq", as_of_date: null, window_days: null, fiscal_year: null, ...o,
});

describe("数值比对容差", () => {
  it("百分比：精确 ±0.1pp，模糊 ±1pp", () => {
    expect(compare("price_change_pct", 1.48, 1.5, false).match).toBe(true);
    expect(compare("price_change_pct", 1.3, 1.5, false).match).toBe(false);
    expect(compare("window_return_pct", 5.2, 5.16, true).match).toBe(true);
    expect(compare("window_return_pct", 4, 5.16, true).match).toBe(false);
  });
  it("涨跌方向相反直接判不符", () => {
    expect(compare("price_change_pct", 0.5, -1.67, true)).toMatchObject({ match: false, signFlip: true });
  });
  it("金额按相对误差：1%", () => {
    expect(compare("revenue", 1688, 1688.38, false).match).toBe(true);
    expect(compare("revenue", 1600, 1688.38, false).match).toBe(false);
  });
  it("超过 / 低于", () => {
    expect(compare("parent_net_profit_yoy_pct", 40, 42.28, false, "gt").match).toBe(true);
    expect(compare("parent_net_profit_yoy_pct", 45, 42.28, false, "gt").match).toBe(false);
    expect(compare("pe_ttm", 20, 15.2, false, "lt").match).toBe(true);
  });
});

describe("修改建议格式", () => {
  it("保留原文单位和书写方式", () => {
    expect(formatSuggestion(claim({ value_text: "8.5%" }), -12.0352)).toBe("12.04%");
    expect(formatSuggestion(claim({ value_text: "-8.5%" }), -12.0352)).toBe("-12.04%");
    expect(formatSuggestion(claim({ metric: "revenue", value_text: "4000亿元" }), 4237.02)).toBe("4237.0亿元");
    expect(formatSuggestion(claim({ metric: "revenue", value_text: "0.42万亿元" }), 4237.02)).toBe("0.42万亿元");
  });
});

describe("合规规则", () => {
  it("③ 号稿件命中收益承诺、确定性预测、买卖建议、操纵暗示", () => {
    const cats = new Set(ruleCheck(SAMPLES[2].text).map((f) => f.category));
    for (const c of ["收益承诺", "确定性预测", "直接买卖建议", "内幕/操纵暗示"]) expect(cats.has(c as never)).toBe(true);
  });
  it("① 号合规稿件零命中（“不构成投资建议”不误报）", () => {
    expect(ruleCheck(SAMPLES[0].text)).toEqual([]);
  });
});

describe("抽取结果校验", () => {
  it("丢弃原文不存在的引用、非法指标降级为 unsupported、非法日期置空", () => {
    const text = "贵州茅台上涨1%。";
    const r = sanitizeExtraction(text, {
      claims: [
        { quote: "贵州茅台上涨1%", value_text: "1%", metric: "price_change_pct", value: 1, as_of_date: "10月22日" },
        { quote: "贵州茅台上涨1%", value_text: "2%", metric: "price_change_pct", value: 2 },
        { quote: "宁德时代下跌5%", value_text: "5%", metric: "price_change_pct", value: -5 },
        { quote: "贵州茅台上涨1%", value_text: "1%", metric: "made_up" as never, value: 1 },
      ],
    });
    expect(r.dropped).toBe(2);
    expect(r.claims[0].as_of_date).toBeNull();
    expect(r.claims[1].metric).toBe("unsupported");
  });
});

describe("LLM 合规结果过滤", () => {
  it("指向历史数据的“确定性预测”被过滤，指向未来的保留", async () => {
    const { sanitizeIssues } = await import("@/lib/compliance");
    const text = "宁德时代2025年营业收入4237.02亿元，同比增长27%。未来三年业绩翻倍是大概率事件。";
    const r = sanitizeIssues(text, { issues: [
      { quote: "宁德时代2025年营业收入4237.02亿元，同比增长27%", category: "确定性预测" },
      { quote: "未来三年业绩翻倍是大概率事件", category: "确定性预测" },
    ] });
    expect(r.map((f) => f.quote)).toEqual(["未来三年业绩翻倍是大概率事件"]);
  });
});
