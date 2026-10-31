/**
 * PiNovelStudio — 章节契约桥（EXPERT-GROUP-R14/R17）
 *
 * 职责：把 `chapter-intent-builder` 专家的**提案**（Markdown 模板）转成现有链路真正消费的形状：
 *
 *   专家提案 Markdown
 *     → parseExpertChapterContract（结构化）
 *     → validateExpertChapterContract（必需项布尔检查；评分只作建议）
 *     → toExplicitOutlineMarkdown（生成 series/ch{N}-outline-explicit.md 文本）
 *     → craft/explicit-outline-parser.parseExplicitOutline（既有唯一解析器）
 *     → craft/chapter-seed-builder.buildChapterSeed（进入 ChapterSeed.authorChapterContract）
 *
 * 硬约束：
 *  - 只转换作者/专家已提供的内容，不凭空补造剧情、事实或 PROMISE ID。
 *  - 缺事件级契约时拒绝生成显式章纲（返回 null），而不是编造事件。
 *  - 必需项（章号 / 职能 / 主意图 / 硬事实 / 章末目标三项 / 缺口状态）缺一即不合格，
 *    评分卡总分不能替代必需项。
 *  - 新书没有历史承诺时，强制召回必须留空或写“不适用”，不得伪造 `PROMISE-*`。
 */

export type ExpertContractFactKind = "FACT" | "OOC";

export interface ExpertContractFact {
  kind: ExpertContractFactKind;
  id: string;
  content: string;
  consequence: string;
}

export interface ExpertContractEvent {
  index: number;
  title: string;
  characters: string[];
  summary: string;
  mustInclude: string[];
  foreshadowing: string;
  stateChanges: string[];
  /** 事件结束时状态发生了什么改变（`事件结果` 字段原文）。 */
  eventResult: string;
  endingTarget: string;
}

export interface ExpertEndingTarget {
  readerState: string;
  protagonistPosition: string;
  openQuestion: string;
  forcedRecall: string[];
}

export interface ExpertGapRow {
  item: string;
  ready: boolean;
  fix: string;
}

export interface ExpertChapterContractProposal {
  chapterNumber: number | null;
  chapterFunction: string;
  missingConsequence: string;
  primaryIntent: string;
  secondaryIntents: string[];
  keywords: string[];
  facts: ExpertContractFact[];
  endingTarget: ExpertEndingTarget;
  events: ExpertContractEvent[];
  gapStatus: "ready" | "blocked" | null;
  gaps: ExpertGapRow[];
  scoreAdvisory: number | null;
}

export interface ExpertContractIssue {
  code: string;
  message: string;
  field?: string;
}

export interface ExpertContractValidationOptions {
  /** canon/人物卡中已存在的 FACT/OOC ID；提供时禁止引用未登记 ID。 */
  knownFactIds?: string[];
  /** PromiseLedger 中已确认的 PROMISE ID；新书传空数组。 */
  knownPromiseIds?: string[];
  /** 是否要求事件级契约（显式章纲转换时必需）。 */
  requireEvents?: boolean;
}

export interface ExpertContractValidationResult {
  ok: boolean;
  errors: ExpertContractIssue[];
  warnings: ExpertContractIssue[];
  /** 评分卡总分，仅供作者参考，不参与 ok 判定。 */
  scoreAdvisory: number | null;
}

const ALLOWED_CHAPTER_FUNCTIONS = ["推进", "揭示", "代价", "转折", "积蓄"];

function splitTopSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let currentName: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (currentName !== null) sections.set(currentName, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^##\s+([^#\s][^#]*?)\s*$/u);
    if (heading) {
      flush();
      currentName = heading[1].trim();
      continue;
    }
    if (currentName !== null) buffer.push(line);
  }
  flush();
  return sections;
}

function parseBulletFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^-\s*(?:\*\*)?([^：*:]{1,24})(?:\*\*)?[：:]\s*(.*)$/u);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}

function parseTableRows(content: string): string[][] {
  const rows: string[][] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|\s*[-:]+/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim());
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
  }
  return rows;
}

