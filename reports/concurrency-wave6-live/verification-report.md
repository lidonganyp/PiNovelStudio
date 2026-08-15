# CONCURRENCY-WAVE6 live 双 workspace 并发回放

- 记录时间：2026-08-15T07:41:46.767Z
- gitHash：0f6cef8
- 生产准入：否
- DEV_MODE：1
- 源 workspace：xinmo（只读复制）
- 隔离副本：concurrency-live-a ch23 / concurrency-live-b ch23
- 总耗时：259.4s
- A：status=ok ok=true chapter=true bytes=9564 state=ch23
- B：status=ok ok=true chapter=true bytes=5959 state=ch23
- 整体：PASS

两个进程同时调用生产 `novel_generate_chapter`。未写入生产 xinmo。
隔离副本无法复现 active_prod 指纹，因此 DEV_MODE=1；不得据此宣布生产完成。
