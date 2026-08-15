# CONCURRENCY-WAVE6 live 双 workspace 并发回放

- 记录时间：2026-08-15T07:15:08.723Z
- gitHash：3a748a0
- 生产准入：否
- DEV_MODE：1
- 源 workspace：xinmo（只读复制）
- 隔离副本：concurrency-live-a ch23 / concurrency-live-b ch23
- 总耗时：194.1s
- A：status=ok chapter=true state=ch23
- B：status=ok chapter=true state=ch23
- 首次成功率：1.00
- 未分类失败：0
- 整体：PASS

两个进程同时调用生产 `novel_generate_chapter`（Gemini 3.1 Pro Preview）。未写入生产 xinmo。
隔离副本无法复现 active_prod 指纹，因此 DEV_MODE=1；不得据此宣布生产完成。
