import type { Ctx } from "./fuyao";
import { llmJson } from "./llm";
import type { ComplianceCategory, ComplianceFlag } from "./types";

// 确定性规则：LLM 不可用时依然生效，作为合规底线
const RULES: { category: ComplianceCategory; pattern: RegExp; suggestion: string }[] = [
  { category: "收益承诺", pattern: /保本|稳赚(不赔)?|包赚|躺赚|保证收益|零风险|无风险|稳稳(地)?赚|收益(率)?(可达|至少|不低于)[^，。,；;]*|翻倍/g, suggestion: "删除收益承诺，改为客观描述历史表现并提示\"过往业绩不代表未来表现\"" },
  { category: "确定性预测", pattern: /必涨|必跌|必将[^，。,；;]{0,8}|一定会[^，。,；;]{0,8}|肯定(会|要)?(涨|跌|突破)|即将(暴涨|起飞|拉升|主升)|主升浪|目标价[^，。,；;]{0,10}|看到\d+(\.\d+)?元/g, suggestion: "删除确定性判断，改为\"存在不确定性，后续走势取决于……\"" },
  { category: "直接买卖建议", pattern: /建议(买入|卖出|加仓|减仓|清仓|抄底|持有|重仓)|(立即|赶紧|马上)(买入|上车|卖出|入场)|满仓|梭哈|抄底|上车|逢低(买入|布局|吸纳)|重仓(买入|持有)?/g, suggestion: "删除买卖指令，改为\"投资者可结合自身风险承受能力独立判断\"" },
  { category: "内幕/操纵暗示", pattern: /内幕(消息)?|庄家|(主力|机构)[^，。]{0,4}(即将|准备|开始)拉升|消息人士透露|独家消息/g, suggestion: "删除未经证实的内幕或操纵暗示" },
];

export function ruleCheck(text: string): ComplianceFlag[] {
  const out: ComplianceFlag[] = [];
  const seen = new Set<string>();
  for (const r of RULES) {
    for (const m of text.matchAll(r.pattern)) {
      const quote = m[0];
      if (seen.has(quote)) continue;
      seen.add(quote);
      out.push({ id: `r${out.length + 1}`, quote, category: r.category, reason: `命中规则：${r.category}`, suggestion: r.suggestion, detector: "rule", severity: "high" });
    }
  }
  return out;
}

const CATEGORIES: ComplianceCategory[] = ["收益承诺", "确定性预测", "直接买卖建议", "内幕/操纵暗示", "夸大或误导", "观点未标注"];

export const COMPLIANCE_SYSTEM = `你是证券投资顾问业务的合规审查员，依据《证券投资顾问业务暂行规定》《证券期货投资者适当性管理办法》的一般原则审查投顾稿件。
找出以下问题（关键词规则抓不到的语义问题优先）：
- 收益承诺：明示或暗示保本、确定收益
- 确定性预测：把对未来涨跌的推断写成确定事实
- 直接买卖建议：直接或变相的买入/卖出/持仓指令（包括"可以考虑上车"这类委婉说法）
- 内幕/操纵暗示
- 夸大或误导：以偏概全、片面强调收益忽略风险
- 观点未标注：主观推断没有使用"我们认为/可能/或"等限定词，读者易误以为事实

注意：对已经发生的历史数据（股价、财报数字）的客观陈述不是"确定性预测"，不要标记；数字是否正确由另一个模块核查，你不需要判断。
只有涉及未来走势或未来业绩、且语气确定时才算"确定性预测"。
quote 必须是稿件原文逐字子串（尽量短，只框出问题片段）。rewrite 是可以直接替换 quote 的合规改写，不得新增任何数据。
没有问题就返回空数组。只输出 JSON：{"issues":[{"quote":"","category":"","reason":"","rewrite":""}]}`;

type RawIssues = { issues?: { quote?: string; category?: string; reason?: string; rewrite?: string }[] };

const FUTURE = /将|未来|后市|后续|预计|有望|即将|明年|下半年|接下来|目标|会|必|肯定|一定|大概率/;

export function sanitizeIssues(text: string, raw: RawIssues, startId = 1): ComplianceFlag[] {
  const out: ComplianceFlag[] = [];
  for (const i of raw.issues ?? []) {
    const quote = String(i.quote ?? "").trim();
    if (!quote || !text.includes(quote)) continue; // 原文不存在则丢弃
    const category = CATEGORIES.includes(i.category as ComplianceCategory) ? (i.category as ComplianceCategory) : "夸大或误导";
    // "确定性预测"必须指向未来；模型常把历史财务数字误判为预测，这里硬过滤
    if (category === "确定性预测" && !FUTURE.test(quote)) continue;
    out.push({ id: `l${startId + out.length}`, quote, category, reason: String(i.reason ?? ""), suggestion: String(i.rewrite ?? ""), detector: "llm", severity: category === "观点未标注" ? "low" : "high" });
  }
  return out;
}

export async function complianceCheck(ctx: Ctx, text: string) {
  const t0 = Date.now();
  const rules = ruleCheck(text);
  ctx.trace.push({ step: "合规规则扫描", tool: "规则引擎", ok: true, ms: Date.now() - t0, note: `命中 ${rules.length} 处` });
  const r = await llmJson<RawIssues>(ctx, "合规语义审查", COMPLIANCE_SYSTEM, `稿件：\n${text}`);
  if (!r.ok) return { flags: rules, llmOk: false };
  const llm = sanitizeIssues(text, r.data).filter(
    // 与规则命中重叠的保留规则版本，避免重复
    (f) => !rules.some((x) => x.quote.includes(f.quote) || f.quote.includes(x.quote)),
  );
  return { flags: [...rules, ...llm], llmOk: true };
}
