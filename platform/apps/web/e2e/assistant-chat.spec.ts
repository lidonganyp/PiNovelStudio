/**
 * 阶段一基线 + 阶段三/四/五增量契约：SSE 解析器、useAssistantChat 状态机、
 * Markdown 安全渲染与结构化卡片数据源的纯逻辑测试。
 * 不需要浏览器与真实后端：fetch 以内存流桩替换。
 */
import { test, expect } from '@playwright/test';
import { nextTick } from 'vue';
import {
  prepareAssistantRequest,
  sendMessageStream,
  userFacingFailure,
  type AssistantStreamEvent,
} from '../src/api/assistant';
import { useAssistantChat } from '../src/composables/useAssistantChat';
import { renderMarkdown } from '../src/components/workspace/chat/markdown';
import { http } from '../src/api/http';
import type { StewardView } from '../src/api/assistant';

// Node 测试环境没有可用的 localStorage（sendMessageStream 会读取 token）。
const storage = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: () => null,
  get length() {
    return storage.size;
  },
} as Storage;

// safeHref 依赖 window.location.origin（链接协议白名单校验）。
(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost:5173' } };

/** 构造一段 SSE 响应体（内存 ReadableStream）。 */
function sseResponse(chunks: string[], init?: { status?: number; body?: string }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(init?.body ?? stream, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const DONE_EVENT =
  'data: {"type":"done","done":true,"message":{"id":42,"role":"assistant","content":"最终回复","createdAt":"2026-01-01T00:00:00.000Z"},"contextManifest":{"totalTokenBudget":16000,"totalTokensUsed":1200,"blocks":[]}}\n\n';

test('方案成功后同步旧卡片，刷新历史也不能再次操作已提交方案', async () => {
  const savedGet = http.get;
  const savedFetch = globalThis.fetch;
  const pending: StewardView = {
    status: 'confirmation_required', reply: '确认方案', chapterNumber: 21,
    proposalId: 'proposal-21', sourceVersion: 'v1', proposalStatus: 'pending',
    proposals: [], missing: ['章节种子'],
  };
  const applied: StewardView = { ...pending, status: 'ready', proposalStatus: 'applied', generationJobId: 'job-21', missing: [] };
  const older = { id: 1, role: 'assistant', content: '确认方案', metadata: { steward: pending } };
  const newer = { id: 2, role: 'assistant', content: '已提交', metadata: { steward: applied } };
  const chat = useAssistantChat({ projectId: 252 });
  http.get = (async () => ({ data: [older] })) as typeof http.get;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return sseResponse([`data: ${JSON.stringify({ type: 'done', done: true, message: newer, steward: applied })}\n\n`]);
  }) as typeof fetch;
  try {
    await chat.load();
    expect(chat.pendingSteward(chat.messages.value[0]!)).toBe(true);
    await chat.sendSteward(chat.messages.value[0]!, 'apply_and_generate');
    expect(chat.messages.value[0]?.steward).toEqual(applied);
    expect(chat.pendingSteward(chat.messages.value[0]!)).toBe(false);
    await chat.sendSteward(chat.messages.value[0]!, 'cancel');
    expect(requestCount).toBe(1);
    http.get = (async () => ({ data: [older, newer] })) as typeof http.get;
    await chat.load();
    expect(chat.messages.value[0]?.steward).toEqual(applied);
    expect(chat.pendingSteward(chat.messages.value[0]!)).toBe(false);
  } finally {
    http.get = savedGet;
    await restoreFetch(savedFetch);
  }
});

async function restoreFetch(saved: typeof fetch): Promise<void> {
  globalThis.fetch = saved;
}

test('SSE 解析器按序派发 delta 与 done，且以服务器消息为准', async () => {
  const savedFetch = globalThis.fetch;
  const events: AssistantStreamEvent[] = [];
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"type":"delta","delta":"你好"}\n\n',
      'data: {"type":"delta","delta":"，世界"}\n\n',
      'data: {"type":"artifact","artifacts":{"outlineSaved":true}}\n\n',
      DONE_EVENT,
    ])) as typeof fetch;
  try {
    await sendMessageStream(1, { content: 'hi' }, (event) => events.push(event));
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(events.map((event) => event.type)).toEqual(['delta', 'delta', 'artifact', 'done']);
  const done = events.at(-1);
  expect(done?.type).toBe('done');
  if (done?.type === 'done') {
    expect(done.message.id).toBe(42);
    expect(done.message.content).toBe('最终回复');
    expect(done.contextManifest?.totalTokensUsed).toBe(1200);
  }
});

