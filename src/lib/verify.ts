import { cnDateToMs, fmtCN, fuyao, type Ctx } from "./fuyao";
import { METRICS, type Claim, type ClaimResult, type Evidence, type Metric } from "./types";

type Ticker = { thscode: string; name: string };
type Snapshot = { thscode: string; last_price: number; price_change_ratio_pct: number; prev_price: number };
type Bar = { date_ms: number; close_price: number };
type Valuation = { thscode: string; pe_ttm: number | null; pe_mrq: number | null; pb_mrq: number | null; ps_ttm: number | null };
type Income = { fiscal_year: number; operating_income: number; net_profit: number; parent_holder_net_profit: number; report_date_ms: number };

export const STALE_MS = 4 * 24 * 3600_000;
const DAY = 24 * 3600_000;

export type VerifyCtx = Ctx & { now: number; cache: Map<string, Promise<unknown>> };

function memo<T>(ctx: VerifyCtx, key: string, fn: () => Promise<T>): Promise<T> {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key) as Promise<T>;
}

class Unverifiable extends Error {}
const fail = (msg: string): never => {
  throw new Unverifiable(msg);
};

async function resolve(ctx: VerifyCtx, entity: string, type: "stock" | "index"): Promise<Ticker> {
  if (!entity) fail("稿件未指明标的");
  const asset = type === "index" ? "a-share-index" : "a-share";
  const r = await memo(ctx, `t:${asset}:${entity}`, () =>
    fuyao<{ item: Ticker[] }>(ctx, "/api/meta/tickers/search", { q: entity, asset_type: asset, limit: 5 }, `解析标的「${entity}」`),
  );
  if (!r.ok) fail(`标的解析失败：${r.error}`);
  const items = r.ok ? r.data.item : [];
  if (!items.length) fail(`数据源中找不到标的「${entity}」`);
  return items.find((i) => i.name === entity || i.thscode === entity || i.thscode.startsWith(entity)) ?? items[0];
}

async function snapshot(ctx: VerifyCtx, t: Ticker, type: "stock" | "index") {
  const ep = type === "index" ? "/api/a-share-index/prices/snapshot" : "/api/a-share/prices/snapshot";
  const r = await memo(ctx, `s:${t.thscode}`, () =>
    fuyao<{ timestamp: number | null; item: Snapshot[] }>(ctx, ep, { thscodes: t.thscode }, `行情快照 ${t.name}`),
  );
  if (!r.ok) fail(`行情接口失败：${r.error}`);
  const item = r.ok ? r.data.item[0] : undefined;
  if (!item || !r.ok || r.data.timestamp == null) fail("行情快照无数据");
  let ts = r.ok ? r.data.timestamp! : 0;
  if (ctx.simulate === "stale") ts -= 10 * DAY;
  if (ctx.now - ts > STALE_MS) fail(`行情数据已过期（数据时点 ${fmtCN(ts)}），不输出结论`);
  return { item: item!, ts, requestId: r.ok ? r.requestId : undefined, endpoint: ep };
}

async function bars(ctx: VerifyCtx, t: Ticker, type: "stock" | "index", start: number, end: number, adjust: "none" | "forward") {
  const ep = type === "index" ? "/api/a-share-index/prices/historical" : "/api/a-share/prices/historical";
  const params: Record<string, string | number> = { thscode: t.thscode, interval: "1d", start, end };
  if (type === "stock") params.adjust = adjust;
  const r = await memo(ctx, `h:${t.thscode}:${start}:${end}:${adjust}`, () =>
    fuyao<{ item: Bar[] }>(ctx, ep, params, `历史K线 ${t.name}`),
  );
  if (!r.ok) fail(`K线接口失败：${r.error}`);
  const items = (r.ok ? r.data.item : []).slice().sort((a, b) => a.date_ms - b.date_ms);
  if (!items.length) fail("区间内无K线数据（可能停牌或超出数据范围）");
  return { items, requestId: r.ok ? r.requestId : undefined, endpoint: ep };
}

