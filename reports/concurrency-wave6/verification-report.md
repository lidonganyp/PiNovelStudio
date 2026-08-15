# CONCURRENCY-WAVE6 并发 replay 归档

- 记录时间：2026-08-15T07:42:12.922Z
- 生产准入：否
- 场景通过：4/4
- gitHash：4b3aa9755c51966df9c4c3ff4bc4f383bf5603ed
- 首次成功率：1
- 冲突场景通过率：1
- 测得自动恢复成功率：1（目标 ≥ 0.85，达标=true）
- 未分类失败：0
- 双正式提交者 / 重复正式提交 / stale 越过 / 不明 lock 写入 / 并发覆盖：0/0/0/0/0

## 场景

- PASS `two_workspaces_two_jobs_parallel` (71ms)
- PASS `same_workspace_two_jobs_lock` (1010ms)
- PASS `dual_candidate_single_commit_slot` (881ms)
- PASS `focused_wave5_wave6_tests`

## 说明

本报告覆盖计划 §6 中可用 mock 复现的并发互斥、CAS、提交槽、命令幂等和崩溃分类。
未把 live Gemini 双 workspace 长篇生成写入本归档，因此不得据此宣布生产完成。