test('流中断（无 done 事件）必须抛错，不得伪装成功', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(['data: {"type":"delta","delta":"部分输出"}\n\n'])) as typeof fetch;
  try {
    await expect(sendMessageStream(1, { content: 'hi' }, () => {})).rejects.toThrow(
      '规划模型连接中断',
    );
  } finally {
    await restoreFetch(savedFetch);
  }
});

test('非 2xx 响应携带 FailureEnvelope 时派发 failure 事件并抛脱敏文案', async () => {
  const savedFetch = globalThis.fetch;
  const events: AssistantStreamEvent[] = [];
  globalThis.fetch = (async () =>
    sseResponse([], {
      status: 503,
      body: JSON.stringify({
        message: '上游失败',
        failure: {
          stage: 'assistant.planner',
          gate: 'planner_schema',
          code: 'planner_failed',
          severity: 'recoverable',
          reason: '规划模型暂时不可用',
          recoverable: true,
        },
      }),
    })) as typeof fetch;
  try {
    await expect(
      sendMessageStream(1, { content: 'hi' }, (event) => events.push(event)),
    ).rejects.toThrow('规划模型暂时不可用');
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('failure');
});

test('敏感错误信息（api_key/stack/provider）不得透出给用户', () => {
  expect(userFacingFailure('Error: stack at /srv/app.ts api_key=sk-xxx')).toBe(
    '操作失败，请稍后重试或按提示补全资料',
  );
  expect(userFacingFailure('余额不足')).toBe('余额不足');
});

test('采用并生成的计费配置阻断保留处理指引，恢复后可使用原方案重试', async () => {
  const savedFetch = globalThis.fetch;
  const requests: unknown[] = [];
  const failure = {
    stage: 'jobs.submit', gate: 'billing_configuration', code: 'generation_billing_unavailable',
    severity: 'preflight', reason: '生成服务的计费配置尚未就绪，请联系管理员补全后再生成。',
    recoverable: false, userActionRequired: ['请联系管理员检查生成服务的生效费率与渠道配置'],
  };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? sseResponse([], { status: 503, body: JSON.stringify({ failure, message: failure.reason }) })
      : sseResponse([DONE_EVENT]);
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 252 });
  const message = {
    id: 1201, role: 'assistant', content: '确认方案',
    steward: {
      status: 'confirmation_required' as const, reply: '确认方案', chapterNumber: 21,
      proposalId: 'proposal-21', sourceVersion: 'before-seed-save', proposalStatus: 'pending' as const,
      proposals: [{ field: 'chapter_seed', value: '{"intent":"推进调查","endingGoal":"取得线索"}', source: ['chapter:20'], requiresConfirmation: true }],
      missing: ['章节种子'],
    },
  };
  try {
    await chat.sendSteward(message, 'apply_and_generate');
    expect(chat.panelError.value).toEqual(failure);
    expect(chat.messages.value.at(-1)?.status).toBe('failed');
    expect(chat.messages.value.at(-1)?.failure?.recoverable).toBe(false);
    await chat.send(true);
    expect(chat.panelError.value).toBeNull();
    expect(chat.messages.value.at(-1)?.status).toBe('success');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ stewardAction: 'apply_and_generate', proposalId: 'proposal-21' });
  } finally {
    await restoreFetch(savedFetch);
  }
});