const dateOf = (ms: number) => fmtCN(ms, false);

type Fetched = { actual: number; evidence: Evidence };

async function fetchActual(ctx: VerifyCtx, c: Claim): Promise<Fetched> {
  const unit = METRICS[c.metric].unit;
  if (c.metric === "unsupported") fail("该类陈述暂不在自动核查范围内，需人工核对");
  const t = await resolve(ctx, c.entity, c.entity_type);
  const resolved = `${t.name}（${t.thscode}）`;

  if ((c.metric === "price_change_pct" || c.metric === "last_price") && !c.as_of_date) {
    const s = await snapshot(ctx, t, c.entity_type);
    const isPct = c.metric === "price_change_pct";
    const actual = isPct ? s.item.price_change_ratio_pct : s.item.last_price;
    return {
      actual,
      evidence: {
        source: s.endpoint, field: isPct ? "price_change_ratio_pct" : "last_price", raw_value: actual, unit,
        as_of: fmtCN(s.ts), request_id: s.requestId, resolved,
        method: isPct ? "最新快照涨跌幅 =（最新价 / 前收盘价 − 1）× 100；盘中取数时并非收盘值" : "最新快照成交价；盘中取数时并非收盘价",
      },
    };
  }

  if (c.metric === "price_change_pct" || c.metric === "last_price") {
    const day = cnDateToMs(c.as_of_date!);
    const isPct = c.metric === "price_change_pct";
    const b = await bars(ctx, t, c.entity_type, day - 20 * DAY, day + DAY - 1, isPct ? "forward" : "none");
    const idx = b.items.findIndex((x) => dateOf(x.date_ms) === c.as_of_date);
    if (idx < 0) fail(`${c.as_of_date} 无K线（非交易日或停牌），无法核实`);
    if (isPct && idx === 0) fail("缺少前一交易日K线，无法计算涨跌幅");
    const actual = isPct ? (b.items[idx].close_price / b.items[idx - 1].close_price - 1) * 100 : b.items[idx].close_price;
    return {
      actual,
      evidence: {
        source: b.endpoint, field: "close_price", raw_value: b.items[idx].close_price, unit,
        as_of: c.as_of_date!, request_id: b.requestId, resolved,
        method: isPct
          ? `日K（前复权）：${c.as_of_date} 收盘 ${b.items[idx].close_price} / 前一交易日 ${dateOf(b.items[idx - 1].date_ms)} 收盘 ${b.items[idx - 1].close_price} − 1`
          : `日K（不复权）${c.as_of_date} 收盘价`,
      },
    };
  }

  if (c.metric === "window_return_pct") {
    if (!c.window_days) fail("稿件未明确统计区间，无法核实");
    const end = c.as_of_date ? cnDateToMs(c.as_of_date) + DAY - 1 : ctx.now;
    const b = await bars(ctx, t, c.entity_type, end - (c.window_days! + 15) * DAY, end, "forward");
    const last = b.items[b.items.length - 1];
    const baseCut = last.date_ms - c.window_days! * DAY;
    const base = [...b.items].reverse().find((x) => x.date_ms <= baseCut);
    if (!base) fail("区间起点无K线数据");
    const lastTs = last.date_ms - (ctx.simulate === "stale" ? 10 * DAY : 0);
    if (!c.as_of_date && ctx.now - lastTs > STALE_MS) fail(`K线数据已过期（最新K线 ${dateOf(lastTs)}），不输出结论`);
    const actual = (last.close_price / base!.close_price - 1) * 100;
    return {
      actual,
      evidence: {
        source: b.endpoint, field: "close_price", raw_value: last.close_price, unit,
        as_of: dateOf(last.date_ms), request_id: b.requestId, resolved,
        method: `日K（前复权）：${dateOf(last.date_ms)} 收盘 ${last.close_price} / ${dateOf(base!.date_ms)} 收盘 ${base!.close_price} − 1（${c.window_days} 个自然日窗口，起点取窗口起始日或之前最近交易日）`,
      },
    };
  }

  if (c.metric === "pe_ttm" || c.metric === "pe_mrq" || c.metric === "pb_mrq" || c.metric === "ps_ttm") {
    if (c.entity_type === "index") fail("指数估值暂未接入");
    const ep = "/api/a-share/valuations/snapshot";
    const r = await memo(ctx, `v:${t.thscode}`, () =>
      fuyao<{ timestamp: number | null; item: Valuation[] }>(ctx, ep, { thscodes: t.thscode }, `估值快照 ${t.name}`),
    );
    if (!r.ok) fail(`估值接口失败：${r.error}`);
    const item = r.ok ? r.data.item[0] : undefined;
    const v = item?.[c.metric];
    if (v == null) fail("数据源该估值字段为空（可能因亏损或净资产为负），无法核实");
    let ts = (r.ok && r.data.timestamp) || 0;
    if (ctx.simulate === "stale") ts -= 10 * DAY;
    if (ctx.now - ts > STALE_MS) fail(`估值数据已过期（数据时点 ${fmtCN(ts)}），不输出结论`);
    return {
      actual: v!,
      evidence: {
        source: ep, field: c.metric, raw_value: v!, unit, as_of: fmtCN(ts), request_id: r.ok ? r.requestId : undefined, resolved,
        method: c.metric.endsWith("ttm") ? "TTM：最近连续 12 个月口径，原值未四舍五入" : "MRQ：最近一个已披露报告期口径",
      },
    };
  }

  // 年报财务
  if (c.entity_type === "index") fail("指数无财务报表");
  const ep = "/api/a-share/financials/income-statements";
  const r = await memo(ctx, `i:${t.thscode}`, () =>
    fuyao<{ item: Income[] }>(ctx, ep, { thscode: t.thscode, period: "annual", limit: 5 }, `年报利润表 ${t.name}`),
  );
  if (!r.ok) fail(`财务接口失败：${r.error}`);
  const rows = r.ok ? r.data.item : [];
  const year = c.fiscal_year ?? Math.max(...rows.map((x) => x.fiscal_year));
  const cur = rows.find((x) => x.fiscal_year === year);
  if (!cur) fail(`数据源中没有 ${year} 年年报（可能尚未披露）`);
  const field = c.metric.startsWith("revenue") ? "operating_income" : c.metric.startsWith("parent") ? "parent_holder_net_profit" : "net_profit";
  const curV = cur![field as keyof Income] as number;
  let actual: number;
  let method: string;
  if (c.metric.endsWith("yoy_pct")) {
    const prev = rows.find((x) => x.fiscal_year === year - 1);
    if (!prev) fail(`缺少 ${year - 1} 年年报，无法计算同比`);
    const prevV = prev![field as keyof Income] as number;
    actual = (curV / prevV - 1) * 100;
    method = `${year} 年 ${field} ${curV} / ${year - 1} 年 ${prevV} − 1（整体合并利润表，原币元）`;
  } else {
    actual = curV / 1e8;
    method = `${year} 年年报 ${field}（整体合并口径），原值 ${curV} 元，÷1e8 换算为亿元`;
  }
  return {
    actual,
    evidence: {
      source: ep, field, raw_value: curV, unit, as_of: `FY${year}，披露 ${fmtCN(cur!.report_date_ms, false)}`,
      request_id: r.ok ? r.requestId : undefined, resolved, method,
    },
  };
}

