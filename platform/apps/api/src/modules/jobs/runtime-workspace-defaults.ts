/**
 * 运行时工作区辅助：显式章纲编译与失败文案。
 * 正式生成不得用默认题材/风格/世界观顶替作者未确认的资料。
 */
export function resolveProjectGenre(genre: string | null | undefined): string {
  return genre?.trim() ?? '';
}

export function buildExplicitOutlineMarkdown(input: {
  intent: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
  endingGoal: string;
  characterNames: string[];
  openPromises?: string[];
}): string {
  const intent = input.intent.trim() || '推进本章冲突';
  const endingGoal = input.endingGoal.trim() || '留下可续写的章末压力';
  const names = input.characterNames.map((name) => name.trim()).filter(Boolean);
  const participants = names.length > 0 ? names.join('、') : '主角';
  const title = intent.replace(/\s+/g, ' ').slice(0, 40);
  const summaryParts = [intent];
  if (input.mustInclude.trim()) summaryParts.push(input.mustInclude.trim());
  if (input.characterMotives.trim()) summaryParts.push(input.characterMotives.trim());
  const summary = summaryParts.join('。');
  const lines = [
    '# 本章功能',
    '推进本章冲突，并与全书大纲、角色现状、未结伏笔保持一致',
    '',
    `## 事件 1：${title}`,
    `参与角色：${participants}`,
    `内容摘要：${summary}`,
    `章末目标：${endingGoal}`,
  ];
  if (input.openPromises && input.openPromises.length > 0) {
    lines.push(`伏笔埋设：${input.openPromises.slice(0, 8).join('；')}`);
  }
  if (input.forbiddenFacts.trim()) {
    lines.push(`禁止：${input.forbiddenFacts.trim()}`);
  }
  return lines.join('\n');
}

export function describeGenerationFailure(error: unknown): string {
  if (error && typeof error === 'object' && 'envelope' in error) {
    const envelope = (error as { envelope?: { code?: unknown; reason?: unknown } }).envelope;
    if (envelope && typeof envelope.code === 'string' && typeof envelope.reason === 'string') {
      return `[${envelope.code}] ${envelope.reason}`.slice(0, 1000);
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1000) : 'generation failed';
}
