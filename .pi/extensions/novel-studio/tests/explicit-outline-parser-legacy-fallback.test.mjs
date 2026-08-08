/**
 * Regression coverage for pre-existing explicit outlines that express the
 * event contract through 必须包含 / 事件结果 instead of 内容摘要.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExplicitOutline } from "../dist/craft/explicit-outline-parser.js";

test("legacy explicit outline uses event contract text as summary fallback", () => {
  const parsed = parseExplicitOutline(`
## 事件 1：准入区
- **参与角色**：林觉、老周
- **必须包含**：林觉拿着纸条进入准入区，老周完成首次嘲讽。

## 事件 2：封闭房间
- **参与角色**：林觉、老周
- **事件结果**：三人进入封闭房间。
`);

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.events.length, 2);
  assert.match(parsed.events[0].summary ?? "", /林觉拿着纸条进入准入区/);
  assert.match(parsed.events[1].summary ?? "", /三人进入封闭房间/);
});
