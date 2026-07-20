# EVAL: Claude Bounded Best-of-3

## Objective

Measure whether a second distinct scene-solution candidate adds repeatable quality beyond the admitted production baseline of Claude raw plus at most one opportunity-driven scene candidate.

## Runtime Contract

- Entry: public `novel_generate_chapter` only.
- Opt-in: `boundedBestOf3=true`; default remains `false`.
- Layout: one Claude raw baseline plus at most two Claude scene-solution candidates with distinct modes.
- Trigger: no cited editorial opportunity means zero scene candidates.
- Protection: candidate FactGuard, final completeness, heterogeneous gpt-5.6-sol pairwise judgment, reverse review, and raw fallback remain mandatory.
- Isolation: `fullPipelinePreview=true` writes no chapter, state, trace, or learning outcome.
- Reports retain hashes and gate outcomes, never chapter prose.

## Admission Gate

Default production activation requires all of the following:

1. At least three controlled search-depth comparisons.
2. The second scene candidate wins at least two comparisons.
3. Zero final-gate vetoes on selected outputs.
4. Distinct scene modes, matching context/contract, and complete provenance in every counted comparison.
5. No regression in factual consistency, continuity, template repetition, or user revision burden.

## Real Results

- Eight search-depth attempts completed across six sanitized reports.
- Two suspense attempts met the controlled three-candidate condition. Raw was selected in both; second-candidate wins were `0`; final-gate vetoes were `0`.
- Six attempts were excluded because the opportunity judge found no cited opportunity, fewer than three candidates were produced, or a provider call failed. Successful earlier candidates were preserved when a later candidate failed.

Aggregate controlled evidence: `2` comparisons, `0` second-candidate wins, `0` final-gate vetoes. Repeated incremental gain is not established. Status: `explicit_opt_in_unadmitted`.

Latest controlled evidence: `reports/model-comparison/claude-bounded-best-of3/claude-best-of3-suspense-retry-20260720/comparison-report.json`, SHA-256 `406BAFC6055D162E5459E2E953DC90B0100E7B55BF08B8B88DC5B7D6C8A50E05`.