test('reducer：delta 累积内容，done 用服务器消息替换本地流式占位', async () => {
  const savedFetch = globalThis.fetch;
  const trackedJobs: string[] = [];
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"type":"delta","delta":"草稿"}\n\n',
      'data: {"type":"job_submitted","jobId":"job-1","chapterNumber":3,"publicEntry":"novel_generate_chapter"}\n\n',
      `data: ${JSON.stringify({
        type: 'done',
        done: true,
        message: { id: 7, role: 'assistant', content: '已提交', createdAt: '2026-01-01T00:00:00.000Z' },
        generationJobId: 'job-1',
        artifacts: { generationJobId: 'job-1', chaptersTouched: [3] },
      })}\n\n`,
    ])) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1, trackJob: (jobId) => trackedJobs.push(jobId) });
  try {
    await chat.send(false, { content: '生成第 3 章' });
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(chat.messages.value).toHaveLength(2);
  const assistant = chat.messages.value[1];
  expect(assistant?.id).toBe(7);
  expect(assistant?.content).toBe('已提交');
  expect(assistant?.status).toBe('success');
  expect(assistant?.streaming).toBeFalsy();
  // 现有契约：job_submitted 事件与 done.generationJobId 各上报一次（幂等，同 jobId）
  expect(trackedJobs).toEqual(['job-1', 'job-1']);
  // 消息级 GenerationRequestCard 驱动条件：done.artifacts.generationJobId 已写入内存消息，
  // 当前会话与刷新后（load 恢复 metadata.artifacts）渲染行为一致
  expect(assistant?.artifacts?.generationJobId).toBe('job-1');
  expect(assistant?.artifacts?.chaptersTouched).toEqual([3]);
  // 发送完成后输入框清空、无面板错误
  expect(chat.input.value).toBe('');
  expect(chat.panelError.value).toBeNull();
});

test('reducer：failure 事件把助手消息标记为 failed 并保留可重试信息', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"type":"delta","delta":"写到一半"}\n\n',
      'data: {"type":"failure","failure":{"stage":"assistant.sse","gate":"stream","code":"sse_interrupted","severity":"recoverable","reason":"连接中断","recoverable":true,"retryPlan":"retry_same_stage"}}\n\n',
    ])) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  // send() 内部捕获异常并写入状态，不会向调用方抛错
  await chat.send(false, { content: 'hi' });
  await restoreFetch(savedFetch);
  const assistant = chat.messages.value[1];
  expect(assistant?.status).toBe('failed');
  expect(assistant?.streaming).toBeFalsy();
  expect(chat.panelError.value?.code).toBe('sse_interrupted');
  expect(chat.panelError.value?.recoverable).toBe(true);
});

test('reducer：用户主动停止后消息标记 cancelled 而非 failed', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    })) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  const pending = chat.send(false, { content: 'hi' });
  chat.stop();
  await pending;
  await restoreFetch(savedFetch);
  const assistant = chat.messages.value[1];
  expect(assistant?.status).toBe('cancelled');
  expect(chat.panelError.value).toBeNull();
});

test('reducer：失败后重试复用上次请求负载', async () => {
  const savedFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const failed = bodies.length === 1;
    return sseResponse(
      failed
        ? ['data: {"type":"failure","failure":{"stage":"assistant.planner","gate":"planner_schema","code":"planner_failed","severity":"recoverable","reason":"临时失败","recoverable":true}}\n\n']
        : [DONE_EVENT],
    );
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  await chat.send(false, { content: '规划第 2 章' });
  await chat.send(true);
  await restoreFetch(savedFetch);
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1] ?? '{}').content).toBe('规划第 2 章');
  // 重试不重复追加用户消息，只新增一条助手消息
  expect(chat.messages.value).toHaveLength(3);
  expect(chat.messages.value.at(-1)?.status).toBe('success');
});

