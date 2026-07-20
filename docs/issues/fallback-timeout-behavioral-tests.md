# Issue: Fallback 总超时行为级测试

**优先级**: P2  
**状态**: Closed  
**创建日期**: 2026-06-21  
**关闭日期**: 2026-06-21  
**关联**: PR #gate-fixes 验收遗留项

## 问题描述

`totalTimeoutMs` 已加入 `APIFallbackManager` 并在 provider/retry 前检查。原测试只复制超时判断片段并测试这段副本，没有导入或调用生产 `APIFallbackManager`，因此不能证明 fallback 链路真实受总超时保护。

## 修复内容

- `tests/fallback-timeout-behavioral.test.mjs` 现在导入 `../dist/api/fallback-manager.js` 中的 `APIFallbackManager`
- 测试通过 mock `loadFallbackContext()` 和 `makeOpenAIChatCall()` 走生产 `callWithFallback()` 循环
- 测试隔离 `GLM_API_KEY`、`GPT_API_KEY`、`GLM_MODEL`、`GPT_MODEL`，避免本机 `.env` 污染 mock 断言

## 验收覆盖

1. 慢主 provider 消耗 `totalTimeoutMs` 后抛出 `Fallback chain timeout`
2. 超时后不再尝试后续 fallback provider
3. 主 provider 在预算内成功时不误触发超时
4. 未配置 `totalTimeoutMs` 时仍允许 fallback provider 成功接管

## 验证命令

```bash
cd .pi/extensions/novel-studio
npm run build
node --test tests/fallback-timeout-behavioral.test.mjs
```

当前结果：3 个行为测试全部通过。
