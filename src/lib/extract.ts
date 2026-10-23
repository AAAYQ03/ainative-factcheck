import type { Ctx } from "./fuyao";
import { llmJson } from "./llm";
import { METRICS, type Claim, type Metric, type Statement } from "./types";

const metricList = Object.entries(METRICS)
  .map(([k, v]) => `- ${k}: ${v.label}${v.unit ? `（单位 ${v.unit}）` : ""}`)
  .join("\n");

export const EXTRACT_SYSTEM = `你是券商合规部的事实核查助手。任务：从投顾稿件中抽取所有【可用数据核查的数值陈述】，并给每个句子标注性质。
你不判断观点对错，不补充任何稿件里没有的信息。

可选指标（metric 只能取以下值；无法对应的数值陈述用 unsupported）：
${metricList}

规则：
1. quote 必须是稿件中逐字出现的完整句子或分句；value_text 必须是 quote 中逐字出现的数字片段（含单位/百分号）。
2. value 换算到该指标的单位：例如 "1688亿元" → 1688，"下跌2.1%" → -2.1，"涨了百分之三" → 3。下跌必须为负数。
3. entity 写稿件中的标的名称或代码；entity_type：个股为 stock，指数/板块为 index（如上证指数、沪深300、创业板指）。
4. as_of_date：陈述对应的交易日 YYYY-MM-DD（年份缺省按 2026）。原文直接写了日期就用该日期；写"当日/同日/今日/盘后"等且标题或上文给出过日期时，继承上文最近出现的那个日期；全文都没有日期才填 null。
5. window_days：区间涨跌幅的自然日天数（近一周=7，近一月=30，近三月=90，今年以来=从1月1日起算的天数）。
6. fiscal_year：财务指标对应年份，如 "2025年营收" → 2025。
7. approximate：原文用了 约/近/左右/接近 等模糊词时为 true。comparator：原文为"超过/逾/至少/以上"时为 gt，"不足/低于/不到/以内"时为 lt，否则为 eq。
8. 一个句子包含多个数字时拆成多条 claim。
9. statements：把稿件按句切分，每句标注 kind：fact（陈述可核查的客观数据/事件）、inference（基于数据的推断）、opinion（主观观点/判断）。

只输出 JSON：{"claims":[{"quote":"","value_text":"","entity":"","entity_type":"stock","metric":"","value":0,"approximate":false,"comparator":"eq","as_of_date":null,"window_days":null,"fiscal_year":null}],"statements":[{"quote":"","kind":"fact"}]}`;

type RawExtract = { claims?: Partial<Claim>[]; statements?: Statement[] };

// 校验 LLM 输出：原文中不存在的引用直接丢弃，防止模型编造陈述
export function sanitizeExtraction(text: string, raw: RawExtract): { claims: Claim[]; statements: Statement[]; dropped: number } {
  let dropped = 0;
  const claims: Claim[] = [];
  for (const c of raw.claims ?? []) {
    const quote = String(c.quote ?? "").trim();
    const valueText = String(c.value_text ?? "").trim();
    if (!quote || !text.includes(quote) || (valueText && !quote.includes(valueText))) {
      dropped++;
      continue;
    }
    const metric = (c.metric && c.metric in METRICS ? c.metric : "unsupported") as Metric;
    const value = typeof c.value === "number" && Number.isFinite(c.value) ? c.value : null;
    claims.push({
      id: `c${claims.length + 1}`,
      quote,
      value_text: valueText,
      entity: String(c.entity ?? "").trim(),
      entity_type: c.entity_type === "index" ? "index" : "stock",
      metric,
      value,
      approximate: Boolean(c.approximate),
      comparator: c.comparator === "gt" || c.comparator === "lt" ? c.comparator : "eq",
      as_of_date: typeof c.as_of_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.as_of_date) ? c.as_of_date : null,
      window_days: typeof c.window_days === "number" && c.window_days > 0 ? Math.round(c.window_days) : null,
      fiscal_year: typeof c.fiscal_year === "number" ? c.fiscal_year : null,
    });
  }
  const statements = (raw.statements ?? []).filter(
    (s) => s && typeof s.quote === "string" && text.includes(s.quote) && ["fact", "inference", "opinion"].includes(s.kind),
  );
  return { claims, statements, dropped };
}

export async function extractClaims(ctx: Ctx, text: string) {
  const r = await llmJson<RawExtract>(ctx, "抽取数值陈述", EXTRACT_SYSTEM, `稿件：\n${text}`);
  if (!r.ok) return { ok: false as const, error: r.error };
  const s = sanitizeExtraction(text, r.data);
  if (s.dropped) ctx.trace.push({ step: "校验抽取结果", tool: "规则", ok: true, ms: 0, note: `丢弃 ${s.dropped} 条原文中找不到的引用` });
  return { ok: true as const, ...s };
}
