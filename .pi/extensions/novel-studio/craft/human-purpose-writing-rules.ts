/**
 * PiNovelStudio — Human-purpose writing rules
 *
 * Shared runtime prompt rules for removing "AI flavored" filler prose and
 * enforcing purposeful, human-feeling web-novel narration.
 */

export const HUMAN_PURPOSE_WRITING_RULES_TEXT = `## 真人目的性写作铁律
- 每句话必须有明确目的：推进情节、埋伏笔、体现性格、制造冲突、承载情绪转折，五者至少命中一项。
- 能一句写清的，不拆成两句；能删除且信息不损失的句子，必须删除。
- 描写必须改变读者对行动、风险、人物关系或场面气氛的判断，不能只负责“好看”。
- 对话必须推动剧情或暴露态度差异，不写寒暄式聊天；上下文能识别说话人时删除“某某说/某某道”。
- 情绪克制表达，用动作、停顿、视线、选择和反应承载，不直接煽情。
- 宁可压缩，不要扩写废句；不要为了文学性堆比喻、堆形容词、堆否定铺垫。`;

export const AI_SENTENCE_FORBIDDEN_PATTERNS_TEXT = `## 高风险 AI 句式禁区
- 禁止“不是A，不是B，是C”式否定定义链，除非存在明确误判反转或关键信息差；常规信息直接写 C 以及人物反应。
- 禁止英文否定转正迁移：“不是A，是B”“不是A，而是B”“与其说A，不如说B”；中文叙事优先直接写有效事实、误判后果或人物选择。
- 禁止英文分裂句/伪分裂句：“正是A才B”“真正重要的是A”“最令人意外的是A”；改成动作、证据或结果自然落句。
- 禁止议论文式显性连接词：“不仅...而且/更是”“一方面...另一方面”“相比之下”“换句话说/也就是说”；用场面顺序、人物反应、轻量转折承接。
- 禁止正式说明文标记：“毫无疑问”“不言而喻”“值得注意的是”“诚然”“尽管事实上”；小说正文不替读者下结论。
- 禁止因果/范围/时间显化模板：“...的原因是”“这意味着”“在某种程度上”“在...方面”“与此同时”“就在这时”；把含义压回动作、代价、物证或未结账细节。
- 禁止英文语序从句迁移：“当...时，”“为了...，”“虽然...但是...”“因为...所以...”“即使...也...”“似乎/仿佛+整句”；常规动作也不要写成“开始/继续+动词”，除非确有持续状态或阶段起点。
- 禁止空泛机器比喻，如“指示灯/屏幕/设备像野兽眼睛/鬼火”；如果比喻不改变风险、人物或信息判断，删掉。
- 禁止无目的感官句：灯亮、风吹、声音响之后，必须立刻影响人物行动、气氛变化或信息推进。
- 禁止“为了描写而描写”：景物、光影、气味、声音都必须服务于当前事件。
- 禁止把废句润色成另一种废句；改写时优先删除、合并、压缩。`;

export const PROTAGONIST_AGENCY_WRITING_RULES_TEXT = `## 主角主动性与成长线规则
- 主角不能被写成被动失败者；他必须有自己的思考、判断、选择、反思和成长。
- 禁写“身体僵硬”来偷懒表现失败或无能；涉及能力失误时，必须写成主动选择、风险控制或寻找 100% 掌控。
- 战斗要写策略、来回、受伤、代价和事后反思，不能一触碰就解决。
- 亲情、旧物、队友信任、人间烟火等情感锚点，每次出现都要有状态变化或情绪推进。
- 幕后操控和欲望侵蚀少解释，只暗示能力影响；主角可疑惑，但不要让旁白替读者全讲明。`;

export function buildHumanPurposeWritingRulesBlock(options?: {
  includeProtagonistAgencyRules?: boolean;
}): string {
  const blocks = [
    HUMAN_PURPOSE_WRITING_RULES_TEXT,
    AI_SENTENCE_FORBIDDEN_PATTERNS_TEXT,
  ];

  if (options?.includeProtagonistAgencyRules) {
    blocks.push(PROTAGONIST_AGENCY_WRITING_RULES_TEXT);
  }

  return blocks.join("\n\n");
}
