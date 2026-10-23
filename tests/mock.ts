import { cnDateToMs } from "@/lib/fuyao";

// 录制自扶摇真实返回（2026-10-22），用于离线复现
const BARS: Record<string, [string, number][]> = {
  "600519.SH": [["2026-09-22", 1253.8], ["2026-10-16", 1329.0], ["2026-10-19", 1324.97], ["2026-10-20", 1331.88], ["2026-10-21", 1309.69], ["2026-10-22", 1318.49]],
  "300750.SZ": [["2026-10-16", 277.0], ["2026-10-19", 267.02], ["2026-10-20", 259.08], ["2026-10-21", 227.9], ["2026-10-22", 220.41]],
  "000001.SH": [["2026-10-20", 3735.37], ["2026-10-21", 3713.03], ["2026-10-22", 3658.03]],
};
const TICKERS: Record<string, { thscode: string; name: string }> = {
  贵州茅台: { thscode: "600519.SH", name: "贵州茅台" },
  宁德时代: { thscode: "300750.SZ", name: "宁德时代" },
  上证指数: { thscode: "000001.SH", name: "上证指数" },
};
const INCOME: Record<string, { fiscal_year: number; operating_income: number; net_profit: number; parent_holder_net_profit: number; report_date_ms: number }[]> = {
  "300750.SZ": [
    { fiscal_year: 2025, operating_income: 423702000000, net_profit: 760000000000 / 10, parent_holder_net_profit: 72201000000, report_date_ms: cnDateToMs("2026-03-10") },
    { fiscal_year: 2024, operating_income: 362013000000, net_profit: 54000000000, parent_holder_net_profit: 50745000000, report_date_ms: cnDateToMs("2025-03-14") },
  ],
};
export const NOW = cnDateToMs("2026-10-22") + 16 * 3600_000; // 10-22 16:00 收盘后

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "success", data, request_id: "mock-req" }));
const llm = (obj: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { total_tokens: 1 } }));

export type MockOpts = { extraction?: unknown; issues?: unknown; llmBroken?: boolean };

export function mockFetch(opts: MockOpts): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.deepseek.com") {
      if (opts.llmBroken) return new Response(JSON.stringify({ choices: [{ message: { content: "{not json" } }] }));
      const body = JSON.parse(String(init?.body));
      const isExtract = body.messages[0].content.includes("事实核查助手");
      return llm(isExtract ? opts.extraction ?? { claims: [], statements: [] } : opts.issues ?? { issues: [] });
    }
    const p = url.searchParams;
    switch (url.pathname) {
      case "/api/meta/tickers/search": {
        const t = TICKERS[p.get("q")!];
        return ok({ timestamp: NOW, item: t ? [t] : [] });
      }
      case "/api/a-share/prices/snapshot":
      case "/api/a-share-index/prices/snapshot": {
        const code = p.get("thscodes")!;
        const b = BARS[code];
        const last = b[b.length - 1][1], prev = b[b.length - 2][1];
        return ok({ timestamp: NOW - 3600_000, total: 1, item: [{ thscode: code, last_price: last, prev_price: prev, price_change_ratio_pct: (last / prev - 1) * 100 }] });
      }
      case "/api/a-share/prices/historical":
      case "/api/a-share-index/prices/historical": {
        const s = Number(p.get("start")), e = Number(p.get("end"));
        const item = (BARS[p.get("thscode")!] ?? []).map(([d, c]) => ({ date_ms: cnDateToMs(d), close_price: c })).filter((x) => x.date_ms >= s && x.date_ms <= e);
        return ok({ timestamp: NOW, item });
      }
      case "/api/a-share/valuations/snapshot":
        return ok({ timestamp: NOW - 3600_000, total: 1, item: [{ thscode: p.get("thscodes"), pe_ttm: 15.2, pe_mrq: 14.1, pb_mrq: 3.3, ps_ttm: 2.1 }] });
      case "/api/a-share/financials/income-statements":
        return ok({ timestamp: NOW, item: INCOME[p.get("thscode")!] ?? [] });
    }
    return new Response(JSON.stringify({ code: 3001, message: "Target not found", data: null }));
  }) as typeof fetch;
}
