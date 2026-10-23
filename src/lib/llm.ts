import type { Ctx } from "./fuyao";

const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";

export type LlmResult<T> = { ok: true; data: T } | { ok: false; error: string };

// 调用 DeepSeek 并要求返回 JSON。模型偶尔会给出非法 JSON，这里显式失败而不是猜测。
export async function llmJson<T>(ctx: Ctx, step: string, system: string, user: string): Promise<LlmResult<T>> {
  const t0 = Date.now();
  const done = (ok: boolean, note?: string) =>
    ctx.trace.push({ step, tool: `LLM ${MODEL}`, ok, ms: Date.now() - t0, note });

  if (ctx.simulate === "llm_down") {
    done(false, "模拟故障：LLM 不可用");
    return { ok: false, error: "模拟故障：LLM 不可用" };
  }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    done(false, "未配置 DEEPSEEK_API_KEY");
    return { ok: false, error: "服务端未配置 DEEPSEEK_API_KEY" };
  }
  try {
    const res = await (ctx.fetchImpl ?? fetch)(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      done(false, `HTTP ${res.status}`);
      return { ok: false, error: `LLM HTTP ${res.status}` };
    }
    const body = await res.json();
    const content: string = body.choices?.[0]?.message?.content ?? "";
    try {
      const data = JSON.parse(content) as T;
      done(true, `tokens=${body.usage?.total_tokens ?? "?"}`);
      return { ok: true, data };
    } catch {
      done(false, "返回内容不是合法 JSON");
      return { ok: false, error: "LLM 返回内容不是合法 JSON" };
    }
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "LLM 超时(60s)" : `LLM 网络错误: ${String(e)}`;
    done(false, msg);
    return { ok: false, error: msg };
  }
}
