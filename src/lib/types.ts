// 支持核查的指标。LLM 只能从这个枚举里选，选不到的标为 unsupported。
export const METRICS = {
  price_change_pct: { label: "当日涨跌幅", unit: "%" },
  last_price: { label: "收盘价/最新价", unit: "元" },
  window_return_pct: { label: "区间涨跌幅", unit: "%" },
  pe_ttm: { label: "市盈率TTM", unit: "倍" },
  pe_mrq: { label: "市盈率MRQ", unit: "倍" },
  pb_mrq: { label: "市净率MRQ", unit: "倍" },
  ps_ttm: { label: "市销率TTM", unit: "倍" },
  revenue: { label: "营业收入(年报)", unit: "亿元" },
  net_profit: { label: "净利润(年报)", unit: "亿元" },
  parent_net_profit: { label: "归母净利润(年报)", unit: "亿元" },
  revenue_yoy_pct: { label: "营业收入同比(年报)", unit: "%" },
  parent_net_profit_yoy_pct: { label: "归母净利润同比(年报)", unit: "%" },
  unsupported: { label: "暂不支持的陈述", unit: "" },
} as const;
export type Metric = keyof typeof METRICS;

export type Claim = {
  id: string;
  quote: string; // 稿件原句（必须是原文子串）
  value_text: string; // 原句中的数字片段，如 "3.5%"
  entity: string; // 标的名称或代码
  entity_type: "stock" | "index";
  metric: Metric;
  value: number | null; // 已换算到 METRICS[metric].unit
  approximate: boolean; // 原文是否用了"约/近/左右"等模糊词
  comparator: "eq" | "gt" | "lt"; // "超过/逾/至少" 为 gt，"不足/低于/不到" 为 lt
  as_of_date: string | null; // 原文明确提到的日期 YYYY-MM-DD
  window_days: number | null; // 区间涨跌幅的自然日窗口
  fiscal_year: number | null; // 财务指标的年份
};

export type ClaimStatus = "match" | "mismatch" | "unverifiable";

export type Evidence = {
  source: string; // 接口路径
  field: string;
  raw_value: number | null;
  unit: string;
  as_of: string; // 数据时点（北京时间）
  request_id?: string;
  method: string; // 统计口径说明
  resolved: string; // 解析后的标的
};

export type ClaimResult = Claim & {
  status: ClaimStatus;
  reason: string;
  actual: number | null;
  suggested_text: string | null;
  evidence: Evidence | null;
};

export type ComplianceCategory = "收益承诺" | "确定性预测" | "直接买卖建议" | "内幕/操纵暗示" | "夸大或误导" | "观点未标注";

export type ComplianceFlag = {
  id: string;
  quote: string;
  category: ComplianceCategory;
  reason: string;
  suggestion: string;
  detector: "rule" | "llm";
  severity: "high" | "low"; // low 仅为改进建议，不阻断发布
};

export type Statement = { quote: string; kind: "fact" | "inference" | "opinion" };

export type TraceStep = {
  step: string;
  tool: string;
  args?: string;
  ok: boolean;
  ms: number;
  note?: string;
};

export type Verdict = "pass_pending_signoff" | "needs_review" | "needs_revision" | "incomplete";

export type CheckResponse = {
  verdict: Verdict;
  verdict_reasons: string[];
  claims: ClaimResult[];
  compliance: ComplianceFlag[];
  statements: Statement[];
  trace: TraceStep[];
  llm_available: boolean;
  checked_at: string;
};

export type Simulate = "none" | "fuyao_down" | "llm_down" | "stale";