const VALUATION = new Set<Metric>(["pe_ttm", "pe_mrq", "pb_mrq", "ps_ttm"]);

// 容差：[精确表述, 模糊表述]
function tolerance(m: Metric): { kind: "abs" | "rel"; v: [number, number] } {
  if (m.endsWith("_pct")) return { kind: "abs", v: [0.1, 1.0] };
  if (m === "last_price") return { kind: "rel", v: [0.005, 0.02] };
  if (VALUATION.has(m)) return { kind: "rel", v: [0.03, 0.08] }; // 估值随股价每日变化
  return { kind: "rel", v: [0.01, 0.03] };
}

export function compare(m: Metric, claimed: number, actual: number, approximate: boolean, comparator: Claim["comparator"] = "eq") {
  const signFlip = m.endsWith("_pct") && claimed !== 0 && actual !== 0 && Math.sign(claimed) !== Math.sign(actual);
  if (signFlip) return { match: false, signFlip: true, diff: actual - claimed };
  const tol = tolerance(m);
  const limit = tol.v[approximate ? 1 : 0];
  const diff = actual - claimed;
  if (comparator !== "eq") {
    // 方向性表述：只要求实际值在声称的一侧（允许精确容差）
    const slack = tol.kind === "abs" ? tol.v[0] : Math.abs(actual) * tol.v[0];
    const ok = comparator === "gt" ? actual >= claimed - slack : actual <= claimed + slack;
    return { match: ok, signFlip: false, diff, limit: tol.v[0], kind: tol.kind };
  }
  const ok = tol.kind === "abs" ? Math.abs(diff) <= limit : Math.abs(diff) <= Math.abs(actual) * limit;
  return { match: ok, signFlip: false, diff, limit, kind: tol.kind };
}

