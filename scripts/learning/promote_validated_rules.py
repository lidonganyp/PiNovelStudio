"""
PiNovelStudio — Promote validated craft rules from replay evidence.

Reads replay benchmark JSON files, aggregates candidate rule wins/losses, and
writes two runtime artifacts:

- data/runtime/candidate-rules.json
- data/runtime/validated-craft-rules.json
"""

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCENE_ALIASES = {
    "daily": "daily_life",
    "daily_life": "daily_life",
    "slice_of_life": "daily_life",
    "scheme": "confrontation",
    "confrontation": "confrontation",
    "faction_conflict": "confrontation",
    "gamble": "confrontation",
    "conflict": "confrontation",
    "combat": "combat",
    "action": "combat",
    "breakthrough": "breakthrough",
    "revelation": "breakthrough",
    "cliffhanger": "breakthrough",
    "romance": "romance",
    "general": "general",
}


@dataclass
class RuleEvidence:
    source: str = "replay_benchmark"
    sampleSize: int = 0
    wins: int = 0
    losses: int = 0
    winRate: float = 0.0
    validatedWinRate: float | None = None
    lastValidatedAt: str = ""
    benchmarkIds: list[str] = field(default_factory=list)


@dataclass
class RuntimeRule:
    id: str
    sceneType: str
    appliesWhen: list[str]
    craftMove: str
    mustDo: list[str]
    avoid: list[str]
    microExample: str | None
    evidence: RuleEvidence
    distilledFrom: dict[str, Any] | None = None


@dataclass
class RuntimeRuleFile:
    schemaVersion: int
    generatedAt: str
    entries: list[dict[str, Any]]


@dataclass
class RuleAccumulator:
    rule: dict[str, Any]
    benchmark_outcomes: dict[str, bool] = field(default_factory=dict)

    def add_sample(self, benchmark_id: str, candidate_wins: bool) -> None:
        if benchmark_id in self.benchmark_outcomes:
            self.benchmark_outcomes[benchmark_id] = self.benchmark_outcomes[benchmark_id] and candidate_wins
            return
        self.benchmark_outcomes[benchmark_id] = candidate_wins

    @property
    def wins(self) -> int:
        return len([outcome for outcome in self.benchmark_outcomes.values() if outcome])

    @property
    def losses(self) -> int:
        return len([outcome for outcome in self.benchmark_outcomes.values() if not outcome])

    @property
    def benchmark_ids(self) -> set[str]:
        return set(self.benchmark_outcomes)

    @property
    def sample_size(self) -> int:
        return len(self.benchmark_outcomes)

    @property
    def win_rate(self) -> float:
        if self.sample_size == 0:
            return 0.0
        return round(self.wins / self.sample_size, 4)


