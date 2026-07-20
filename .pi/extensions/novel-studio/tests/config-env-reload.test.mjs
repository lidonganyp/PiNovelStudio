/**
 * PiNovelStudio — P28 Task 6.1: config env reload 测试
 *
 * 验证：
 *   - reloadProjectEnv(true) 能覆盖 process.env 中已存在的旧值
 *   - reloadProjectEnv(false) 不覆盖已存在的 process.env 值
 *   - clearConfigCache() 清除 dotenvLoadedForRoot 缓存标记，让下次 reload 能重读
 *
 * 背景：P28 修复 .env 修改后章节生成进程读不到新 DOUBAO_MODEL/ARK_MODEL 的问题。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reloadProjectEnv,
  clearConfigCache,
  getProjectRoot,
  setProjectRoot,
} from "../dist/utils/config.js";

describe("P28 config env reload", () => {
  let tmpProjectRoot;
  let originalProjectRoot;
  const savedEnv = {};

  before(() => {
    originalProjectRoot = getProjectRoot();
    tmpProjectRoot = mkdtempSync(join(tmpdir(), "p28-env-reload-"));
    // 创建项目标记，让 findProjectRoot(tmpProjectRoot) 能识别 tmpProjectRoot 为项目根
    // 历史：曾需用此标记对抗 DEFAULT_DEPLOYMENT_ROOT 硬编码抢占；该硬编码已在生产内核瘦身 Step 1a 移除。
    // 标记文件名需与 utils/config.ts:isProjectRoot 检查的真相源文档保持一致
    // （HISTORY-RETIREMENT-1 删除旧设计文档后，isProjectRoot 改为检查 top-tier-chinese-novel-system-development-plan.md）
    mkdirSync(join(tmpProjectRoot, ".pi", "extensions", "novel-studio"), { recursive: true });
    mkdirSync(join(tmpProjectRoot, "docs"), { recursive: true });
    writeFileSync(
      join(tmpProjectRoot, "docs", "top-tier-chinese-novel-system-development-plan.md"),
      "# test placeholder"
    );
    // 保存要操作的 env 键（含 PINOVEL_PROJECT_ROOT，用于强制 resolveProjectRoot 优先级 1 命中 tmpProjectRoot）
    for (const key of ["DOUBAO_MODEL", "ARK_MODEL", "PINOVEL_RHYTHM_ADAPTER", "PINOVEL_PROJECT_ROOT"]) {
      savedEnv[key] = process.env[key];
    }
    // 显式指定项目根（优先级 1），确保测试在 tmpProjectRoot 隔离运行
    process.env.PINOVEL_PROJECT_ROOT = tmpProjectRoot;
    setProjectRoot(tmpProjectRoot);
  });

  after(() => {
    setProjectRoot(originalProjectRoot);
    clearConfigCache();
    // 恢复 env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (existsSync(tmpProjectRoot)) {
      rmSync(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it("reloadProjectEnv(true) 覆盖 process.env 中已存在的旧值", () => {
    // 设置旧值
    process.env.DOUBAO_MODEL = "old-model-turbo";
    // 写入新 .env
    writeFileSync(join(tmpProjectRoot, ".env"), "DOUBAO_MODEL=doubao-seed-2-1-pro-260628\n", "utf-8");
    // 强制重读并覆盖
    reloadProjectEnv(true);
    assert.equal(
      process.env.DOUBAO_MODEL,
      "doubao-seed-2-1-pro-260628",
      "reloadProjectEnv(true) 应覆盖旧值 doubao-seed-2-1-pro-260628"
    );
  });

  it("reloadProjectEnv(false) 不覆盖已存在的 process.env 值", () => {
    process.env.ARK_MODEL = "existing-ark-value";
    writeFileSync(join(tmpProjectRoot, ".env"), "ARK_MODEL=should-not-override\n", "utf-8");
    reloadProjectEnv(false);
    assert.equal(
      process.env.ARK_MODEL,
      "existing-ark-value",
      "reloadProjectEnv(false) 不应覆盖已存在的值"
    );
  });

  it("clearConfigCache 后 reload 能重读最新 .env 内容", () => {
    // 第一次写入
    writeFileSync(join(tmpProjectRoot, ".env"), "PINOVEL_RHYTHM_ADAPTER=doubao\n", "utf-8");
    reloadProjectEnv(true);
    assert.equal(process.env.PINOVEL_RHYTHM_ADAPTER, "doubao");
    // 修改 .env 内容
    writeFileSync(join(tmpProjectRoot, ".env"), "PINOVEL_RHYTHM_ADAPTER=claude\n", "utf-8");
    // 不清缓存直接 reload(true) 也应重读（reloadProjectEnv 内部调 clearConfigCache）
    reloadProjectEnv(true);
    assert.equal(
      process.env.PINOVEL_RHYTHM_ADAPTER,
      "claude",
      "reloadProjectEnv(true) 应重读到修改后的值"
    );
  });
});
