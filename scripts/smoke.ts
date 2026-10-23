import { runCheck } from "../src/lib/pipeline";
import { SAMPLES } from "../src/lib/samples";
const id = process.argv[2] ?? "clean";
const sim = (process.argv[3] ?? "none") as never;
const s = SAMPLES.find((x) => x.id === id)!;
runCheck(s.text, sim).then((r) => {
  console.log("VERDICT", r.verdict, r.verdict_reasons);
  for (const c of r.claims) console.log(c.status.padEnd(12), c.metric.padEnd(22), c.value, "->", c.actual, "|", c.reason, c.suggested_text ? `=> ${c.suggested_text}` : "", "|", c.evidence?.method ?? "");
  for (const f of r.compliance) console.log("FLAG", f.detector, f.category, "|", f.quote, "=>", f.suggestion);
  for (const t of r.trace) console.log("  trace", t.ok ? "ok " : "ERR", t.ms + "ms", t.tool, t.note ?? "");
});
