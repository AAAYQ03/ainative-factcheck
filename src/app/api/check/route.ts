import { runCheck } from "@/lib/pipeline";
import type { Simulate } from "@/lib/types";

export const maxDuration = 60;

const SIMULATE: Simulate[] = ["none", "fuyao_down", "llm_down", "stale"];

export async function POST(request: Request) {
  let body: { text?: unknown; simulate?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "稿件内容为空" }, { status: 400 });
  if (text.length > 4000) return Response.json({ error: "稿件超过 4000 字，请分段核查" }, { status: 400 });
  const simulate = SIMULATE.includes(body.simulate as Simulate) ? (body.simulate as Simulate) : "none";

  try {
    return Response.json(await runCheck(text, simulate));
  } catch (e) {
    return Response.json({ error: `核查流程异常：${String(e)}` }, { status: 500 });
  }
}
