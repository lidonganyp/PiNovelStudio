# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PiNovelStudio is an AI-driven **Chinese webnovel chapter generation system** built as a PI (AI Coding Agent) extension. The PI agent orchestrates; a "Writer's Room" multi-agent architecture executes; 100+ top webnovels are mined as a quality moat. The product goal: under the same model + same context + similar token budget, the system must deliver prose measurably better than the model's raw free generation.

The extension lives at `.pi/extensions/novel-studio/` (an npm workspace). All TypeScript source is there. `workspaces/{id}/` holds per-novel data, `scripts/` holds Python data-pipeline + Node eval/replay tooling.

## Commands

All commands run from the extension workspace unless noted. From repo root, the npm scripts proxy through (`npm run build`, `npm test`, etc.).

```bash
cd .pi/extensions/novel-studio

npm run build          # builds ALL 3 targets: prod (dist/) + eval (dist-eval/) + test (dist-test/)
npm run build:prod     # tsconfig.prod.json -> dist/      (production entry closure only)
npm run build:eval     # tsconfig.eval.json  -> dist-eval/ (NovelBench + eval-only modules)
npm run build:test     # tsconfig.test.json  -> dist-test/ (test-only craft/agents/v2 modules)

npm test               # node --import ./tests/setup-test-env.mjs --test tests/*.test.mjs
npm run test:fresh     # npm run build && npm test  (use after editing TS source)
npm run smoke          # runs only tests/phase5-unified-default-path.test.mjs
npm run typecheck      # tsc --noEmit

# Run a single test (must build first — tests import compiled JS from dist*/):
node --import ./tests/setup-test-env.mjs --test tests/candidate-comparator.test.mjs
```

**Tests import from `dist/`, `dist-eval/`, and `dist-test/` (compiled JS), not from `.ts` source.** After editing any TypeScript, run `npm run build` (or `npm run test:fresh`) before tests will pick up changes. There are ~386 test files using Node's built-in `node:test` runner.

Python data pipeline (from repo root): `python scripts/run-pipeline.py --all`, or individual steps (`extract-style.py`, `extract-scenes.py`, `mine-techniques.py`, `build-fewshots.py`, `contrastive-distill.py`).

## Architecture: Production / Eval / Test Isolation (the critical thing to understand)

The codebase has completed the migration from a legacy Stage0-8 chain to a single unified main pipeline. The legacy chain is **physically deleted** (`LEGACY-RUNTIME-REMOVAL-1`). Three tsconfigs isolate three build targets — do not cross this boundary:

- **Production entry — `index.ts` (~85 lines):** registers only **6 public tools** and routes `novel_generate_chapter` to the **unified main pipeline** (`v2/core/`). Compiled by `tsconfig.prod.json` → `dist/`. Imports **zero** legacy modules. `tests/dependency-boundary.test.mjs` automatically fails if production code pulls in legacy or eval-only modules.
- **Eval target — `tsconfig.eval.json` → `dist-eval/`:** NovelBench (`novelbench/`) and eval-only modules. Never imported by `dist/`.
- **Test target — `tsconfig.test.json` → `dist-test/`:** test-only craft/agents/v2 modules (barrel `test/test-modules.ts`). Loaded by `tests/setup-test-env.mjs` only.

The legacy Stage0-8 chain is **deleted**, not dormant. Its "stages 0→8 must run in order" rule is **revoked**. Positive-value legacy assets (Chinese naturalness, continuity, state management, foreshadowing, model routing/circuit-breaking/trace/atomic-save) have been migrated into the unified pipeline.

## The Unified Main Pipeline (production path)

`novel_generate_chapter` → `handlers/public-handlers.ts:handleGenerateChapter` → `v2/core/unified-entry.ts:runUnifiedPipeline` → `v2/core/unified-orchestrator.ts`. Flow:

```
Preflight → ContextCompiler → ChapterIntentBuilder → Raw candidate
→ FactGuard → EditorialOpportunity → EditorialCandidate (0-2)
→ PairwiseJudge (anonymous A/B, span-constrained, reverse-reviewable)
→ SelectionPolicy → SpanRepair → FinalFactRecheck → FinalStateCommit → AtomicSave + Trace
```

Core design rules (from `docs/top-tier-chinese-novel-system-development-plan.md` §2, the architecture truth source):
- **Opportunity-driven, not fixed multi-candidate:** generate raw first; only spawn 0-2 editorial candidates when a provable, span-cited edit opportunity exists. Never fixed 4-5 variants.
- **LLM pairwise judge decides literary winner.** The mechanical `CandidateComparator` is demoted to fact-check / risk evidence / regression veto — never decides winner by score totals.
- **raw is the internal baseline and safe fallback.** If no editorial candidate clearly wins, deliver raw. Never deliver text worse than raw. No silent legacy fallback.
- **Long-term narrative state (4 kinds: CanonState / CharacterState / PromiseLedger / PatternMemory) is only committed after the final text is selected** — staged during candidate generation, committed post-selection.
- **Per-model strategy reputation:** a contextual bandit (Thompson Sampling) adjusts editorial-strategy call probability; old-model experience does not constrain new-model capability. See `v2/learning/`.

