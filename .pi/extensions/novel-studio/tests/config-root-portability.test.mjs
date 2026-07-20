/**
 * PiNovelStudio — 生产内核瘦身 Step 1a：项目根可移植性测试
 *
 * 验证 resolveProjectRoot 不再依赖硬编码 DEFAULT_DEPLOYMENT_ROOT="D:\CODE\PiNovelStudio"：
 *   - candidate 指向临时项目根时，返回该临时根（而非硬编码部署路径）
 *   - PINOVEL_PROJECT_ROOT env 优先级最高
 *   - candidate 指向无标记子目录时向上查找命中最近项目根
 *   - 绝不回退到硬编码部署路径
 *
 * 背景：审计发现 config.ts 曾硬编码 DEFAULT_DEPLOYMENT_ROOT 并以高于 candidate/cwd
 * 的优先级检查它，导致干净 clone 在别处运行时跨检出污染原始仓库 workspace。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveProjectRoot,
  getProjectRoot,
  setProjectRoot,
} from "../dist/utils/config.js";

const HARDCODED_PATH = "D:\\CODE\\PiNovelStudio";

describe("config root portability (Step 1a)", () => {
  let tmpProjectRoot;
  let originalProjectRoot;
  const savedEnv = {};

  before(() => {
    originalProjectRoot = getProjectRoot();
    tmpProjectRoot = mkdtempSync(join(tmpdir(), "pns-portability-"));
    // 建项目标记，让 findProjectRoot 能识别 tmpProjectRoot 为项目根
    // 标记文件名需与 utils/config.ts:isProjectRoot 检查的真相源文档保持一致
    // （HISTORY-RETIREMENT-1 删除旧设计文档后，isProjectRoot 改为检查 top-tier-chinese-novel-system-development-plan.md）
    mkdirSync(join(tmpProjectRoot, ".pi", "extensions", "novel-studio"), { recursive: true });
    mkdirSync(join(tmpProjectRoot, "docs"), { recursive: true });
    writeFileSync(
      join(tmpProjectRoot, "docs", "top-tier-chinese-novel-system-development-plan.md"),
      "# test placeholder"
    );
    savedEnv.PINOVEL_PROJECT_ROOT = process.env.PINOVEL_PROJECT_ROOT;
    delete process.env.PINOVEL_PROJECT_ROOT;
  });

  after(() => {
    setProjectRoot(originalProjectRoot);
    if (savedEnv.PINOVEL_PROJECT_ROOT === undefined) {
      delete process.env.PINOVEL_PROJECT_ROOT;
    } else {
      process.env.PINOVEL_PROJECT_ROOT = savedEnv.PINOVEL_PROJECT_ROOT;
    }
    if (existsSync(tmpProjectRoot)) {
      rmSync(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it("resolveProjectRoot(candidate) 返回 candidate 临时项目根，绝不返回硬编码部署路径", () => {
    const resolved = resolveProjectRoot(tmpProjectRoot);
    assert.equal(
      resolved,
      tmpProjectRoot,
      "应解析到传入的临时项目根"
    );
    assert.notEqual(
      resolved,
      HARDCODED_PATH,
      "不得回退到硬编码部署路径（跨检出污染 bug 不得回归）"
    );
  });

  it("PINOVEL_PROJECT_ROOT env 优先级最高，覆盖 candidate 与缓存", () => {
    process.env.PINOVEL_PROJECT_ROOT = tmpProjectRoot;
    try {
      // 故意传一个不存在的 candidate，验证 env 优先于 candidate
      const resolved = resolveProjectRoot("/nonexistent/path/that/should/not/exist");
      assert.equal(resolved, tmpProjectRoot);
    } finally {
      delete process.env.PINOVEL_PROJECT_ROOT;
    }
  });

  it("setProjectRoot 后 getProjectRoot 返回该临时根（缓存生效）", () => {
    setProjectRoot(tmpProjectRoot);
    assert.equal(getProjectRoot(), tmpProjectRoot);
  });

  it("candidate 指向无项目标记的子目录时向上查找命中最近项目根", () => {
    // 在 tmpProjectRoot 下建深层子目录，findProjectRoot 应向上走到 tmpProjectRoot
    const subDir = join(tmpProjectRoot, "sub", "deep", "dir");
    mkdirSync(subDir, { recursive: true });
    const resolved = resolveProjectRoot(subDir);
    assert.equal(resolved, tmpProjectRoot, "向上查找应命中 tmpProjectRoot");
    assert.notEqual(resolved, HARDCODED_PATH);
  });

  it("多个独立临时项目根互不串扰（模拟多 worktree / 临时 clone）", () => {
    const tmpB = mkdtempSync(join(tmpdir(), "pns-portability-b-"));
    try {
      mkdirSync(join(tmpB, ".pi", "extensions", "novel-studio"), { recursive: true });
      mkdirSync(join(tmpB, "docs"), { recursive: true });
      writeFileSync(join(tmpB, "docs", "top-tier-chinese-novel-system-development-plan.md"), "# b");
      const resolvedA = resolveProjectRoot(tmpProjectRoot);
      const resolvedB = resolveProjectRoot(tmpB);
      assert.equal(resolvedA, tmpProjectRoot, "临时项目 A 解析到自身");
      assert.equal(resolvedB, tmpB, "临时项目 B 解析到自身");
      assert.notEqual(resolvedA, resolvedB, "两个独立 clone 不得串扰");
    } finally {
      if (existsSync(tmpB)) rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
