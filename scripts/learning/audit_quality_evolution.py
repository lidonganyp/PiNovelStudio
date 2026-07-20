"""
PiNovelStudio — Audit quality evolution acceptance evidence.

This script is a local acceptance gate for the replay -> learning -> runtime
rule -> trace loop. It does not generate or promote rules. It only reports
whether the project currently has enough evidence to claim the quality
evolution loop is active.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass
class CheckResult:
    id: str
    status: str
    message: str
    evidence: dict[str, Any]


@dataclass
class AuditSummary:
    benchmarkFiles: int
    benchmarkFilesWithRules: int
    benchmarkRuleSamples: int
    orchestratorGeneratedBenchmarks: int
    failedGenerationProofBenchmarks: int
    candidateRuntimeRules: int
    validatedRuntimeRules: int
    activeValidatedRules: int
    traceFiles: int
    traceEventsWithRules: int
    traceEventsWithActiveValidatedRules: int
    tracePatchRecords: int


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def iter_json_files(path: Path) -> list[Path]:
    if path.is_file() and path.suffix.lower() == ".json":
        return [path]
    if path.is_dir():
        return sorted(item for item in path.rglob("*.json") if item.is_file())
    return []


def resolve_path(project_root: Path, value: str | None, default: str) -> Path:
    raw = Path(value) if value else Path(default)
    return raw if raw.is_absolute() else project_root / raw


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(report, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(f"{body}\n", encoding="utf-8")
    tmp_path.replace(path)


def as_float(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def entries_from_file(path: Path) -> list[dict[str, Any]]:
    parsed = read_json(path)
    if isinstance(parsed, dict) and isinstance(parsed.get("entries"), list):
        return [entry for entry in parsed["entries"] if isinstance(entry, dict)]
    if isinstance(parsed, list):
        return [entry for entry in parsed if isinstance(entry, dict)]
    return []


def is_replay_benchmark(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return (
        isinstance(value.get("benchmarkId"), str)
        and isinstance(value.get("candidateWins"), bool)
        and isinstance(value.get("scores"), dict)
        and isinstance(value.get("metadata"), dict)
    )


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
        values.extend([
            candidate.get("generatedBy"),
            candidate.get("generated_by"),
            candidate.get("generationTool"),
            candidate.get("generation_tool"),
        ])

    return any(str(value).strip() == "novel_generate_chapter" for value in values if value is not None)


def as_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


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


def resolve_candidate_result_path(project_root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    return path if path.is_absolute() else project_root / path


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


def has_successful_generation_result(project_root: Path, benchmark: dict[str, Any]) -> bool:
    raw_path = candidate_result_path(benchmark)
    if raw_path is None:
        return True

    parsed = read_json(resolve_candidate_result_path(project_root, raw_path))
    if not isinstance(parsed, dict):
        return False
    status = as_string(parsed.get("status"))
    # P0: completed_with_review 需要人工复核，不能自动视为成功
    # 但可复核的 anti-AI 修复结果仍然有效
    if status in {"success", "passed", "complete", "completed"}:
        return True
    return is_reviewable_anti_ai_generation_result(parsed)


def has_usable_orchestrator_proof(project_root: Path, benchmark: dict[str, Any]) -> bool:
    return has_orchestrator_proof(benchmark) and has_successful_generation_result(project_root, benchmark)


def count_candidate_rules(benchmark: dict[str, Any]) -> int:
    rules = benchmark.get("candidateRules")
    return len([rule for rule in rules if isinstance(rule, dict)]) if isinstance(rules, list) else 0


def collect_local_repair_triggers(benchmark: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = benchmark.get("metadata") if isinstance(benchmark.get("metadata"), dict) else {}
    evidence = metadata.get("localRepairEvidence")
    if not isinstance(evidence, dict):
        return []
    triggers = evidence.get("triggers")
    if not isinstance(triggers, list):
        return []
    return [trigger for trigger in triggers if isinstance(trigger, dict)]


def scan_benchmarks(project_root: Path, benchmark_dir: Path) -> dict[str, Any]:
    benchmarks_by_id: dict[str, list[dict[str, Any]]] = {}
    with_rules = 0
    rule_samples = 0
    orchestrator_generated = 0
    failed_generation_proof = 0
    local_repair_trigger_counts: dict[str, int] = {}
    local_repair_observation_counts: dict[str, int] = {}

    for path in iter_json_files(benchmark_dir):
        parsed = read_json(path)
        if not is_replay_benchmark(parsed):
            continue
        benchmark_id = as_string(parsed.get("benchmarkId"))
        if benchmark_id is None:
            continue
        benchmarks_by_id.setdefault(benchmark_id, []).append(parsed)

    for benchmarks in benchmarks_by_id.values():
        if any(count_candidate_rules(benchmark) > 0 for benchmark in benchmarks):
            with_rules += 1
            rule_samples += 1

        all_usable = all(has_usable_orchestrator_proof(project_root, benchmark) for benchmark in benchmarks)
        has_failed_proof = any(
            has_orchestrator_proof(benchmark)
            and candidate_result_path(benchmark) is not None
            and not has_successful_generation_result(project_root, benchmark)
            for benchmark in benchmarks
        )
        if all_usable:
            orchestrator_generated += 1
        elif has_failed_proof:
            failed_generation_proof += 1

        for benchmark in benchmarks:
            for trigger in collect_local_repair_triggers(benchmark):
                rule_id = as_string(trigger.get("ruleId")) or "unknown"
                local_repair_trigger_counts[rule_id] = local_repair_trigger_counts.get(rule_id, 0) + 1
                if trigger.get("observationMode") is True:
                    local_repair_observation_counts[rule_id] = (
                        local_repair_observation_counts.get(rule_id, 0) + 1
                    )

    return {
        "benchmarkFiles": len(benchmarks_by_id),
        "benchmarkFilesWithRules": with_rules,
        "benchmarkRuleSamples": rule_samples,
        "orchestratorGeneratedBenchmarks": orchestrator_generated,
        "failedGenerationProofBenchmarks": failed_generation_proof,
        "_localRepairTriggerCounts": local_repair_trigger_counts,
        "_localRepairObservationCounts": local_repair_observation_counts,
    }


def is_active_validated_rule(rule: dict[str, Any], min_samples: int, min_win_rate: float) -> bool:
    evidence = rule.get("evidence") if isinstance(rule.get("evidence"), dict) else {}
    sample_size = as_int(evidence.get("sampleSize")) or as_int(rule.get("sampleSize")) or 0
    win_rate = as_float(evidence.get("validatedWinRate"))
    if win_rate is None:
        win_rate = as_float(rule.get("validatedWinRate"))
    return sample_size >= min_samples and win_rate is not None and win_rate >= min_win_rate


def scan_runtime(runtime_dir: Path, min_samples: int, min_win_rate: float) -> tuple[dict[str, int], set[str]]:
    candidate_entries = entries_from_file(runtime_dir / "candidate-rules.json")
    validated_entries = entries_from_file(runtime_dir / "validated-craft-rules.json")
    active_entries = [
        rule for rule in validated_entries
        if is_active_validated_rule(rule, min_samples=min_samples, min_win_rate=min_win_rate)
    ]
    active_rule_ids = {
        str(rule.get("id")).strip()
        for rule in active_entries
        if str(rule.get("id") or "").strip()
    }
    return (
        {
            "candidateRuntimeRules": len(candidate_entries),
            "validatedRuntimeRules": len(validated_entries),
            "activeValidatedRules": len(active_entries),
        },
        active_rule_ids,
    )


def scan_traces(trace_dir: Path, active_rule_ids: set[str]) -> dict[str, int]:
    files = iter_json_files(trace_dir)
    trace_files = 0
    events_with_rules = 0
    events_with_active_validated_rules = 0
    patch_records = 0

    for path in files:
        parsed = read_json(path)
        if not isinstance(parsed, dict):
            continue
        events = parsed.get("events")
        patches = parsed.get("patches")
        has_trace_shape = isinstance(events, list) or isinstance(patches, list)
        if not has_trace_shape:
            continue
        trace_files += 1
        if isinstance(events, list):
            for event in events:
                if not isinstance(event, dict):
                    continue
                selected = event.get("selectedRuleIds")
                selected_ids = {
                    str(item).strip()
                    for item in selected
                    if str(item).strip()
                } if isinstance(selected, list) else set()
                if selected_ids:
                    events_with_rules += 1
                if selected_ids.intersection(active_rule_ids):
                    events_with_active_validated_rules += 1
        if isinstance(patches, list):
            patch_records += len([patch for patch in patches if isinstance(patch, dict)])

    return {
        "traceFiles": trace_files,
        "traceEventsWithRules": events_with_rules,
        "traceEventsWithActiveValidatedRules": events_with_active_validated_rules,
        "tracePatchRecords": patch_records,
    }


def make_check(check_id: str, ok: bool, message: str, evidence: dict[str, Any]) -> CheckResult:
    return CheckResult(
        id=check_id,
        status="pass" if ok else "fail",
        message=message,
        evidence=evidence,
    )


def audit(
    project_root: Path,
    benchmark_dir: Path,
    runtime_dir: Path,
    trace_dir: Path,
    min_samples: int,
    min_win_rate: float,
) -> dict[str, Any]:
    benchmark = scan_benchmarks(project_root, benchmark_dir)
    local_repair_trigger_counts = benchmark.pop("_localRepairTriggerCounts", {})
    local_repair_observation_counts = benchmark.pop("_localRepairObservationCounts", {})
    runtime, active_rule_ids = scan_runtime(runtime_dir, min_samples=min_samples, min_win_rate=min_win_rate)
    traces = scan_traces(trace_dir, active_rule_ids=active_rule_ids)
    summary = AuditSummary(**benchmark, **runtime, **traces)

    checks = [
        make_check(
            "replay_benchmarks",
            summary.benchmarkFiles >= min_samples
            and summary.benchmarkFilesWithRules >= min_samples
            and summary.benchmarkRuleSamples >= min_samples,
            "Replay benchmark evidence must include enough samples with candidate rules.",
            {
                "benchmarkDir": str(benchmark_dir),
                "benchmarkFiles": summary.benchmarkFiles,
                "benchmarkFilesWithRules": summary.benchmarkFilesWithRules,
                "benchmarkRuleSamples": summary.benchmarkRuleSamples,
                "minSamples": min_samples,
            },
        ),
        make_check(
            "orchestrator_generation_proof",
            summary.benchmarkFiles > 0 and summary.orchestratorGeneratedBenchmarks == summary.benchmarkFiles,
            "Every replay benchmark must carry metadata proving the candidate came from novel_generate_chapter and, when resultPath is present, that generation completed successfully.",
            {
                "orchestratorGeneratedBenchmarks": summary.orchestratorGeneratedBenchmarks,
                "failedGenerationProofBenchmarks": summary.failedGenerationProofBenchmarks,
                "benchmarkFiles": summary.benchmarkFiles,
            },
        ),
        make_check(
            "candidate_rules_artifact",
            summary.candidateRuntimeRules > 0,
            "candidate-rules.json must contain replay-derived candidate rules.",
            {
                "runtimeDir": str(runtime_dir),
                "candidateRuntimeRules": summary.candidateRuntimeRules,
            },
        ),
        make_check(
            "active_validated_rules",
            summary.activeValidatedRules > 0,
            "validated-craft-rules.json must contain at least one rule meeting sample and win-rate thresholds.",
            {
                "validatedRuntimeRules": summary.validatedRuntimeRules,
                "activeValidatedRules": summary.activeValidatedRules,
                "minSamples": min_samples,
                "minWinRate": min_win_rate,
            },
        ),
        make_check(
            "quality_trace",
            summary.traceFiles > 0
            and summary.traceEventsWithActiveValidatedRules > 0
            and summary.tracePatchRecords > 0,
            "Quality traces must show selected active validated rules and patch comparator records from a later generation.",
            {
                "traceDir": str(trace_dir),
                "traceFiles": summary.traceFiles,
                "traceEventsWithRules": summary.traceEventsWithRules,
                "traceEventsWithActiveValidatedRules": summary.traceEventsWithActiveValidatedRules,
                "tracePatchRecords": summary.tracePatchRecords,
                "activeValidatedRuleIds": sorted(active_rule_ids),
            },
        ),
    ]

    # Local repair candidates (LC/AA) record observation-mode triggers in
    # benchmark metadata. This is reported as informational evidence — it
    # does NOT block the audit verdict, since LC/AA candidates promote on a
    # separate observation-first cadence.
    local_repair_info = CheckResult(
        id="local_repair_candidate_observation",
        status="info",
        message=(
            "Local repair candidate trigger and observation counts (informational only -- "
            "LC/AA candidates promote separately on observation evidence)."
        ),
        evidence={
            "triggerCountsByRuleId": local_repair_trigger_counts,
            "observationCountsByRuleId": local_repair_observation_counts,
            "totalTriggers": sum(local_repair_trigger_counts.values()),
        },
    )
    checks.append(local_repair_info)

    blocking_checks = [check for check in checks if check.status != "info"]
    verdict = "pass" if all(check.status == "pass" for check in blocking_checks) else "fail"
    return {
        "schemaVersion": 1,
        "verdict": verdict,
        "projectRoot": str(project_root),
        "summary": asdict(summary),
        "checks": [asdict(check) for check in checks],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit PiNovelStudio quality evolution acceptance evidence.")
    parser.add_argument("--project-root", default=".", help="Project root. Defaults to the current directory.")
    parser.add_argument("--benchmark-dir", default="docs/evals/quality-replay", help="Replay benchmark JSON directory or file.")
    parser.add_argument("--runtime-dir", default="data/runtime", help="Runtime rule directory.")
    parser.add_argument("--trace-dir", default="workspaces", help="Workspace trace root or trace directory.")
    parser.add_argument("--min-samples", type=int, default=3, help="Minimum replay samples for acceptance.")
    parser.add_argument("--min-win-rate", type=float, default=0.55, help="Minimum validated win rate for runtime admission.")
    parser.add_argument("--output", help="Optional path to write the JSON audit report.")
    parser.add_argument("--allow-incomplete", action="store_true", help="Always exit 0 while preserving the fail verdict.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    project_root = Path(args.project_root).resolve()
    min_samples = max(1, args.min_samples)
    min_win_rate = max(0.0, min(1.0, args.min_win_rate))
    report = audit(
        project_root=project_root,
        benchmark_dir=resolve_path(project_root, args.benchmark_dir, "docs/evals/quality-replay"),
        runtime_dir=resolve_path(project_root, args.runtime_dir, "data/runtime"),
        trace_dir=resolve_path(project_root, args.trace_dir, "workspaces"),
        min_samples=min_samples,
        min_win_rate=min_win_rate,
    )
    if args.output:
        write_report(resolve_path(project_root, args.output, ""), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["verdict"] != "pass" and not args.allow_incomplete:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