test('reducer：同一毫秒内连续请求仍使用独立消息 ID，不串写失败与成功状态', async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  let requestCount = 0;
  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return sseResponse(
      requestCount === 1
        ? ['data: {"type":"failure","failure":{"stage":"assistant.planner","gate":"planner_schema","code":"planner_failed","severity":"recoverable","reason":"临时失败","recoverable":true}}\n\n']
        : [DONE_EVENT],
    );
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: '第一次请求' });
    await chat.send(false, { content: '第二次请求' });
  } finally {
    Date.now = savedNow;
    await restoreFetch(savedFetch);
  }

  const assistants = chat.messages.value.filter((message) => message.role === 'assistant');
  expect(assistants).toHaveLength(2);
  expect(new Set(assistants.map((message) => message.id)).size).toBe(2);
  expect(assistants[0]?.status).toBe('failed');
  expect(assistants[1]?.status).toBe('success');
});

test('明确章节命令：结构化章节号、续写方式、确认标记与目标字数', () => {
  expect(prepareAssistantRequest({
    content: '根据小说大纲，完善第十七章，补满2500字',
  })).toEqual({
    content: '根据小说大纲，完善第十七章，补满2500字',
    action: 'generate_chapter',
    chapterNumber: 17,
    confirmGeneration: true,
    continuationMode: 'append',
    targetWordCount: { min: 2500, max: 2750 },
  });
});

test('明确章节命令：覆盖重写使用 replace，普通项目查询保持原请求', () => {
  expect(prepareAssistantRequest({ content: '把第17章推倒重写为3000字' })).toEqual({
    content: '把第17章推倒重写为3000字',
    action: 'generate_chapter',
    chapterNumber: 17,
    confirmGeneration: true,
    continuationMode: 'replace',
    targetWordCount: { min: 3000, max: 3300 },
  });
  expect(prepareAssistantRequest({ content: '第17章里谁拿走了木心？' })).toEqual({
    content: '第17章里谁拿走了木心？',
  });
});

test('明确章节命令：send 自动发送结构化生成请求', async () => {
  const savedFetch = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([DONE_EVENT]);
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: '续写第17章到2500字' });
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(sent).toMatchObject({
    action: 'generate_chapter',
    chapterNumber: 17,
    confirmGeneration: true,
    continuationMode: 'append',
    targetWordCount: { min: 2500, max: 2750 },
  });
});

test('reducer：章节请求失败后可继续生成，并显式使用 append 模式', async () => {
  const savedFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    // Diagnostics use fetch too; only chapter requests count as retries.
    if (String(_url).endsWith('/client-errors')) return new Response('{}');
    bodies.push(String(init?.body));
    return sseResponse(
      bodies.length === 1
        ? ['data: {"type":"delta","delta":"已经写到这里"}\n\n']
        : [DONE_EVENT],
    );
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: '完善第十七章，补满2500字' });
    const failed = chat.messages.value[1];
    expect(failed?.status).toBe('failed');
    await chat.continueFromFailure(failed);
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(bodies).toHaveLength(2);
  const continuation = JSON.parse(bodies[1] ?? '{}') as {
    content?: string;
    continuationMode?: string;
  };
  expect(continuation.continuationMode).toBe('append');
  expect(continuation.content).toBe('完善第十七章，补满2500字');
  // 聊天流里的残片可能只是任务状态，不得混入章节创作要求。
  expect(continuation.content).not.toContain('已经写到这里');
  // 继续生成属于同一轮恢复，不重复追加一条用户消息。
  expect(chat.messages.value).toHaveLength(3);
  expect(chat.messages.value.at(-1)?.status).toBe('success');
});

test('pendingSteward 只对待确认方案返回 true', () => {
  const chat = useAssistantChat({ projectId: 1 });
  const pending = {
    id: 1,
    role: 'assistant',
    content: '',
    steward: {
      status: 'confirmation_required',
      reply: '',
      chapterNumber: 2,
      proposalId: 'p1',
      sourceVersion: 'v1',
      proposals: [],
      missing: [],
      proposalStatus: 'pending',
    },
  };
  const applied = {
    ...pending,
    steward: { ...pending.steward, proposalStatus: 'applied', generationJobId: 'job-9' },
  };
  const cancelled = { ...pending, steward: { ...pending.steward, proposalStatus: 'cancelled' } };
  expect(chat.pendingSteward(pending)).toBe(true);
  expect(chat.pendingSteward(applied)).toBe(false);
  expect(chat.pendingSteward(cancelled)).toBe(false);
  expect(chat.pendingSteward({ id: 2, role: 'assistant', content: 'x' })).toBe(false);
});

