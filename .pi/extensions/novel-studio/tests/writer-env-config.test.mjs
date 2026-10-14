/** The default writer identity and single OpenAI-compatible transport follow .env. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const keys = ['GEMINI_MODEL', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY',
  'GEMINI_AIMAGICHUB_BASE_URL', 'GEMINI_AIMAGICHUB_API_KEY',
  'SUB2API_INTERNAL_LLM_BASE_URL', 'SUB2API_INTERNAL_LLM_API_KEY', 'PINOVEL_MODEL_MAX_RETRIES'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.GEMINI_MODEL = 'gemini-configured-next';
process.env.GOOGLE_GEMINI_BASE_URL = 'https://writer.example/v1';
process.env.GEMINI_API_KEY = 'test-writer-key';
const config = await import('../dist/utils/config.js');
const { resolveWriterRoutes, resolveRunRouting } = await import('../dist/v2/core/run-routing-context.js');
const { resolveWriterModelRouteLock } = await import('../dist/v2/core/unified-entry.js');
const { defaultAdapterRegistry } = await import('../dist/novelos/protocol/adapter-registry.js');
const { authorizedWriterFallbackRoutes } = await import('../dist/v2/adapters/legacy-model-route-adapter.js');
const { createAPIFallbackManager, clearUnhealthyProviders, runWithWriterRunConfig } = await import('../dist/api/fallback-manager.js');

test('one model setting drives routes, locks, and protocol identity', async () => {
  try {
    for (const model of ['gemini-configured-next', 'gemini-configured-future']) {
      process.env.GEMINI_MODEL = model;
      config.clearConfigCache();
      const routing = config.loadModelRoutingSync();
      for (const route of ['narrator_primary', 'v2_rawstage2_gemini31', 'v2_amplified_gemini31']) {
        assert.equal(routing.agent_routing[route].model, model, route);
        assert.equal((await config.getAgentModelConfig(route)).model, model);
      }
      assert.equal(resolveWriterRoutes().model, model);
      assert.equal(resolveWriterModelRouteLock().model, model);
      assert.equal(resolveRunRouting({}).model, model);
      assert.equal(defaultAdapterRegistry.getRouteConfig('v2_rawstage2_gemini31').capabilityKey.model, model);
    }
  } finally { config.clearConfigCache(); }
});

test('single channel has no peer fallback and obsolete channel env cannot override .env settings', async () => {
  const fetchBefore = globalThis.fetch;
  try {
    // WRITER-ENV-UNIFY-1 回归：旧 Sub2API 网关变量残留（SUB2API_INTERNAL_LLM_*）与
    // 废弃渠道变量（GEMINI_AIMAGICHUB_*）同时存在时，不得劫持统一 writer 渠道
    // （P1-2：物理删除网关覆写分支后，残留环境只走 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL）
    process.env.SUB2API_INTERNAL_LLM_BASE_URL = 'https://obsolete-gateway.example/v1';
    process.env.SUB2API_INTERNAL_LLM_API_KEY = 'obsolete-gateway-key';
    process.env.GEMINI_AIMAGICHUB_BASE_URL = 'https://obsolete.example/v1';
    process.env.GEMINI_AIMAGICHUB_API_KEY = 'obsolete-key';
    config.clearConfigCache();
    const routing = config.loadModelRoutingSync();
    assert.equal(routing.agent_routing.v2_rawstage2_gemini31_solov, undefined);
    assert.deepEqual(authorizedWriterFallbackRoutes('v2_rawstage2_gemini31'), []);
    assert.deepEqual(authorizedWriterFallbackRoutes('v2_amplified_gemini31'), []);
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ model: process.env.GEMINI_MODEL,
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    for (const url of ['https://writer.example/v1', 'https://replacement.example/v1']) {
      process.env.GOOGLE_GEMINI_BASE_URL = url;
      for (const route of ['v2_rawstage2_gemini31', 'v2_amplified_gemini31']) {
        const output = await createAPIFallbackManager({ maxRetries: 0 }).callWithFallback(route,
          [{ role: 'user', content: '只回复 OK' }], { max_tokens: 32 });
        assert.equal(output.usedModel, process.env.GEMINI_MODEL);
        assert.equal(calls.at(-1).url, `${url}/chat/completions`);
        assert.equal(calls.at(-1).body.model, process.env.GEMINI_MODEL);
        assert.equal(calls.at(-1).headers.Authorization, 'Bearer test-writer-key');
      }
    }
  } finally {
    globalThis.fetch = fetchBefore;
    clearUnhealthyProviders();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    config.clearConfigCache();
  }
});

// ============================================================================
// WRITER-ENV-UNIFY-1：临时项目根 .env 行为（缺配置 / 重载生效 / 无效 URL / 指纹变化）
// ============================================================================

// 真实路由 JSON 原文（临时根的 config/model-routing.json 需要同一份真相源）
const routingRawSource = readFileSync(
  resolve(process.cwd(), '../../../config/model-routing.json'),
  'utf-8',
);

function makeTempProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pinovel-env-root-'));
  // 根识别标记（findProjectRoot 需要这两个路径）
  mkdirSync(join(root, '.pi', 'extensions', 'novel-studio'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'top-tier-chinese-novel-system-development-plan.md'), '# temp\n', 'utf-8');
  // loadModelRoutingSync / loadGlobalConfig 需要路由与门禁配置
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'model-routing.json'), routingRawSource, 'utf-8');
  writeFileSync(join(root, 'config', 'quality-gates.json'), '{}\n', 'utf-8');
  return root;
}

test('missing GEMINI_MODEL in .env fails closed with an explicit error', () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const root = makeTempProjectRoot();
  try {
    // .env 有地址与密钥但没有 GEMINI_MODEL → 明确报错，不静默用旧模型
    writeFileSync(join(root, '.env'),
      'GOOGLE_GEMINI_BASE_URL=https://writer.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    process.env.PINOVEL_PROJECT_ROOT = root;
    delete process.env.GEMINI_MODEL;
    config.clearConfigCache();
    assert.throws(() => config.getGeminiWriterModel(), /GEMINI_MODEL is required in \.env/);
    assert.throws(() => config.loadModelRoutingSync(), /GEMINI_MODEL is required in \.env/);
  } finally {
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing the project .env takes effect after reloadProjectEnv', () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const savedUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const root = makeTempProjectRoot();
  try {
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-reload-first\nGOOGLE_GEMINI_BASE_URL=https://first.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    process.env.PINOVEL_PROJECT_ROOT = root;
    delete process.env.GEMINI_MODEL;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    config.clearConfigCache();
    config.reloadProjectEnv();
    assert.equal(config.getGeminiWriterModel(), 'env-reload-first');
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://first.example/v1');

    // 真实修改临时 .env 文件后重载：新模型与新地址生效（换模型/地址不需要改代码）
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-reload-second\nGOOGLE_GEMINI_BASE_URL=https://second.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    config.reloadProjectEnv();
    assert.equal(config.getGeminiWriterModel(), 'env-reload-second');
    assert.equal(config.getBaseUrl('gemini31', 'https://fallback.example/v1'), 'https://second.example/v1');
    const routing = config.loadModelRoutingSync();
    assert.equal(routing.agent_routing.v2_rawstage2_gemini31.model, 'env-reload-second');
  } finally {
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    if (savedUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedUrl;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid GOOGLE_GEMINI_BASE_URL fails closed during placeholder resolution', () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const savedUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const root = makeTempProjectRoot();
  try {
    // 非 HTTP(S) 协议
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-invalid-url\nGOOGLE_GEMINI_BASE_URL=ftp://writer.example\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    process.env.PINOVEL_PROJECT_ROOT = root;
    delete process.env.GEMINI_MODEL;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    config.clearConfigCache();
    config.reloadProjectEnv();
    assert.throws(
      () => config.loadModelRoutingSync(),
      /GOOGLE_GEMINI_BASE_URL must be an HTTP\(S\) API URL without credentials/,
    );

    // 携带凭证的 URL 同样拒绝（不得把用户名密码写进 base URL）
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-invalid-url\nGOOGLE_GEMINI_BASE_URL=https://user:secret@writer.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    config.reloadProjectEnv();
    assert.throws(
      () => config.loadModelRoutingSync(),
      /GOOGLE_GEMINI_BASE_URL must be an HTTP\(S\) API URL without credentials/,
    );
  } finally {
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    if (savedUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedUrl;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('model and base URL changes alter the release fingerprint', async () => {
  const { computeFingerprintHash, diffBehavioralFingerprintFields } = await import(
    '../dist/v2/governance/environment-fingerprint.js'
  );
  const base = {
    codeCommit: 'c1',
    worktreeDirty: false,
    runtimeFilesHash: 'r1',
    buildArtifactHash: 'b1',
    modelRoutingHash: 'm1',
    promptBundleHash: 'p1',
    toolSchemaHash: 't1',
    generationModel: 'model-a',
    generationBaseUrl: 'https://a.example/v1',
    judgeModel: 'j1',
    proxyApprovalModel: 'pa1',
    activeStrategyIds: [],
    constitutionHash: 'cc1',
    datasetHash: 'd1',
    evalProtocolHash: 'e1',
    seed: 0,
    budgetMaxCalls: 10,
    timeoutMs: 1000,
    fallbackPolicy: 'hard_block',
    envSwitches: [],
  };

  const baseline = computeFingerprintHash(base);
  // 模型变化 → 发布指纹变化
  assert.notEqual(computeFingerprintHash({ ...base, generationModel: 'model-b' }), baseline);
  // 地址变化 → 发布指纹变化
  assert.notEqual(
    computeFingerprintHash({ ...base, generationBaseUrl: 'https://b.example/v1' }),
    baseline,
  );
  // 地址从有到无 → 发布指纹变化（undefined 与空串可区分）
  assert.notEqual(
    computeFingerprintHash({ ...base, generationBaseUrl: undefined }),
    baseline,
  );
  // 完全一致 → 指纹稳定
  assert.equal(computeFingerprintHash({ ...base }), baseline);

  // 差异比较逐字段报告模型与地址漂移
  const diffs = diffBehavioralFingerprintFields(base, {
    ...base,
    generationModel: 'model-b',
    generationBaseUrl: 'https://b.example/v1',
  });
  const fields = diffs.map((diff) => diff.field);
  assert.ok(fields.includes('generationModel'));
  assert.ok(fields.includes('generationBaseUrl'));
  assert.deepEqual(
    diffs.find((diff) => diff.field === 'generationBaseUrl'),
    { field: 'generationBaseUrl', recorded: 'https://a.example/v1', actual: 'https://b.example/v1' },
  );
});

// ============================================================================
// WRITER-ENV-RUN-FREEZE-2：任务级 writer 运行配置（AsyncLocalStorage 隔离）
// —— 模型、地址、密钥三者一起冻结；并发任务互不覆盖、互不清除
// ============================================================================

function makeCapturingFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: process.env.GEMINI_MODEL,
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('per-run writer config isolates nested runs and freezes model, URL, and key together', async () => {
  const fetchBefore = globalThis.fetch;
  try {
    process.env.GEMINI_MODEL = 'outer-model';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://outer.example/v1';
    process.env.GEMINI_API_KEY = 'outer-key';
    config.clearConfigCache();
    const calls = [];
    globalThis.fetch = makeCapturingFetch(calls);
    const callWriter = (tag) => createAPIFallbackManager({ maxRetries: 0 }).callWithFallback(
      'v2_rawstage2_gemini31',
      [{ role: 'user', content: `只回复 OK ${tag}` }],
      { max_tokens: 32 },
    );

    await runWithWriterRunConfig(
      { provider: 'gemini31', baseUrl: 'https://a.example/v1', apiKey: 'key-a', model: 'model-a' },
      async () => {
        // 任务 A 内嵌任务 B（模拟并发/子任务）：B 的请求走 B 的模型、地址与密钥
        await runWithWriterRunConfig(
          { provider: 'gemini31', baseUrl: 'https://b.example/v1', apiKey: 'key-b', model: 'model-b' },
          async () => {
            // B 期间修改环境变量：不影响 B（快照冻结），也不影响外层 A
            process.env.GOOGLE_GEMINI_BASE_URL = 'https://env-changed.example/v1';
            process.env.GEMINI_API_KEY = 'env-key';
            process.env.GEMINI_MODEL = 'env-model';
            await callWriter('B');
            assert.equal(calls.at(-1).url, 'https://b.example/v1/chat/completions');
            assert.equal(calls.at(-1).headers.Authorization, 'Bearer key-b');
            assert.equal(calls.at(-1).body.model, 'model-b');
          },
        );
        // B 结束后（无全局 clear），A 的后续请求仍走 A 的快照——不被 B 覆盖或清除
        await callWriter('A-after-B');
        assert.equal(calls.at(-1).url, 'https://a.example/v1/chat/completions');
        assert.equal(calls.at(-1).headers.Authorization, 'Bearer key-a');
        assert.equal(calls.at(-1).body.model, 'model-a');
      },
    );
    // A 结束后（上下文自动回收，无需 clear）：恢复动态解析，使用当前 env 值
    await callWriter('after-A');
    assert.equal(calls.at(-1).url, 'https://env-changed.example/v1/chat/completions');
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer env-key');
    assert.equal(calls.at(-1).body.model, 'env-model');
  } finally {
    globalThis.fetch = fetchBefore;
    clearUnhealthyProviders();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    config.clearConfigCache();
  }
});

test('a failing sibling run does not disturb the enclosing run config', async () => {
  const fetchBefore = globalThis.fetch;
  try {
    process.env.GEMINI_MODEL = 'outer-model';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://outer.example/v1';
    process.env.GEMINI_API_KEY = 'outer-key';
    config.clearConfigCache();
    const calls = [];
    globalThis.fetch = makeCapturingFetch(calls);

    await runWithWriterRunConfig(
      { provider: 'gemini31', baseUrl: 'https://a.example/v1', apiKey: 'key-a', model: 'model-a' },
      async () => {
        // 任务 B 异常结束（前置阻断 / 异常路径）：不得影响 A 的快照
        await assert.rejects(
          runWithWriterRunConfig(
            { provider: 'gemini31', baseUrl: 'https://b.example/v1', apiKey: 'key-b', model: 'model-b' },
            async () => {
              throw new Error('task B failed');
            },
          ),
          /task B failed/,
        );
        // B 失败后 A 继续请求：仍走 A 的快照（模型、地址、密钥均未被破坏）
        await createAPIFallbackManager({ maxRetries: 0 }).callWithFallback(
          'v2_rawstage2_gemini31',
          [{ role: 'user', content: '只回复 OK A-after-B-failure' }],
          { max_tokens: 32 },
        );
        assert.equal(calls.at(-1).url, 'https://a.example/v1/chat/completions');
        assert.equal(calls.at(-1).headers.Authorization, 'Bearer key-a');
        assert.equal(calls.at(-1).body.model, 'model-a');
      },
    );
  } finally {
    globalThis.fetch = fetchBefore;
    clearUnhealthyProviders();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    config.clearConfigCache();
  }
});

test('changing GEMINI_MODEL mid-run keeps the current run on the frozen model', async () => {
  const fetchBefore = globalThis.fetch;
  try {
    process.env.GEMINI_MODEL = 'frozen-model';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://frozen.example/v1';
    process.env.GEMINI_API_KEY = 'frozen-key';
    config.clearConfigCache();
    const calls = [];
    globalThis.fetch = makeCapturingFetch(calls);
    const callWriter = () => createAPIFallbackManager({ maxRetries: 0 }).callWithFallback(
      'v2_rawstage2_gemini31',
      [{ role: 'user', content: '只回复 OK' }],
      { max_tokens: 32 },
    );

    // 任务开始：首阶段请求使用快照模型 frozen-model
    await runWithWriterRunConfig(
      { provider: 'gemini31', baseUrl: 'https://frozen.example/v1', apiKey: 'frozen-key', model: 'frozen-model' },
      async () => {
        await callWriter();
        assert.equal(calls.at(-1).body.model, 'frozen-model');
        // 运行中修改 GEMINI_MODEL：后续阶段仍请求旧（快照）模型
        process.env.GEMINI_MODEL = 'midrun-model';
        await callWriter();
        assert.equal(calls.at(-1).body.model, 'frozen-model');
        assert.equal(calls.at(-1).url, 'https://frozen.example/v1/chat/completions');
        assert.equal(calls.at(-1).headers.Authorization, 'Bearer frozen-key');
      },
    );
    // 当前任务结束后：下一任务才使用新 env 模型
    await callWriter();
    assert.equal(calls.at(-1).body.model, 'midrun-model');
  } finally {
    globalThis.fetch = fetchBefore;
    clearUnhealthyProviders();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    config.clearConfigCache();
  }
});

// ============================================================================
// WRITER-ENV-RELOAD-1：删除 .env 变量后重载清除旧值残留（fail-closed 广义语义）
// ============================================================================

test('removing a variable from the project .env clears its stale value after reloadProjectEnv', () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const savedUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const root = makeTempProjectRoot();
  try {
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-stale-first\nGOOGLE_GEMINI_BASE_URL=https://stale-first.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    process.env.PINOVEL_PROJECT_ROOT = root;
    delete process.env.GEMINI_MODEL;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    config.clearConfigCache();
    config.reloadProjectEnv();
    assert.equal(config.getGeminiWriterModel(), 'env-stale-first');
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://stale-first.example/v1');

    // 从 .env 删除 GEMINI_MODEL 后重载：旧值不得残留（不得静默沿用 env-stale-first）
    writeFileSync(join(root, '.env'),
      'GOOGLE_GEMINI_BASE_URL=https://stale-second.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    config.reloadProjectEnv();
    assert.equal(process.env.GEMINI_MODEL, undefined);
    assert.throws(() => config.getGeminiWriterModel(), /GEMINI_MODEL is required in \.env/);
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://stale-second.example/v1');

    // .env 整体删除后重载：该 root 的全部文件拥有 key 一并清除
    rmSync(join(root, '.env'));
    config.reloadProjectEnv();
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, undefined);
  } finally {
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    if (savedUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedUrl;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// WRITER-ENV-RELOAD-2：非覆盖重载不得误删文件仍声明的变量
// ============================================================================

test('non-overriding reload keeps variables that are still declared in the project .env', () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const savedUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const root = makeTempProjectRoot();
  try {
    writeFileSync(join(root, '.env'),
      'GEMINI_MODEL=env-reload-first\nGOOGLE_GEMINI_BASE_URL=https://first.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    process.env.PINOVEL_PROJECT_ROOT = root;
    delete process.env.GEMINI_MODEL;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    config.clearConfigCache();
    // 覆盖重载：三个 key 全部写入并进入文件拥有台账
    config.reloadProjectEnv();
    assert.equal(config.getGeminiWriterModel(), 'env-reload-first');
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://first.example/v1');

    // 同一未修改文件 reload(false)：文件仍声明全部 key，不得误删
    // （旧缺陷：GEMINI_MODEL 因"本次未实际写入"被判定为文件已删除而遭清除）
    config.reloadProjectEnv(false);
    assert.equal(config.getGeminiWriterModel(), 'env-reload-first');
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://first.example/v1');
    assert.equal(process.env.GEMINI_API_KEY, 'temp-key');

    // 文件不再声明 GEMINI_MODEL 后 reload(false)：旧值仍正确清除（删除判定看声明）；
    // 仍声明的 GOOGLE_GEMINI_BASE_URL 在非覆盖模式下保持旧值（不覆盖、也不误删）
    writeFileSync(join(root, '.env'),
      'GOOGLE_GEMINI_BASE_URL=https://second.example/v1\nGEMINI_API_KEY=temp-key\n', 'utf-8');
    config.reloadProjectEnv(false);
    assert.equal(process.env.GEMINI_MODEL, undefined);
    assert.throws(() => config.getGeminiWriterModel(), /GEMINI_MODEL is required in \.env/);
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://first.example/v1');

    // 覆盖重载后新地址生效（仍声明 → 保留并可更新）
    config.reloadProjectEnv();
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'https://second.example/v1');
  } finally {
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    if (savedUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedUrl;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P1-1 容器部署场景：镜像不含 .env，统一入口注入 process.env 三变量
// ============================================================================

test('container-style deployment without a root .env runs on injected process env', async () => {
  const savedRoot = process.env.PINOVEL_PROJECT_ROOT;
  const savedModel = process.env.GEMINI_MODEL;
  const savedUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const savedKey = process.env.GEMINI_API_KEY;
  const fetchBefore = globalThis.fetch;
  const root = makeTempProjectRoot();
  try {
    // 容器场景：镜像不含 .env（.dockerignore 排除），部署注入三变量
    process.env.PINOVEL_PROJECT_ROOT = root;
    process.env.GEMINI_MODEL = 'container-model';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://container-writer.example/v1';
    process.env.GEMINI_API_KEY = 'container-key';
    config.clearConfigCache();
    assert.equal(config.getGeminiWriterModel(), 'container-model');
    const routing = config.loadModelRoutingSync();
    assert.equal(routing.agent_routing.v2_rawstage2_gemini31.model, 'container-model');

    const calls = [];
    globalThis.fetch = makeCapturingFetch(calls);
    await createAPIFallbackManager({ maxRetries: 0 }).callWithFallback('v2_rawstage2_gemini31',
      [{ role: 'user', content: '只回复 OK' }], { max_tokens: 32 });
    assert.equal(calls.at(-1).url, 'https://container-writer.example/v1/chat/completions');
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer container-key');
    assert.equal(calls.at(-1).body.model, 'container-model');

    // 注入缺失 GEMINI_MODEL → fail-closed（不静默沿用旧模型）
    delete process.env.GEMINI_MODEL;
    config.clearConfigCache();
    assert.throws(() => config.getGeminiWriterModel(), /GEMINI_MODEL is required in \.env/);
  } finally {
    globalThis.fetch = fetchBefore;
    clearUnhealthyProviders();
    if (savedRoot === undefined) delete process.env.PINOVEL_PROJECT_ROOT;
    else process.env.PINOVEL_PROJECT_ROOT = savedRoot;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
    if (savedUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    config.clearConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});