function splitItems(raw: string, separators: RegExp = /[、,，/]/u): string[] {
  return raw
    .split(separators)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseEvents(section: string | undefined): ExpertContractEvent[] {
  if (!section) return [];
  const events: ExpertContractEvent[] = [];
  const blocks = [...section.matchAll(/^###\s*事件\s*(\d+)[：:]\s*(.*)$/gmu)];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const start = (block.index ?? 0) + block[0].length;
    const end = index + 1 < blocks.length ? blocks[index + 1].index ?? section.length : section.length;
    const fields = parseBulletFields(section.slice(start, end));
    events.push({
      index: Number(block[1]),
      title: block[2].trim(),
      characters: splitItems(fields.get("参与角色") ?? ""),
      summary: fields.get("内容摘要") ?? "",
      mustInclude: splitItems(fields.get("必须包含") ?? ""),
      foreshadowing: fields.get("伏笔埋设") ?? "",
      stateChanges: splitItems(fields.get("状态变化") ?? ""),
      eventResult: fields.get("事件结果") ?? "",
      endingTarget: fields.get("章末目标") ?? "",
    });
  }
  return events;
}

/** 解析专家章节契约提案（宽松解析，严格校验在 validateExpertChapterContract）。 */
export function parseExpertChapterContract(markdown: string): ExpertChapterContractProposal {
  const sections = splitTopSections(markdown ?? "");
  const functionFields = parseBulletFields(sections.get("章节功能") ?? "");
  const intentFields = parseBulletFields(sections.get("意图") ?? "");
  const endingFields = parseBulletFields(sections.get("章末目标") ?? "");
  const gapSection = sections.get("缺口自检") ?? "";

  const chapterNumberRaw = functionFields.get("chapterNumber") ?? functionFields.get("章号") ?? "";
  const chapterNumberMatch = chapterNumberRaw.match(/\d+/u);
  const chapterNumber = chapterNumberMatch ? Number(chapterNumberMatch[0]) : null;

  const facts: ExpertContractFact[] = [];
  for (const row of parseTableRows(sections.get("不可违背事实") ?? "")) {
    if (row.length < 3) continue;
    const kindRaw = row[0].toUpperCase();
    if (kindRaw !== "FACT" && kindRaw !== "OOC") continue;
    facts.push({
      kind: kindRaw,
      id: row[1].trim(),
      content: row[2].trim(),
      consequence: row[3]?.trim() ?? "",
    });
  }

  const forcedRecall = [...(endingFields.get("强制召回") ?? "").matchAll(/PROMISE-[A-Za-z0-9_-]+/gu)]
    .map((match) => match[0]);

  const gapStatusRaw = (gapSection.match(/status[：:]\s*(ready|blocked)/iu)?.[1] ?? "").toLowerCase();
  const gapStatus = gapStatusRaw === "ready" || gapStatusRaw === "blocked" ? gapStatusRaw : null;
  const gaps = parseTableRows(gapSection)
    .filter((row) => row.length >= 2 && row[0] !== "项目" && row[0].toLowerCase() !== "item")
    .map((row) => ({
      item: row[0],
      ready: /^(?:是|已齐备|true|ready)/i.test(row[1]),
      fix: row[2] ?? "",
    }));

  const scoreMatch = (markdown ?? "").match(/(?:总分|评分)[：:]\s*(\d+(?:\.\d+)?)/u);

  return {
    chapterNumber,
    chapterFunction: functionFields.get("职能") ?? functionFields.get("章节功能") ?? "",
    missingConsequence: functionFields.get("缺失后果") ?? "",
    primaryIntent: intentFields.get("主意图") ?? "",
    secondaryIntents: splitItems(intentFields.get("次意图") ?? ""),
    keywords: splitItems(intentFields.get("关键词") ?? ""),
    facts,
    endingTarget: {
      readerState: endingFields.get("读者状态") ?? "",
      protagonistPosition: endingFields.get("主角位置") ?? "",
      openQuestion: endingFields.get("新问题") ?? "",
      forcedRecall,
    },
    events: parseEvents(sections.get("事件")),
    gapStatus,
    gaps,
    scoreAdvisory: scoreMatch ? Number(scoreMatch[1]) : null,
  };
}

/**
 * 必需项布尔检查。评分卡总分（scoreAdvisory）只作建议，不参与判定。
 */
export function validateExpertChapterContract(
  proposal: ExpertChapterContractProposal,
  options: ExpertContractValidationOptions = {},
): ExpertContractValidationResult {
  const errors: ExpertContractIssue[] = [];
  const warnings: ExpertContractIssue[] = [];

  if (proposal.chapterNumber === null || !Number.isInteger(proposal.chapterNumber) || proposal.chapterNumber <= 0) {
    errors.push({ code: "chapter_number_invalid", message: "缺少有效正整数 chapterNumber", field: "chapterNumber" });
  }
  if (!proposal.chapterFunction.trim()) {
    errors.push({ code: "chapter_function_missing", message: "缺少章节职能（推进/揭示/代价/转折/积蓄）", field: "chapterFunction" });
  } else if (!ALLOWED_CHAPTER_FUNCTIONS.includes(proposal.chapterFunction.trim())) {
    warnings.push({
      code: "chapter_function_uncommon",
      message: `章节职能「${proposal.chapterFunction}」不在常用五类内，请确认是否为作者原意`,
      field: "chapterFunction",
    });
  }
  if (!proposal.primaryIntent.trim()) {
    errors.push({ code: "primary_intent_missing", message: "缺少主意图", field: "primaryIntent" });
  }
  if (proposal.facts.length === 0) {
    errors.push({ code: "facts_missing", message: "未列出任何不可违背事实（FACT/OOC）", field: "facts" });
  }
  for (const fact of proposal.facts) {
    if (!fact.id) errors.push({ code: "fact_id_missing", message: "存在未标 ID 的硬事实", field: "facts" });
    if (!fact.content) errors.push({ code: "fact_content_missing", message: `硬事实 ${fact.id || "(无ID)"} 缺少内容`, field: "facts" });
  }
  if (!proposal.endingTarget.readerState.trim()) {
    errors.push({ code: "ending_reader_state_missing", message: "章末目标缺少“读者状态”", field: "endingTarget" });
  }
  if (!proposal.endingTarget.protagonistPosition.trim()) {
    errors.push({ code: "ending_protagonist_position_missing", message: "章末目标缺少“主角位置”", field: "endingTarget" });
  }
  if (!proposal.endingTarget.openQuestion.trim()) {
    errors.push({ code: "ending_open_question_missing", message: "章末目标缺少“新问题”", field: "endingTarget" });
  }
  if (proposal.gapStatus === null) {
    errors.push({ code: "gap_status_missing", message: "缺口自检必须显式给出 status: ready | blocked", field: "gapStatus" });
  } else if (proposal.gapStatus === "blocked") {
    errors.push({ code: "gap_status_blocked", message: "缺口自检为 blocked，禁止进入生成", field: "gapStatus" });
  }
  for (const gap of proposal.gaps) {
    if (!gap.ready) {
      errors.push({ code: "gap_item_not_ready", message: `缺口「${gap.item}」未齐备，需补：${gap.fix || "（未说明）"}`, field: "gaps" });
    }
  }

  if (options.knownFactIds) {
    const known = new Set(options.knownFactIds);
    for (const fact of proposal.facts) {
      if (fact.id && !known.has(fact.id)) {
        errors.push({
          code: "fabricated_fact_id",
          message: `硬事实 ${fact.id} 未在 canon/人物卡登记；新设定必须先经作者确认落 canon`,
          field: "facts",
        });
      }
    }
  }
  if (options.knownPromiseIds) {
    const known = new Set(options.knownPromiseIds);
    for (const promiseId of proposal.endingTarget.forcedRecall) {
      if (!known.has(promiseId)) {
        errors.push({
          code: known.size === 0 ? "promise_id_on_new_book" : "fabricated_promise_id",
          message: known.size === 0
            ? `新书没有历史承诺，不得伪造 ${promiseId}；强制召回应留空或写“不适用”`
            : `强制召回 ${promiseId} 不在已确认 PromiseLedger 中`,
          field: "endingTarget",
        });
      }
    }
  }

  if (options.requireEvents && proposal.events.length === 0) {
    errors.push({ code: "events_required", message: "缺少事件级契约，无法转换为显式章纲", field: "events" });
  }
  for (const event of proposal.events) {
    if (!event.title.trim()) {
      errors.push({ code: "event_title_missing", message: `事件 ${event.index} 缺少标题`, field: "events" });
    }
    if (!event.summary.trim() && event.mustInclude.length === 0) {
      errors.push({ code: "event_content_missing", message: `事件 ${event.index} 既无内容摘要也无必须包含项`, field: "events" });
    }
  }

  if (proposal.scoreAdvisory !== null && errors.length > 0 && proposal.scoreAdvisory >= 8) {
    warnings.push({
      code: "score_cannot_override_required_items",
      message: `评分卡总分 ${proposal.scoreAdvisory} 不能替代必需项；存在 ${errors.length} 项必需缺失`,
      field: "scoreAdvisory",
    });
  }

  return { ok: errors.length === 0, errors, warnings, scoreAdvisory: proposal.scoreAdvisory };
}

/**
 * 生成 `series/ch{N}-outline-explicit.md` 文本。
 *
 * 输出格式必须与既有唯一消费链路对齐（`craft/explicit-outline-parser.ts` +
 * `craft/chapter-seed-builder.ts:loadAuthorChapterContract`）：
 *  - 顶层字段用 `- **字段**：值`（消费者用 `extractMarkdownField` 按行匹配）
 *  - 事件用 `## 事件序列` 下的 `### 事件 N：标题` 与同样式字段
 *
 * 无事件级契约时返回 null：拒绝编造事件，调用方应走“无作者显式契约”分支。
 */
export function toExplicitOutlineMarkdown(proposal: ExpertChapterContractProposal): string | null {
  if (proposal.events.length === 0) return null;

  const lines: string[] = [
    `# 第 ${proposal.chapterNumber ?? "?"} 章 显式契约（由专家提案转换）`,
    "",
    "## 章节定位",
    "",
    `- **章节编号**：第 ${proposal.chapterNumber ?? "?"} 章`,
    `- **本章功能**：${proposal.chapterFunction || "（未填写）"}`,
    `- **目标读者体验**：${proposal.endingTarget.readerState || "（未填写）"}`,
    `- **本章阻力**：${proposal.events.flatMap((event) => event.mustInclude).slice(0, 3).join("；") || "（未填写）"}`,
    `- **章末目标**：${proposal.endingTarget.readerState}；${proposal.endingTarget.protagonistPosition}；留下新问题：${proposal.endingTarget.openQuestion}`,
    "",
    "## 不可违背事实",
    "| 类型 | ID | 内容 | 违反后果 |",
    "|---|---|---|---|",
    ...proposal.facts.map((fact) => `| ${fact.kind} | ${fact.id} | ${fact.content} | ${fact.consequence || "—"} |`),
    "",
    `## 事件序列（${proposal.events.length}事件）`,
    "",
  ];

  for (const event of proposal.events) {
    lines.push(
      `### 事件 ${event.index}：${event.title}`,
      "",
      `- **参与角色**：${event.characters.join("、") || "（未标注）"}`,
      `- **内容摘要**：${event.summary || event.mustInclude.join("；")}`,
      `- **必须包含**：${event.mustInclude.join("、") || "（未标注）"}`,
    );
    if (event.foreshadowing) lines.push(`- **伏笔埋设**：${event.foreshadowing}`);
    if (event.eventResult) lines.push(`- **事件结果**：${event.eventResult}`);
    if (event.stateChanges.length > 0) lines.push(`- **状态变化**：${event.stateChanges.join("、")}`);
    if (event.endingTarget) lines.push(`- **章末目标**：${event.endingTarget}`);
    lines.push("");
  }

  return lines.join("\n");
}