// ---------- 阶段三：Markdown 安全渲染契约 ----------

test('markdown：代码块渲染为带语言标签与复制按钮的结构，内容全部转义', () => {
  const html = renderMarkdown('```ts\nconst a = "<script>";\n```');
  expect(html).toContain('<div class="code-block">');
  expect(html).toContain('<span>ts</span>');
  expect(html).toContain(
    '<button type="button" class="code-copy" aria-label="复制代码">复制</button>',
  );
  expect(html).toContain('<code class="language-ts">');
  // 引号与尖括号必须转义，代码块内不允许出现裸 HTML
  expect(html).toContain('const a = &quot;&lt;script&gt;&quot;');
  expect(html).not.toContain('<script>');
});

test('markdown：未指定语言时标签为 text，代码块外 HTML 一律转义', () => {
  const html = renderMarkdown('正文 <img src=x onerror=alert(1)>\n```\n<div>\n```');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('<span>text</span>');
  expect(html).toContain('&lt;div&gt;');
  expect(html).not.toContain('<img');
});

test('markdown：javascript: 链接不生成 <a>，https 链接带 noopener，图片被移除', () => {
  const html = renderMarkdown(
    '点击 [正常](https://example.com/a) 与 [危险](javascript:alert(1)) ![图](https://e.com/i.png)',
  );
  expect(html).toContain(
    '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">正常</a>',
  );
  // 只允许出现一个 <a>（危险链接降级为纯文本），且协议不透出
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).not.toContain('javascript:');
  expect(html).toContain('危险');
  // 图片语法整体移除，不产生 img 节点
  expect(html).not.toContain('<img');
  expect(html).not.toContain('i.png');
});

test('markdown：GFM 子集（标题/列表/引用/行内代码/加粗）按预期渲染', () => {
  const html = renderMarkdown('# 标题\n- **加粗** 与 `代码`\n> 引用');
  expect(html).toContain('<h1>标题</h1>');
  expect(html).toContain('<ul><li><strong>加粗</strong> 与 <code>代码</code></li></ul>');
  expect(html).toContain('<blockquote>引用</blockquote>');
});

// ---------- 阶段三/四：重发、消息级失败卡片数据源 ----------

test('重新发送：以相同内容发起新对话轮次（追加用户消息），区别于重试', async () => {
  const savedFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return sseResponse([DONE_EVENT]);
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: '帮我规划第 5 章' });
    // AssistantWorkspace.resend 走 send(false, { content })：同内容新轮次
    await chat.send(false, { content: '帮我规划第 5 章' });
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(bodies).toHaveLength(2);
  expect(bodies.every((body) => JSON.parse(body).content === '帮我规划第 5 章')).toBe(true);
  // 每轮追加 user+assistant 共 4 条（重试 send(true) 只会有 3 条）
  expect(chat.messages.value).toHaveLength(4);
  expect(chat.messages.value.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(chat.messages.value.at(-1)?.status).toBe('success');
});

test('网络中断（流无 done 抛错）时消息级 failure 已赋值，供 FailureCard 显示', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(['data: {"type":"delta","delta":"写到一半"}\n\n'])) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: 'hi' });
  } finally {
    await restoreFetch(savedFetch);
  }
  const assistant = chat.messages.value[1];
  expect(assistant?.status).toBe('failed');
  expect(assistant?.failure?.code).toBe('sse_interrupted');
  expect(assistant?.failure?.recoverable).toBe(true);
  // 部分输出保留为证据，但绝不标记成功
  expect(assistant?.content).toBe('写到一半');
  expect(chat.panelError.value?.code).toBe('sse_interrupted');
});

// ---------- 阶段三：自动滚动门控（用户上滑不被打断） ----------

