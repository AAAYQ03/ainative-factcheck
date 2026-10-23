"use client";

import { useEffect, useMemo, useState } from "react";
import { SAMPLES } from "@/lib/samples";
import { applyRevisions, buildReport, verdictText, type Decision, type Decisions } from "@/lib/revise";
import { METRICS, type CheckResponse, type ClaimResult, type ComplianceFlag, type Simulate } from "@/lib/types";

const VERDICT_STYLE: Record<CheckResponse["verdict"], string> = {
  pass_pending_signoff: "bg-emerald-50 border-emerald-300 text-emerald-900",
  needs_review: "bg-amber-50 border-amber-300 text-amber-900",
  needs_revision: "bg-red-50 border-red-300 text-red-900",
  incomplete: "bg-zinc-100 border-zinc-400 text-zinc-900",
};
const STATUS_BADGE = {
  match: { text: "✅ 一致", cls: "bg-emerald-100 text-emerald-800" },
  mismatch: { text: "❌ 不符", cls: "bg-red-100 text-red-800" },
  unverifiable: { text: "⚠️ 无法核实", cls: "bg-amber-100 text-amber-800" },
};
const MARK = { match: "bg-emerald-100", mismatch: "bg-red-200", unverifiable: "bg-amber-200", flag: "bg-violet-200" };
const KIND_TEXT = { fact: "事实", inference: "推断", opinion: "观点" };

type Stats = { checks: number; accepted: { rule: number; llm: number; claim: number }; rejected: { rule: number; llm: number; claim: number } };
const EMPTY_STATS: Stats = { checks: 0, accepted: { rule: 0, llm: 0, claim: 0 }, rejected: { rule: 0, llm: 0, claim: 0 } };

function loadStats(): Stats {
  try {
    return JSON.parse(localStorage.getItem("fc-stats") ?? "") as Stats;
  } catch {
    return EMPTY_STATS;
  }
}