def read_json(path: Path) -> dict[str, Any] | list[Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_scene_type(scene_type: Any) -> str:
    raw = str(scene_type or "general").strip().lower()
    return SCENE_ALIASES.get(raw, raw or "general")


def to_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return unique_strings([str(item).strip() for item in value if str(item).strip()])
    if isinstance(value, str):
        pieces = [item.strip() for item in re.split(r"[、,;；\n]", value) if item.strip()]
        return unique_strings(pieces)
    return []


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = re.sub(r"\s+", "", value).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def as_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def is_replay_benchmark(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return (
        isinstance(value.get("benchmarkId"), str)
        and isinstance(value.get("candidateWins"), bool)
        and isinstance(value.get("scores"), dict)
        and isinstance(value.get("metadata"), dict)
    )


def load_benchmark_files(benchmark_dir: Path) -> list[Path]:
    if benchmark_dir.is_file():
        parsed = read_json(benchmark_dir)
        if is_replay_benchmark(parsed):
            return [benchmark_dir]
        raise ValueError(f"Expected a replay benchmark JSON file: {benchmark_dir}")

    benchmark_files: list[Path] = []
    for path in sorted(path for path in benchmark_dir.rglob("*.json") if path.is_file()):
        parsed = read_json(path)
        if is_replay_benchmark(parsed):
            benchmark_files.append(path)
    return benchmark_files


def has_orchestrator_proof(benchmark: dict[str, Any]) -> bool:
    metadata = benchmark.get("metadata")
    if not isinstance(metadata, dict):
        return False

    values: list[Any] = [
        metadata.get("generatedBy"),
        metadata.get("generated_by"),
        metadata.get("generationTool"),
        metadata.get("generation_tool"),
        metadata.get("orchestrator"),
    ]
    candidate = metadata.get("candidate")
    if isinstance(candidate, dict):
        values.extend(
            [
                candidate.get("generatedBy"),
                candidate.get("generated_by"),
                candidate.get("generationTool"),
                candidate.get("generation_tool"),
            ]
        )

    return any(str(value).strip() == "novel_generate_chapter" for value in values if value is not None)


def candidate_result_path(benchmark: dict[str, Any]) -> str | None:
    metadata = benchmark.get("metadata")
    if not isinstance(metadata, dict):
        return None

    candidate = metadata.get("candidate")
    if isinstance(candidate, dict):
        value = as_string(candidate.get("resultPath")) or as_string(candidate.get("result_path"))
        if value:
            return value
    return as_string(metadata.get("resultPath")) or as_string(metadata.get("result_path"))


def resolve_candidate_result_path(raw_path: str, benchmark_path: Path) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path

    candidates = [
        Path.cwd() / path,
        benchmark_path.parent / path,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def has_successful_generation_result(benchmark: dict[str, Any], benchmark_path: Path) -> bool:
    raw_path = candidate_result_path(benchmark)
    if raw_path is None:
        return True

    parsed = read_json(resolve_candidate_result_path(raw_path, benchmark_path))
    if not isinstance(parsed, dict):
        return False
    status = as_string(parsed.get("status"))
    # Matches audit_quality_evolution.py — both must accept the same
    # generation result statuses so audit and promotion consume the same
    # replay benchmarks. When the status is present at the generate-result
    # JSON it must be one of the recognised completion states; omitting
    # resultPath (None) means "no result to check" and is treated as ok.
    # P0: completed_with_review 需要人工复核，不能自动视为成功
    # 但可复核的 anti-AI 修复结果仍然有效
    if status in {"success", "passed", "complete", "completed"}:
        return True
    return is_reviewable_anti_ai_generation_result(parsed)


def is_reviewable_anti_ai_generation_result(parsed: dict[str, Any] | None) -> bool:
    """检查是否为可复核的 anti-AI 修复结果（与 run_replay_benchmark.py 保持一致）"""
    if not isinstance(parsed, dict):
        return False
    stage_results = parsed.get("stageResults")
    if not isinstance(stage_results, dict):
        return False
    stage8 = stage_results.get("stage8")
    if not isinstance(stage8, dict):
        return False
    # 检查是否有 repairable anti-AI route
    anti_ai = stage8.get("antiAI")
    if isinstance(anti_ai, dict) and as_string(anti_ai.get("routeGate")) == "anti_ai_repairable":
        if not anti_ai.get("shouldRequestUpstreamRewrite"):
            return True
    anti_ai_routes = stage8.get("antiAIRoutes")
    if isinstance(anti_ai_routes, list):
        for entry in anti_ai_routes:
            if isinstance(entry, dict) and as_string(entry.get("gate")) == "anti_ai_repairable":
                if not entry.get("shouldRequestUpstreamRewrite"):
                    return True
    return False


def require_orchestrator_proven_files(benchmark_files: list[Path]) -> list[Path]:
    invalid_files: list[str] = []
    for path in benchmark_files:
        parsed = read_json(path)
        if (
            not isinstance(parsed, dict)
            or not has_orchestrator_proof(parsed)
            or not has_successful_generation_result(parsed, path)
        ):
            invalid_files.append(str(path))

    if invalid_files:
        sample = ", ".join(invalid_files[:5])
        remaining = len(invalid_files) - 5
        suffix = f", and {remaining} more" if remaining > 0 else ""
        raise ValueError(
            "Every replay benchmark used for rule promotion must prove the candidate came from "
            "novel_generate_chapter and any referenced generation result must be successful. "
            f"Missing usable proof in: {sample}{suffix}"
        )

    return benchmark_files


def normalize_rule(raw_rule: dict[str, Any], fallback_index: int) -> dict[str, Any] | None:
    rule_id = as_string(raw_rule.get("id")) or f"candidate-rule-{fallback_index + 1}"
    craft_move = as_string(raw_rule.get("craftMove")) or as_string(raw_rule.get("rule"))
    if not craft_move:
        return None

    normalized: dict[str, Any] = {
        "id": rule_id,
        "sceneType": normalize_scene_type(raw_rule.get("sceneType") or raw_rule.get("scene_type")),
        "appliesWhen": to_string_list(raw_rule.get("appliesWhen"))
        + to_string_list(raw_rule.get("applicable_when")),
        "craftMove": craft_move,
        "mustDo": unique_strings(to_string_list(raw_rule.get("mustDo")) + [craft_move]),
        "avoid": unique_strings(
            to_string_list(raw_rule.get("avoid"))
            + to_string_list(raw_rule.get("avoid_when"))
            + to_string_list(raw_rule.get("anti_pattern"))
        ),
        "microExample": as_string(raw_rule.get("microExample")) or as_string(raw_rule.get("micro_example")),
    }
    # Preserve distilledFrom provenance so candidate/validated outputs link
    # back to GetDraft archive sources for audit and traceability.
    distilled_from = raw_rule.get("distilledFrom")
    if isinstance(distilled_from, dict):
        normalized["distilledFrom"] = distilled_from
    return normalized


def aggregate_rules(benchmark_files: list[Path]) -> dict[str, RuleAccumulator]:
    accumulators: dict[str, RuleAccumulator] = {}
    fallback_index = 0

    for path in benchmark_files:
        parsed = read_json(path)
        if not isinstance(parsed, dict):
            continue

        benchmark_id = as_string(parsed.get("benchmarkId")) or path.stem
        candidate_wins = bool(parsed.get("candidateWins"))
        raw_rules = parsed.get("candidateRules", [])
        if not isinstance(raw_rules, list):
            continue

        for raw_rule in raw_rules:
            if not isinstance(raw_rule, dict):
                continue
            normalized = normalize_rule(raw_rule, fallback_index)
            fallback_index += 1
            if normalized is None:
                continue

            rule_id = normalized["id"]
            if rule_id not in accumulators:
                accumulators[rule_id] = RuleAccumulator(rule=normalized)
            accumulators[rule_id].add_sample(benchmark_id, candidate_wins)

    return accumulators


def build_runtime_rule(accumulator: RuleAccumulator, generated_at: str, validated: bool) -> RuntimeRule:
    evidence = RuleEvidence(
        sampleSize=accumulator.sample_size,
        wins=accumulator.wins,
        losses=accumulator.losses,
        winRate=accumulator.win_rate,
        validatedWinRate=accumulator.win_rate if validated else None,
        lastValidatedAt=generated_at,
        benchmarkIds=sorted(accumulator.benchmark_ids),
    )

    return RuntimeRule(
        id=accumulator.rule["id"],
        sceneType=accumulator.rule["sceneType"],
        appliesWhen=unique_strings(accumulator.rule["appliesWhen"]),
        craftMove=accumulator.rule["craftMove"],
        mustDo=unique_strings(accumulator.rule["mustDo"]),
        avoid=unique_strings(accumulator.rule["avoid"]),
        microExample=accumulator.rule["microExample"],
        evidence=evidence,
        distilledFrom=accumulator.rule.get("distilledFrom"),
    )


def clean_rule_dict(rule: RuntimeRule) -> dict[str, Any]:
    data = asdict(rule)
    evidence = data["evidence"]
    if evidence.get("validatedWinRate") is None:
        evidence.pop("validatedWinRate", None)
    if data.get("microExample") is None:
        data.pop("microExample", None)
    if data.get("distilledFrom") is None:
        data.pop("distilledFrom", None)
    return data


def promote_rules(
    benchmark_dir: Path,
    runtime_dir: Path,
    min_samples: int,
    min_win_rate: float,
) -> tuple[RuntimeRuleFile, RuntimeRuleFile]:
    generated_at = datetime.now(timezone.utc).isoformat()
    benchmark_files = load_benchmark_files(benchmark_dir)
    if not benchmark_files:
        raise ValueError(
            "No replay benchmark JSON files found. Rule promotion requires benchmark-shaped "
            "reference/candidate reports with novel_generate_chapter proof; skipped reports and "
            "audit summaries are not promotion evidence."
        )
    benchmark_files = require_orchestrator_proven_files(benchmark_files)
    accumulators = aggregate_rules(benchmark_files)
    sorted_accumulators = sorted(
        accumulators.values(),
        key=lambda item: (item.win_rate, item.sample_size, item.rule["id"]),
        reverse=True,
    )

    candidate_entries: list[dict[str, Any]] = []
    validated_entries: list[dict[str, Any]] = []

    for accumulator in sorted_accumulators:
        is_validated = accumulator.sample_size >= min_samples and accumulator.win_rate >= min_win_rate
        candidate_entries.append(clean_rule_dict(build_runtime_rule(accumulator, generated_at, validated=False)))
        if is_validated:
            validated_entries.append(clean_rule_dict(build_runtime_rule(accumulator, generated_at, validated=True)))

    candidate_file = RuntimeRuleFile(schemaVersion=1, generatedAt=generated_at, entries=candidate_entries)
    validated_file = RuntimeRuleFile(schemaVersion=1, generatedAt=generated_at, entries=validated_entries)

    write_json(runtime_dir / "candidate-rules.json", asdict(candidate_file))
    write_json(runtime_dir / "validated-craft-rules.json", asdict(validated_file))
    return candidate_file, validated_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote replay-validated craft rules.")
    parser.add_argument("--benchmark-dir", required=True, help="Directory or file containing replay benchmark JSON outputs.")
    parser.add_argument("--runtime-dir", required=True, help="Runtime data directory to write rule artifacts.")
    parser.add_argument("--min-samples", type=int, default=3, help="Minimum benchmark samples before promotion.")
    parser.add_argument("--min-win-rate", type=float, default=0.55, help="Minimum candidate win rate before promotion.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        promote_rules(
            benchmark_dir=Path(args.benchmark_dir),
            runtime_dir=Path(args.runtime_dir),
            min_samples=max(1, args.min_samples),
            min_win_rate=max(0.0, min(1.0, args.min_win_rate)),
        )
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