/** 构造按 delays（毫秒）分批到达的 SSE 流，用于模拟流式输出中途的用户交互。 */
function sseResponseDelayed(chunks: string[], delays: number[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      for (let index = 0; index < chunks.length; index++) {
        if (delays[index]) await new Promise((resolve) => setTimeout(resolve, delays[index]));
        controller.enqueue(encoder.encode(chunks[index]));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

test('滚动门控：流式期间用户上滑后 delta 不再跟随滚动，done 后仍回底', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponseDelayed(
      [
        'data: {"type":"delta","delta":"第一段"}\n\n',
        'data: {"type":"delta","delta":"第二段"}\n\n',
        DONE_EVENT,
      ],
      [0, 120, 400],
    )) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  const element = { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 } as HTMLElement;
  const pending = chat.send(false, { content: 'hi' }, element);
  try {
    // 第一个 delta 已处理（发送即滚底、atBottom=true）；此处模拟用户上滑阅读
    await new Promise((resolve) => setTimeout(resolve, 40));
    element.scrollTop = 100;
    chat.updateBottomState(element); // 距底 1500 > 48 -> atBottom=false
    expect(chat.atBottom.value).toBe(false);
    // 第二个 delta 在 120ms 到达：atBottom=false -> 不得拉回底部
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(element.scrollTop).toBe(100);
  } finally {
    await pending;
    await restoreFetch(savedFetch);
  }
  await nextTick();
  // done 事件无条件回底，状态完整
  expect(element.scrollTop).toBe(2000);
  expect(chat.messages.value.at(-1)?.status).toBe('success');
});

test('updateBottomState：距底 48px 内判定贴底，之外判定离开', () => {
  const chat = useAssistantChat({ projectId: 1 });
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 } as HTMLElement;
  chat.updateBottomState(element); // 距底 600
  expect(chat.atBottom.value).toBe(false);
  element.scrollTop = 580; // 距底 20 < 48
  chat.updateBottomState(element);
  expect(chat.atBottom.value).toBe(true);
  element.scrollTop = 540; // 距底 60 >= 48
  chat.updateBottomState(element);
  expect(chat.atBottom.value).toBe(false);
});

// ---------- P1 修复回归：脱敏扩充 / 逐条重试 / 历史卡片恢复 / 条件刷新 ----------

test('脱敏扩充：provider/模型名/token 值形态不透出，正常业务文案不误杀', () => {
  const generic = '操作失败，请稍后重试或按提示补全资料';
  expect(userFacingFailure('Gemini provider timeout, token=abc123')).toBe(generic);
  expect(userFacingFailure('glm 上游连接失败')).toBe(generic);
  expect(userFacingFailure('claude secret 泄漏')).toBe(generic);
  expect(userFacingFailure('Authorization: Bearer sk-abcdef123')).toBe(generic);
  // token 一词不带值形态（预算说明类文案）不得误杀
  expect(userFacingFailure('token 预算超限，请缩减上下文')).toBe('token 预算超限，请缩减上下文');
  expect(userFacingFailure('余额不足')).toBe('余额不足');
});

test('逐条重试：失败消息按自身 request 重发，不被后续轮次 lastPayload 覆盖', async () => {
  const savedFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    // 第 1 次（A）失败；第 2 次（B）与第 3 次（重试 A）成功
    const failed = bodies.length === 1;
    return sseResponse(
      failed
        ? ['data: {"type":"failure","failure":{"stage":"assistant.planner","gate":"planner_schema","code":"planner_failed","severity":"recoverable","reason":"临时失败","recoverable":true}}\n\n']
        : [DONE_EVENT],
    );
  }) as typeof fetch;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.send(false, { content: '规划第 1 章' }); // A 失败
    await chat.send(false, { content: '查询项目状态' }); // B 成功，lastPayload 已被 B 覆盖
    const failedA = chat.messages.value[1];
    expect(failedA?.status).toBe('failed');
    expect(failedA?.request?.content).toBe('规划第 1 章');
    // AssistantWorkspace.retry(message) 语义：优先 message.request，而非全局 lastPayload
    await chat.send(true, failedA?.request);
  } finally {
    await restoreFetch(savedFetch);
  }
  expect(bodies).toHaveLength(3);
  expect(JSON.parse(bodies[1] ?? '{}').content).toBe('查询项目状态');
  // 修复前此处会误发 B（lastPayload）；修复后必须重发 A 的原始请求
  expect(JSON.parse(bodies[2] ?? '{}').content).toBe('规划第 1 章');
});