export function formatSuggestion(c: Claim, actual: number): string | null {
  const num = /-?\d[\d,]*(\.\d+)?/.exec(c.value_text);
  const isPct = c.metric.endsWith("_pct");
  if (!num) return `${Math.abs(actual).toFixed(2)}${METRICS[c.metric].unit}`;
  const origDec = num[1] ? num[1].length - 1 : 0;
  let v = actual;
  if (c.value_text.includes("万亿")) v = actual / 10000;
  const keepSign = /^[+-]/.test(num[0]) || /^[+-]/.test(c.value_text);
  if (!keepSign) v = Math.abs(v);
  const dec = isPct ? Math.max(origDec, 2) : Math.max(origDec, 1);
  return c.value_text.replace(num[0], v.toFixed(dec));
}

export async function verifyClaim(ctx: VerifyCtx, c: Claim): Promise<ClaimResult> {
  try {
    if (c.value == null && c.metric !== "unsupported") fail("未能从原文解析出数值");
    const { actual, evidence } = await fetchActual(ctx, c);
    const cmp = compare(c.metric, c.value!, actual, c.approximate, c.comparator);
    const unit = METRICS[c.metric].unit;
    const a = Number(actual.toFixed(4));
    if (cmp.match) {
      return { ...c, status: "match", actual: a, suggested_text: null, evidence, reason: `与数据源一致（稿件 ${c.value}${unit}，数据 ${a}${unit}）` };
    }
    if (cmp.signFlip) {
      return { ...c, status: "mismatch", actual: a, suggested_text: null, evidence, reason: `方向相反：稿件 ${c.value}${unit}，数据 ${a}${unit}，需人工改写涨跌表述` };
    }
    const cmpWord = c.comparator === "gt" ? "（稿件称“超过”）" : c.comparator === "lt" ? "（稿件称“低于”）" : "";
    const tolText = cmp.kind === "abs" ? `±${cmp.limit}${unit}` : `±${(cmp.limit! * 100).toFixed(1)}%`;
    return {
      ...c, status: "mismatch", actual: a, evidence, suggested_text: formatSuggestion(c, actual),
      reason: `与数据源不符：稿件 ${c.value}${unit}，数据 ${a}${unit}，超出容差 ${tolText}${cmpWord}`,
    };
  } catch (e) {
    if (!(e instanceof Unverifiable)) throw e;
    return { ...c, status: "unverifiable", actual: null, suggested_text: null, evidence: null, reason: e.message };
  }
}
