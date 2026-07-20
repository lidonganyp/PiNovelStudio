# EVAL: Gemini Quality Amplifier v2

## Objective

Maximize Chinese-fiction quality around Gemini 3.1 Pro while treating explicit human literary preference as the highest-ranking model-selection evidence.

## Capability Evals

1. Undefined `writerModel` resolves to Gemini raw/editorial routes with `fallback=[]`.
2. Gemini uses `gemini_writer_v2`, preserving native Chinese flow, novel voice, character presence, and scene immersion without turning the ChapterContract into visible explanation.
3. Pairwise judge output contains an independent reader-experience verdict for native Chinese, novel voice, scene immersion, character presence, and continuation desire.
4. Machine model rankings cannot select a default when the human-alignment gate fails; the explicit human winner remains authoritative.
5. Search-depth can run Gemini through public `novel_generate_chapter` and records the actual writer model in sanitized reports.

## Regression Evals

1. Claude remains an explicit isolated writer option.
2. GPT remains the heterogeneous opportunity/pairwise judge and never becomes a prose fallback.
3. Reference text remains evaluator-only.
4. FactGuard, completeness, reverse review, raw fallback, state isolation, and one public chapter entry remain intact.
5. Gemini amplification does not enable automatic Claude+Gemini dual writing.

## Human Gold

- Source: controlled saved suspense pair, same ChapterContract/context and public read-only generation path.
- Human winner: Gemini 3.1 Pro.
- Decisive dimensions: Chinese native feel, novel voice, scene immersion.
- GPT-5.6-sol forward/reverse result: Claude; alignment failed even after reader-priority prompt guidance.
- Policy: machine comparisons are diagnostic until the natural-human alignment gate passes; they cannot override the explicit human writer choice.

## Admission

- `gemini_writer_v2` may become the default expression profile after deterministic prompt/route tests pass.
- Gemini bounded best-of-3 remains evidence-driven. It becomes default only after repeated controlled second-candidate wins with no final-gate vetoes and subsequent human/continuity confirmation.
