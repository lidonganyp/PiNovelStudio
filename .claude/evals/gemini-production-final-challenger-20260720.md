# EVAL: Gemini Production-Final Challenger

## Objective

Measure whether a Gemini 3.1 Pro challenger adds quality after the current Claude Opus 4.6 production pipeline has already completed opportunity detection, scene-solution candidate generation, internal judging, and final selection.

This eval corrects a limitation of the earlier writer matrix: `qualityExperiment` intentionally returned after raw FactGuard, so that matrix compared isolated writer outputs rather than production-selected final outputs.

## Controlled Design

- Baseline: Claude `writerModel=claude`, public `novel_generate_chapter`, `fullPipelinePreview=true`.
- Challenger: Gemini `writerModel=gemini31`, the same public entry and preview contract.
- Neither call may contain `qualityExperiment` or `evalMode`.
- Both runs must expose the same ChapterContract and compiled-context hash.
- Both runs must expose `positiveGainCandidates`, proving that the production opportunity/candidate path was reached.
- Candidate count remains raw plus at most two editorial candidates.
- Final selected text must pass final FactGuard and final-text completeness.
- gpt-5.6-sol performs anonymous pairwise judgment and reverse review on the two production-selected finals.
- Reports retain hashes and metrics, never chapter prose or raw diagnostic spans.

## Scoped Admission

A scene-specific Gemini challenger is eligible only when all conditions hold in that scene:

1. At least three controlled comparisons complete.
2. Gemini has at least two reverse-consistent wins and more wins than Claude.
3. At least one Gemini win is literary, with a valid Claude baseline; recovery-only wins do not qualify.
4. Gemini has zero final FactGuard or completeness vetoes.
5. Contract, context, route provenance, preview isolation, and candidate-count checks all pass.

Admission permits only an opportunity-driven challenger occupying one of the existing 0-2 editorial candidate slots. It does not permit global dual writing, fallback, or a default model switch.

## Regression Gates

- One public chapter-generation entry remains.
- Preview runs write no chapter or narrative state.
- Claude remains the raw baseline and fallback.
- Judge failure, conflict, or missing reverse review returns no incremental winner.
- The old raw-isolated writer matrix remains reproducible and is not reinterpreted as production-final evidence.

## Real Results (2026-07-20)

The post-fix cross-scene production-final runs all completed with workspace isolation and sanitized reports:

- Relationship cost: controlled, inconclusive; Gemini literary wins `0`.
- Suspense investigation: controlled, inconclusive; Gemini literary wins `0`.
- Action decision cost: Gemini passed after Claude raw FactGuard veto; this is recovery-only, not a literary win.

Aggregate: `3` controlled comparisons, `0` Gemini literary wins, `1` Gemini recovery-only win, `2` inconclusive. No scene met scoped admission. Claude remains the default writer; Gemini remains an explicit `writerModel=gemini31` option. Automatic dual writing, fallback, and candidate-slot wiring remain disabled.

The internal `v2_literary_judge` now uses SSE and completed in three consecutive real production-final runs. Tail latency remains high, so transport completion does not by itself satisfy production reliability or quality admission.

Evidence:

- `literary-judge-streaming-long-budget-20260720`: SHA-256 `0DB9288A28AEBB8B83AF023D2877BD71C59DDC7F4B69B5B81EC521FB0EFC8562`
- `streaming-cross-scene-suspense-20260720`: SHA-256 `40BEEDF75144A8CE3F513B975DA540C6AAA03D1D24F386EFA0BF3615F2D3BA81`
- `streaming-cross-scene-action-20260720`: SHA-256 `23A31AAD4B343841DB95AA138B18C4EB8FC6D32623466A0390C3118830B91371`
