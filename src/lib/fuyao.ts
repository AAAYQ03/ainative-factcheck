import type { Simulate, TraceStep } from "./types";

const BASE = process.env.FUYAO_BASE_URL ?? "https://fuyao.aicubes.cn";

export type FuyaoOk<T> = { ok: true; data: T; requestId: string; endpoint: string };
export type FuyaoErr = { ok: false; error: string; code?: number; endpoint: string };
export type FuyaoResult<T> = FuyaoOk<T> | FuyaoErr;

export type Ctx = { trace: TraceStep[]; simulate: Simulate; fetchImpl?: typeof fetch };

const ERROR_TEXT: Record<number, string> = {
  1001: "缺少必需参数",
  1003: "参数非法",
  2001: "缺少或无效 API Key",
  2003: "API Key 无效或已吊销",
  3001: "标的不存在",
  4001: "触发限流",
};

export async function fuyao<T>(
  ctx: Ctx,
  endpoint: string,
  params: Record<string, string | number>,
  step: string,
): Promise<FuyaoResult<T>> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const args = qs.toString();
  const t0 = Date.now();
  const done = (ok: boolean, note?: string) =>
    ctx.trace.push({ step, tool: `扶摇 ${endpoint}`, args: decodeURIComponent(args), ok, ms: Date.now() - t0, note });

  if (ctx.simulate === "fuyao_down") {
    done(false, "模拟故障：数据接口不可用");
    return { ok: false, error: "模拟故障：扶摇接口不可用", endpoint };
  }
  const key = process.env.FUYAO_API_KEY;
  if (!key) {
    done(false, "未配置 FUYAO_API_KEY");
    return { ok: false, error: "服务端未配置 FUYAO_API_KEY", endpoint };
  }
  const fetcher = ctx.fetchImpl ?? (process.env.FUYAO_LOCAL_DNS === "1" ? await localDnsFetch() : (u: string, i?: RequestInit) => fetch(u, i));
  const call = () =>
    fetcher(`${BASE}${endpoint}?${args}`, {
      headers: { "X-api-key": key },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  try {
    // 网络层错误（DNS/连接重置）重试一次；业务错误码不重试
    const res = await call().catch(async (e) => {
      if (e instanceof Error && e.name === "TimeoutError") throw e;
      await new Promise((r) => setTimeout(r, 400));
      return call();
    });
    if (res.status === 429) {
      done(false, "HTTP 429 限流");
      return { ok: false, error: "数据接口限流（429）", code: 4001, endpoint };
    }
    const body = (await res.json()) as { code: number; message: string; data: T; request_id: string };
    if (body.code !== 0 || body.data == null) {
      const msg = ERROR_TEXT[body.code] ?? body.message ?? `HTTP ${res.status}`;
      done(false, `code=${body.code} ${msg}`);
      return { ok: false, error: msg, code: body.code, endpoint };
    }
    done(true, `request_id=${body.request_id}`);
    return { ok: true, data: body.data, requestId: body.request_id, endpoint };
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "请求超时(10s)" : `网络错误: ${String(e)}`;
    done(false, msg);
    return { ok: false, error: msg, endpoint };
  }
}

// 仅本地开发：部分 macOS 网络环境下 getaddrinfo 解析不了扶摇域名，改用 c-ares（dns.resolve4）
let localFetch: typeof fetch | undefined;
async function localDnsFetch(): Promise<typeof fetch> {
  if (localFetch) return localFetch;
  const [{ Agent, fetch: undiciFetch }, dns] = await Promise.all([import("undici"), import("node:dns")]);
  const dispatcher = new Agent({
    connect: {
      lookup: (host, opts, cb) =>
        dns.resolve4(host, (err, ips) => {
          if (err) return cb(err, "", 4);
          if (opts?.all) return (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, ips.map((address) => ({ address, family: 4 })));
          cb(null, ips[0], 4);
        }),
    },
  });
  localFetch = ((url: string, init?: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher })) as unknown as typeof fetch;
  return localFetch;
}

// 北京时间格式化
export function fmtCN(ms: number, withTime = true): string {
  const d = new Date(ms + 8 * 3600_000);
  const s = d.toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s.slice(0, 10);
}

// YYYY-MM-DD 视为北京时间零点
export function cnDateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}