export default function Home() {
  const [text, setText] = useState(SAMPLES[1].text);
  const [simulate, setSimulate] = useState<Simulate>("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [checkedText, setCheckedText] = useState("");
  const [decisions, setDecisions] = useState<Decisions>({});
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [copied, setCopied] = useState(false);
  const [draftEdit, setDraftEdit] = useState<string | null>(null);

  // localStorage 只能在挂载后读取，否则与服务端渲染结果不一致
  useEffect(() => setStats(loadStats()), []);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    setDecisions({});
    setDraftEdit(null);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, simulate }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body);
      setCheckedText(text);
      const s = { ...loadStats(), checks: loadStats().checks + 1 };
      try { localStorage.setItem("fc-stats", JSON.stringify(s)); } catch {}
      setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function decide(id: string, d: Decision, source: "rule" | "llm" | "claim") {
    const prev = decisions[id] ?? "pending";
    if (prev === d) return;
    setDecisions({ ...decisions, [id]: d });
    setDraftEdit(null);
    const s: Stats = JSON.parse(JSON.stringify(loadStats() ?? EMPTY_STATS));
    if (prev !== "pending") s[prev][source] = Math.max(0, s[prev][source] - 1);
    if (d !== "pending") s[d][source] += 1;
    try { localStorage.setItem("fc-stats", JSON.stringify(s)); } catch {}
    setStats(s);
  }

  const revised = useMemo(() => (result ? applyRevisions(checkedText, result, decisions) : ""), [result, checkedText, decisions]);
  const actionable = result ? [...result.claims.filter((c) => c.status !== "match"), ...result.compliance] : [];
  const finalDraft = draftEdit ?? revised;
  const ruleFlags = result ? result.compliance.filter((f) => f.detector === "rule").length : 0;
  const pending = actionable.filter((x) => (decisions[x.id] ?? "pending") === "pending").length;

  function downloadReport() {
    if (!result) return;
    const md = buildReport(checkedText, result, decisions, finalDraft);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `核查报告-${result.checked_at.slice(0, 19).replace(/[:T]/g, "")}.md`;
    a.click();
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">投顾稿件核查台</h1>
        <p className="mt-1 text-sm text-zinc-600">
          发布前自动核对稿件中的行情、估值、财务数字，并检查收益承诺、确定性预测、买卖建议等合规风险。每条结论都附数据源字段、时点与口径；数据缺失或接口失败时明确标为“无法核实”，不会给出“正常”结论。
        </p>
        <p className="mt-1 text-xs text-zinc-500">本工具只核查稿件，不提供任何投资建议；最终发布须经合规负责人签字。</p>
      </header>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm text-zinc-500">示例稿件：</span>
          {SAMPLES.map((s) => (
            <button key={s.id} onClick={() => setText(s.text)} className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100" title={`预期：${s.expect}`}>
              {s.title}
            </button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          maxLength={4000}
          className="w-full rounded border border-zinc-300 p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400"
          placeholder="粘贴待发布的投顾稿件（盘后点评、个股解读等），最多 4000 字"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={loading || !text.trim()} className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {loading ? "核查中…（约 10–30 秒）" : "开始核查"}
          </button>
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            故障演练：
            <select value={simulate} onChange={(e) => setSimulate(e.target.value as Simulate)} className="rounded border border-zinc-300 px-1 py-0.5">
              <option value="none">无（真实调用）</option>
              <option value="fuyao_down">数据接口不可用</option>
              <option value="llm_down">LLM 不可用</option>
              <option value="stale">数据过期</option>
            </select>
          </label>
          <span className="text-xs text-zinc-400">字数 {text.length}/4000</span>
        </div>
        {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">请求失败：{error}</p>}
      </section>

      {result && (
        <>
          <section className={`mt-6 rounded-lg border p-4 ${VERDICT_STYLE[result.verdict]}`}>
            <div className="text-lg font-semibold">{verdictText(result.verdict)}</div>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {result.verdict_reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </section>

          <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 font-medium">标注稿件</h2>
            <Annotated text={checkedText} claims={result.claims} flags={result.compliance} />
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500">
              <span><i className={`px-1 ${MARK.match}`}>一致</i></span>
              <span><i className={`px-1 ${MARK.mismatch}`}>不符</i></span>
              <span><i className={`px-1 ${MARK.unverifiable}`}>无法核实</i></span>
              <span><i className={`px-1 ${MARK.flag}`}>合规风险</i></span>
            </div>
            {result.statements.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-zinc-600">事实 / 推断 / 观点 分句标注（{result.statements.length} 句）</summary>
                <ul className="mt-2 space-y-1">
                  {result.statements.map((s, i) => (
                    <li key={i}><span className={`mr-2 rounded px-1.5 text-xs ${s.kind === "fact" ? "bg-sky-100" : s.kind === "inference" ? "bg-orange-100" : "bg-pink-100"}`}>{KIND_TEXT[s.kind]}</span>{s.quote}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="mt-6">
            <h2 className="mb-2 font-medium">数据核查（{result.claims.length} 条）</h2>
            {result.claims.length === 0 && <p className="text-sm text-zinc-500">没有可核查的数值陈述。</p>}
            <div className="space-y-3">
              {result.claims.map((c) => <ClaimCard key={c.id} c={c} decision={decisions[c.id] ?? "pending"} onDecide={(d) => decide(c.id, d, "claim")} />)}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="mb-2 font-medium">合规审查（{result.compliance.length} 条）</h2>
            {result.compliance.length === 0 && <p className="text-sm text-zinc-500">未发现合规风险表述{result.llm_available ? "" : "（仅规则扫描，LLM 语义审查不可用）"}。</p>}
            <div className="space-y-3">
              {result.compliance.map((f) => <FlagCard key={f.id} f={f} decision={decisions[f.id] ?? "pending"} onDecide={(d) => decide(f.id, d, f.detector)} />)}
            </div>
          </section>

          <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">修订稿 <span className="text-xs font-normal text-zinc-500">（采纳的修改自动应用，也可直接编辑；待处理 {pending} 条）</span></h2>
              <div className="flex gap-2">
                <button onClick={() => { navigator.clipboard.writeText(finalDraft); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="rounded border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100">{copied ? "已复制" : "复制修订稿"}</button>
                <button onClick={downloadReport} className="rounded bg-zinc-900 px-3 py-1 text-xs text-white">下载核查报告 (.md)</button>
              </div>
            </div>
            {ruleFlags > 0 && <p className="mt-2 text-xs text-violet-700">有 {ruleFlags} 处规则命中只提供改写指引，请直接在下方修订稿中手动改写。</p>}
            <textarea value={finalDraft} onChange={(e) => setDraftEdit(e.target.value)} rows={6} className="mt-2 w-full rounded border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400" />
            {draftEdit !== null && <p className="mt-1 text-xs text-zinc-500">已手动编辑；再次采纳或驳回会以自动修订结果覆盖手动修改。</p>}
          </section>

          <details className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 text-sm">
            <summary className="cursor-pointer font-medium">Agent 执行轨迹（{result.trace.length} 步，{result.trace.filter((t) => !t.ok).length} 步失败）</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-zinc-500"><tr><th className="py-1 pr-2">步骤</th><th className="pr-2">工具</th><th className="pr-2">参数</th><th className="pr-2">耗时</th><th>结果</th></tr></thead>
                <tbody>
                  {result.trace.map((t, i) => (
                    <tr key={i} className="border-t border-zinc-100 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">{t.step}</td>
                      <td className="pr-2 whitespace-nowrap">{t.tool}</td>
                      <td className="pr-2 break-all text-zinc-500">{t.args ?? ""}</td>
                      <td className="pr-2 whitespace-nowrap">{t.ms}ms</td>
                      <td className={t.ok ? "text-emerald-700" : "text-red-700"}>{t.ok ? "成功" : "失败"} {t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
        <div>本机反馈统计（用于评估误报率）：累计核查 {stats.checks} 次 ｜ 数据修正 采纳 {stats.accepted.claim} / 驳回 {stats.rejected.claim} ｜ 规则检出 采纳 {stats.accepted.rule} / 驳回 {stats.rejected.rule} ｜ LLM 检出 采纳 {stats.accepted.llm} / 驳回 {stats.rejected.llm}</div>
        <div className="mt-1">数据来源：同花顺扶摇金融数据 API（行情快照、日K、估值、年报利润表）。示例稿件为构造数据。</div>
      </footer>
    </main>
  );
}

function DecisionButtons({ decision, onDecide, canAccept = true }: { decision: Decision; onDecide: (d: Decision) => void; canAccept?: boolean }) {
  const base = "rounded px-2 py-0.5 text-xs border";
  return (
    <div className="flex gap-1">
      {canAccept && <button onClick={() => onDecide("accepted")} className={`${base} ${decision === "accepted" ? "bg-emerald-600 text-white border-emerald-600" : "border-zinc-300 hover:bg-zinc-100"}`}>采纳</button>}
      <button onClick={() => onDecide("rejected")} className={`${base} ${decision === "rejected" ? "bg-zinc-700 text-white border-zinc-700" : "border-zinc-300 hover:bg-zinc-100"}`}>{canAccept ? "驳回" : "已人工核对"}</button>
      {decision !== "pending" && <button onClick={() => onDecide("pending")} className={`${base} border-transparent text-zinc-400`}>撤销</button>}
    </div>
  );
}

function ClaimCard({ c, decision, onDecide }: { c: ClaimResult; decision: Decision; onDecide: (d: Decision) => void }) {
  const unit = METRICS[c.metric].unit;
  const badge = STATUS_BADGE[c.status];
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
          <span className="text-xs text-zinc-500">{c.id} · {METRICS[c.metric].label}{c.as_of_date ? ` · ${c.as_of_date}` : ""}{c.window_days ? ` · ${c.window_days}日` : ""}{c.fiscal_year ? ` · FY${c.fiscal_year}` : ""}</span>
        </div>
        {c.status !== "match" && <DecisionButtons decision={decision} onDecide={onDecide} canAccept={!!c.suggested_text} />}
      </div>
      <p className="mt-2">“{c.quote}”</p>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <div>稿件值：<b>{c.value ?? "—"}{c.value != null ? unit : ""}</b>{c.approximate ? "（约）" : ""}{c.comparator === "gt" ? "（超过）" : c.comparator === "lt" ? "（低于）" : ""}</div>
        <div>数据源值：<b>{c.actual ?? "—"}{c.actual != null ? unit : ""}</b></div>
      </div>
      <p className="mt-1 text-xs text-zinc-700">{c.reason}</p>
      {c.suggested_text && <p className="mt-1 text-xs">建议改为：<code className="rounded bg-emerald-50 px-1">{c.value_text}</code> → <code className="rounded bg-emerald-100 px-1">{c.suggested_text}</code></p>}
      {c.evidence && (
        <div className="mt-2 rounded bg-zinc-50 p-2 text-xs text-zinc-600">
          <div>标的：{c.evidence.resolved} ｜ 时点：{c.evidence.as_of} ｜ 单位：{c.evidence.unit}</div>
          <div>来源：<code>{c.evidence.source}</code> 字段 <code>{c.evidence.field}</code> 原值 <code>{c.evidence.raw_value}</code>{c.evidence.request_id ? <> ｜ request_id <code>{c.evidence.request_id}</code></> : null}</div>
          <div>口径：{c.evidence.method}</div>
        </div>
      )}
    </div>
  );
}

function FlagCard({ f, decision, onDecide }: { f: ComplianceFlag; decision: Decision; onDecide: (d: Decision) => void }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs ${f.severity === "high" ? "bg-violet-100 text-violet-800" : "bg-zinc-100 text-zinc-700"}`}>{f.category}{f.severity === "low" ? "（建议）" : ""}</span>
          <span className="text-xs text-zinc-500">{f.id} · {f.detector === "rule" ? "规则检出" : "LLM 语义检出"}</span>
        </div>
        <DecisionButtons decision={decision} onDecide={onDecide} canAccept={f.detector === "llm" && !!f.suggestion} />
      </div>
      <p className="mt-2">“<mark className="bg-violet-100">{f.quote}</mark>”</p>
      {f.reason && <p className="mt-1 text-xs text-zinc-700">{f.reason}</p>}
      {f.suggestion && <p className="mt-1 text-xs">{f.detector === "rule" ? "改写指引（需在修订稿中手动改写）：" : "建议改写为："}{f.suggestion}</p>}
    </div>
  );
}

function Annotated({ text, claims, flags }: { text: string; claims: ClaimResult[]; flags: ComplianceFlag[] }) {
  // 计算高亮区间；重叠时先到先得
  const ranges: { start: number; end: number; cls: string; title: string }[] = [];
  const add = (needle: string, cls: string, title: string, within?: string) => {
    const base = within ? text.indexOf(within) : 0;
    if (base < 0) return;
    const scope = within ?? text;
    const i = scope.indexOf(needle);
    if (i < 0 || !needle) return;
    const start = base + i, end = start + needle.length;
    if (ranges.some((r) => start < r.end && end > r.start)) return;
    ranges.push({ start, end, cls, title });
  };
  for (const f of flags) add(f.quote, MARK.flag, `${f.category}：${f.reason}`);
  for (const c of claims) add(c.value_text || c.quote, MARK[c.status], c.reason, c.quote);
  ranges.sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start > pos) parts.push(text.slice(pos, r.start));
    parts.push(<mark key={i} className={`${r.cls} rounded px-0.5`} title={r.title}>{text.slice(r.start, r.end)}</mark>);
    pos = r.end;
  });
  parts.push(text.slice(pos));
  return <p className="whitespace-pre-wrap text-sm leading-7">{parts}</p>;
}
