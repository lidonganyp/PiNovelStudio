# Production cleanup baseline

Date: 2026-08-19

This checkout is aligned to the single production baseline. The production
entry remains `novel_generate_chapter` and the active release is `rel-prod-139`.

## Retained

- `config/model-routing.json`, `config/quality-gates.json`, and the runtime
  capability package data.
- `.pi/extensions/novel-studio/` production source and release-governance code.
- The current production identity and pointer for `rel-prod-139`.
- Production workspaces (`xinmo`, `fuben`, and `linmo`) and the two user-owned
  in-progress report sets.
- The production data-pipeline scripts and the canonical production documents.

## Removed from the checkout

- Historical release registries and rollback journals before `rel-prod-139`.
- Replay, A/B, ablation, calibration, NovelBench, and concurrency report
  artifacts.
- Generated evaluation workspaces, scratch archives, local IDE artifacts, and
  manual deletion folders.
- Root-level frontend/backend residue and one-sample routing recommendations.
- Non-production provider and comparison variables from `.env.example`.

The removed local artifacts were moved outside the repository to
`D:\\CODE\\PiNovelStudio-cleanup-20260819` for recoverability. They are not
part of the Git commit or production runtime.
