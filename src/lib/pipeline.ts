import { complianceCheck } from "./compliance";
import { extractClaims } from "./extract";
import { verifyClaim, type VerifyCtx } from "./verify";
import type { CheckResponse, Simulate, Verdict } from "./types";

export async function runCheck(text: string, simulate: Simulate = "none", fetchImpl?: typeof fetch, now = Date.now()): Promise<CheckResponse> {
  const ctx: VerifyCtx = { trace: [], simulate, fetchImpl, now, cache: new Map() };

  // 抽取与合规审查互不依赖，并行执行
  const [ext, comp] = await Promise.all([extractClaims(ctx, text), complianceCheck(ctx, text)]);

  const claims = ext.ok ? await Promise.all(ext.claims.map((c) => verifyClaim(ctx, c))) : [];
  const reasons: string[] = [];
  let verdict: Verdict;

  const mismatch = claims.filter((c) => c.status === "mismatch").length;
  const unverifiable = claims.filter((c) => c.status === "unverifiable").length;
  const high = comp.flags.filter((f) => f.severity === "high").length;
  const low = comp.flags.length - high;

  if (!ext.ok) {
    verdict = "incomplete";
    reasons.push(`数值陈述抽取失败（${ext.error}），本次未做数据核查，仅执行了规则合规扫描`);
  } else if (mismatch || high) {
    verdict = "needs_revision";
  } else if (unverifiable || !comp.llmOk) {
    verdict = "needs_review";
  } else {
    verdict = "pass_pending_signoff";
  }
  if (mismatch) reasons.push(`${mismatch} 处数据与数据源不符`);
  if (high) reasons.push(`${high} 处合规风险表述`);
  if (low) reasons.push(`${low} 处表述改进建议（不阻断）`);
  if (unverifiable) reasons.push(`${unverifiable} 处无法自动核实，需人工核对`);
  if (!comp.llmOk) reasons.push("合规语义审查不可用，仅执行了关键词规则");
  if (ext.ok && claims.length === 0) reasons.push("未识别到可核查的数值陈述");
  if (verdict === "pass_pending_signoff") reasons.push("自动核查项全部一致；发布前仍需合规负责人签字");

  return {
    verdict,
    verdict_reasons: reasons,
    claims,
    compliance: comp.flags,
    statements: ext.ok ? ext.statements : [],
    trace: ctx.trace,
    llm_available: ext.ok && comp.llmOk,
    checked_at: new Date(now).toISOString(),
  };
}