## Truth Sources (when docs disagree, these win)

1. `docs/top-tier-chinese-novel-system-development-plan.md` (v1.1) — authoritative architecture & migration baseline. Supersedes the older `quality_amplifier_v2` and Stage0-8 designs.
2. `config/model-routing.json` — **sole** source of truth for model routing. The routing table in `AGENTS.md` is a human-readable summary; on conflict, the JSON wins.
3. `AGENTS.md` — PI project instructions; much of it is now labeled legacy/migration-reference. Read the "目标架构：统一主链路" section at the top for current authoritative constraints.

## The 6 Public Tools (`tools/register-tools.ts`)

`novel_generate_chapter` (unified pipeline, only chapter entry), `novel_preflight_workspace` (local pre-checks, no model calls), `novel_workspace_manager`, `novel_plan_story_outline` (high-level background only — explicit per-chapter outlines are deprecated), `novel_strategy_policy_view`, `novel_strategy_feedback` (Phase 6 online learning).

## Hard Constraints (still enforced)

- ⛔ `novel_generate_chapter` is the **only** public entry for chapter generation. `novel_narrator` / `novel_critic` are internal stage agents — never call them directly to produce prose.
- ⛔ **AI must never directly write chapter prose.** All prose comes through unified orchestration.
- ⛔ No silent degrade: every Stage/Gate failure produces a structured `FailureEnvelope` (stage/gate/severity/reason/evidence/recoverable/retryPlan) written to `workspaces/{id}/traces/{chapterId}-quality-trace.json`.
- ⛔ `PatchQualityComparator` is the sole patch authority — a rejected patch never overwrites the original text.
- The old `legacy | quality_amplifier_v2` dual-mode, chapter whitelist, and `generationMode` config are **removed**. `PINOVEL_UNIFIED_PIPELINE` exists only as a test-infrastructure flag, not a production rollback switch.

## Environment

`.env` lives at repo root. **PI does not auto-load `.env`** — `index.ts` manually parses it into `process.env` (only sets keys not already present). Key variables:

- Model API keys + base URLs: `GLM_*`, `DEEPSEEK_*`, `QWEN_*`, `CLAUDE_*`, `GPT_*`, `ARK_*` (Doubao), `ERNIE_*`.
- `V2_FORCE_STUB=1` — unified pipeline uses a stub model (no real API calls); for tests.
- `PINOVEL_MODEL_REQUEST_TIMEOUT_MS` (default 300000) — bounded per-request timeout; all model calls must honor it, no unbounded waits.
- `NOVEL_TEST_TOOLS` / `NOVEL_DEBUG_TOOLS` — retained as test-infrastructure flags only (set by `tests/setup-test-env.mjs`); they no longer gate any production tool registration since the legacy lab tools were deleted. **Never** set in production.

## Workspace Layout (`workspaces/{workspaceId}/`)

One workspace per novel. Key contents: `config.json` (genre/subGenres/characters/worldKeyTerms), `CORE-WRITING-PRINCIPLES.md` + `WORLDBUILDING-CANON.md` (supreme-authority constitution, priority above style fingerprints and automated gates), `series/outline.md` (optional high-level background — **not** a generation prerequisite), `series/ch{N}-outline-explicit.md` (optional; presence triggers the `stage2_explicit_outline_coverage` gate), `chapters/`, `traces/{chapterId}-quality-trace.json`, `narrative-state-store.json`, `strategy-policy.json` (Phase 6 reputation store), `styles/`, `characters/`.

Write-before-input is a `ChapterSeed` + perception anchors, **not** a chapter outline. Chapter outlines (章纲) are a post-write skeleton summary, not a pre-write blueprint.

## Code Conventions (from AGENTS.md)

- TypeScript ES Modules (`import/export`), strict types on all params and return values.
- Class-first core logic with exported factory functions `createXxx()`; errors handled with try-catch (no uncaught exceptions); every file has a module header comment.
- Model routing decisions go in `config/model-routing.json`, not hardcoded.
- Atomic file saves use temp-file → rename; chapter save is the transaction boundary — post-chapter state maintenance runs only after a successful save.

## CodeGraph

A local code-knowledge-graph MCP server is configured (`.codex/config.toml`). For "how does X work" / "what calls X" / architecture questions, prefer `codegraph_*` MCP tools (or `npx @colbymchenry/codegraph <command>`) over grep+Read re-derivation. Use grep/Read for searching text content (logs, comments) or reading known file regions.
