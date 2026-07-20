# EVAL: Claude 4.6 vs Gemini 3.1 Writer Selection

## Objective

Choose the production writer arrangement that maximizes chapter quality under the unified pipeline. Cost is recorded but is not an admission objective.

## Controlled Matrix

- Models: `claude-opus-4-6` and `gemini-3.1-pro-preview`.
- Scenes: suspense investigation, relationship cost, action decision cost.
- Strategies: ordinary `raw` and shared `oracle_scene` contract.
- Samples: three independent seeds per scene and strategy.
- Total: 18 paired comparisons, 36 chapter candidates.
- Entry: public `novel_generate_chapter` with `fullPipelinePreview=true`.
- Same ChapterContract and compiled-context hash are mandatory.
- Candidate fallback is forbidden; actual provider/model telemetry must match the requested writer.

## Grading

1. FactGuard veto is decisive and consumes no literary judge call.
2. Otherwise use gpt-5.6-sol anonymous pairwise judgment with reverse review.
3. Conflict, degraded judgment, missing reverse review, timeout, or provenance mismatch is inconclusive.
4. Reports store hashes and metrics, not duplicated chapter prose.

## Decisions

- Default switch to Gemini requires at least three decisive controlled samples in the same strategy and Gemini win rate `>= 0.55`.
- Claude remains default unless Gemini satisfies that threshold without a higher FactGuard-veto rate.
- A heterogeneous Gemini challenger is only a candidate for later production testing if Gemini wins at least one valid comparison and the unified pipeline can keep total editorial candidates at `0-2`, run FactGuard, and return Claude raw on tie/failure.
- Declaring either model at its quality ceiling additionally requires multi-chapter, human, and user-utility evidence.

## Regression Gates

- Production keeps one public chapter-generation entry.
- No comparison run writes chapter or narrative state.
- No reference text enters either generator.
- Existing Claude default and explicit Gemini selection remain fail-closed.
