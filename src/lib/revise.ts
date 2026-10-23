import { METRICS, type CheckResponse } from "./types";

export type Decision = "pending" | "accepted" | "rejected";
export type Decisions = Record<string, Decision>;

// 只应用用户明确采纳的修改；未采纳的保持原文
export function applyRevisions(text: string, r: CheckResponse, d: Decisions): string {
  let out = text;
  for (const c of r.claims) {
    if (d[c.id] === "accepted" && c.suggested_text && out.includes(c.quote)) {
      out = out.replace(c.quote, c.quote.replace(c.value_text, c.suggested_text));
    }
  }
  for (const f of r.compliance) {
    if (d[f.id] === "accepted" && f.suggestion && out.includes(f.quote)) {
      out = out.replace(f.quote, f.suggestion);
    }
  }
  return out;
}

const STATUS_TEXT = { match: "✅ 一致", mismatch: "❌ 不符", unverifiable: "⚠️ 无法核实" } as const;
const DECISION_TEXT = { pending: "待处理", accepted: "已采纳", rejected: "已驳回" } as const;
const VERDICT_TEXT = {
  pass_pending_signoff: "核查项均一致，待合规负责人签字",
  needs_review: "需人工复核",
  needs_revision: "需修改后再发布",
  incomplete: "核查未完成",
} as const;

export const verdictText = (v: CheckResponse["verdict"]) => VERDICT_TEXT[v];

export function buildReport(text: string, r: CheckResponse, d: Decisions): string {
  const lines: string[] = [
    `# 投顾稿件核查报告`,
    ``,
    `- 核查时间：${r.checked_at}`,
    `- 结论：${VERDICT_TEXT[r.verdict]}（${r.verdict_reasons.join("；")}）`,
    `- 说明：本报告仅核对稿件中的数据与表述合规性，不构成投资建议。`,
    ``,
    `## 数据核查`,
    ``,
    `| # | 原文 | 指标 | 稿件值 | 数据源值 | 结果 | 来源 / 时点 / 口径 | 处理 |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  for (const c of r.claims) {
    const e = c.evidence;
    const src = e ? `${e.resolved} ${e.source}#${e.field} @${e.as_of}；${e.method}` : c.reason;
    lines.push(
      `| ${c.id} | ${c.quote} | ${METRICS[c.metric].label} | ${c.value ?? "-"} | ${c.actual ?? "-"} | ${STATUS_TEXT[c.status]} | ${src} | ${DECISION_TEXT[d[c.id] ?? "pending"]} |`,
    );
  }
  lines.push(``, `## 合规审查`, ``, `| # | 原文片段 | 类别 | 检出方式 | 建议 | 处理 |`, `|---|---|---|---|---|---|`);
  for (const f of r.compliance) {
    lines.push(`| ${f.id} | ${f.quote} | ${f.category} | ${f.detector === "rule" ? "规则" : "LLM"} | ${f.suggestion} | ${DECISION_TEXT[d[f.id] ?? "pending"]} |`);
  }
  lines.push(``, `## 修订稿`, ``, applyRevisions(text, r, d), ``, `## 原稿`, ``, text);
  return lines.join("\n");
}
