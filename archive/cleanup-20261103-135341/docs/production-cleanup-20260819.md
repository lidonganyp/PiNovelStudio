# Production cleanup baseline

Date: 2026-08-19

This document is a historical cleanup record, not a live production pointer.
The production entry remains `novel_generate_chapter`; the live registry must
be checked with `evolution:status`. At the latest audit, the registry pointed
to `rel-prod-134`, while the current checkout was not reproducible against
that release and `rel-prod-145` remained `approved_dev`.

## Retained

- `config/model-routing.json`, `config/quality-gates.json`, and the runtime
  capability package data.
- `.pi/extensions/novel-studio/` production source and release-governance code.
- The production identity pack is deployment state and must be supplied by the
  deployment environment; it is not inferred from this historical document.
- Production workspaces (`xinmo`, `fuben`, and `linmo`) and the two user-owned
  in-progress report sets.
- The production data-pipeline scripts and the canonical production documents.

## Removed from the checkout

- Historical release registries and rollback journals are not evidence of the
  current production pointer.
- Replay, A/B, ablation, calibration, NovelBench, and concurrency report
  artifacts.
- Generated evaluation workspaces, scratch archives, local IDE artifacts, and
  manual deletion folders.
- Root-level frontend/backend residue and one-sample routing recommendations.
- Non-production provider and comparison variables from `.env.example`.

The removed local artifacts were moved outside the repository to
`D:\\CODE\\PiNovelStudio-cleanup-20260819` for recoverability. They are not
part of the Git commit or production runtime.