test('load：历史消息恢复 metadata.artifacts，刷新页面后结构化卡片不丢失', async () => {
  const savedGet = http.get;
  http.get = (async () => ({
    data: [
      { id: 1, role: 'user', content: '保存大纲', createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: 2,
        role: 'assistant',
        content: '已保存',
        createdAt: '2026-01-01T00:00:01.000Z',
        metadata: {
          steward: {
            status: 'ready',
            reply: '',
            chapterNumber: 1,
            sourceVersion: 'v1',
            proposals: [],
            missing: [],
          },
          artifacts: { outlineSaved: true, focusTab: 'outline' },
        },
      },
      {
        id: 4,
        role: 'assistant',
        content: '已提交第 3 章生成任务',
        createdAt: '2026-01-01T00:00:02.000Z',
        metadata: {
          artifacts: { generationJobId: 'job-hist-1', chaptersTouched: [3] },
        },
      },
    ],
  })) as unknown as typeof http.get;
  const chat = useAssistantChat({ projectId: 1 });
  try {
    await chat.load();
  } finally {
    http.get = savedGet;
  }
  const assistant = chat.messages.value[1];
  expect(assistant?.status).toBe('success');
  expect(assistant?.artifacts?.outlineSaved).toBe(true);
  expect(assistant?.artifacts?.focusTab).toBe('outline');
  expect(assistant?.steward?.chapterNumber).toBe(1);
  // 历史生成任务：generationJobId + chaptersTouched 恢复后，消息级 GenerationRequestCard
  // （v-if="message.artifacts?.generationJobId"）在刷新后即可重新渲染
  const jobMessage = chat.messages.value[2];
  expect(jobMessage?.artifacts?.generationJobId).toBe('job-hist-1');
  expect(jobMessage?.artifacts?.chaptersTouched).toEqual([3]);
});

test('done 条件刷新：普通查询不刷新工作台，artifacts/生成任务才刷新', async () => {
  const savedFetch = globalThis.fetch;
  let reloadCount = 0;
  const chat = useAssistantChat({
    projectId: 1,
    reloadMaterials: async () => {
      reloadCount += 1;
    },
  });
  const doneWith = (payload: Record<string, unknown>): Response =>
    sseResponse([
      `data: ${JSON.stringify({
        type: 'done',
        done: true,
        message: { id: 8, role: 'assistant', content: '完成', createdAt: '2026-01-01T00:00:00.000Z' },
        ...payload,
      })}\n\n`,
    ]);
  try {
    // 普通 done（仅 contextManifest）：不刷新
    globalThis.fetch = (async () => sseResponse([DONE_EVENT])) as typeof fetch;
    await chat.send(false, { content: '查询项目' });
    expect(reloadCount).toBe(0);
    // done 携带空 artifacts 对象：同样视为无资料变化
    globalThis.fetch = (async () => doneWith({ artifacts: {} })) as typeof fetch;
    await chat.send(false, { content: '再查一次' });
    expect(reloadCount).toBe(0);
    // done 携带 artifacts：刷新一次
    globalThis.fetch = (async () =>
      doneWith({ artifacts: { outlineSaved: true, focusTab: 'outline' } })) as typeof fetch;
    await chat.send(false, { content: '保存大纲' });
    expect(reloadCount).toBe(1);
    // done 携带 generationJobId：刷新（artifacts 为空对象也不影响）
    globalThis.fetch = (async () => doneWith({ generationJobId: 'job-77', artifacts: {} })) as typeof fetch;
    await chat.send(false, { content: '生成第 4 章' });
    expect(reloadCount).toBe(2);
  } finally {
    await restoreFetch(savedFetch);
  }
});
