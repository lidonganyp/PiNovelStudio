"""
PiNovelStudio - Audit GetDraft dialogue candidate trace coverage.

This script checks whether real replay benchmark traces contain enough
observable evidence to evaluate GetDraft dialogue candidate rules. It is
read-only: it does not promote rules and does not modify runtime rule files.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal


FieldStatus = Literal["direct", "derived", "benchmark_metric_only", "missing"]


DIRECT_FIELD_PATHS: dict[str, tuple[str, ...]] = {
    "event_type": ("events[].getdraftDialogueTrace.event_type",),
    "narrative_beat": ("events[].getdraftDialogueTrace.narrative_beat",),
    "dialogue_propulsion_score": ("events[].craftGate.metrics.dialoguePropulsion",),
    "contract_coverage": ("events[].craftGate.metrics.contractCoverage",),
    "state_delta": ("events[].progression.evidence.metrics.state_delta.passed",),
    "choice_delta": ("events[].getdraftDialogueTrace.choice_delta",),
    "risk_delta": ("events[].getdraftDialogueTrace.risk_delta",),
    "causal_chain": ("events[].progression.evidence.metrics.causal_chain.passed",),
    "protagonist_active": ("events[].progression.evidence.metrics.protagonist_active.passed",),
    "style_match_score": ("events[].getdraftDialogueTrace.style_match_score",),
}


DERIVED_FIELDS: dict[str, str] = {
    "event_type": "Derived weakly from chapterContract.dialoguePlan.dialogueBearingEventIds or event dialogueRatio.",
    "narrative_beat": "Derived weakly from event.sceneType / eventName; no canonical narrativeBeat field exists.",
    "risk_delta": "Derived from events[].progression.evidence.riskDelta.score > 0.",
    "information_delta": "Derived from events[].progression.evidence.informationDelta.score > 0.",
    "character_boundary_gate_pass": "Derived weakly from stage8.scene_continuity gate pass when no character-specific field exists.",
}


BENCHMARK_METRIC_FIELDS: dict[str, str] = {
    "ai_filler_density": "candidateMetrics.ai_filler_density",
    "choice_delta": "candidateMetrics.choiceDelta",
    "hook_movement": "candidateMetrics.hookMovement",
    "reader_need_to_continue": "candidateMetrics.readerNeedToContinue",
    "risk_delta": "candidateMetrics.riskDelta",
}


PATCH_REQUIRED_FIELDS: set[str] = {
    "style_match_score",
    "span_problem_list",
    "span_problem_list_length",
    "span_problem_list_has_over_explanation",
    "information_core",
    "stage8_route_gate",
    "stage8_blocking_detection_types_contains_over_explanation",
    "hook_evidence_chain",
}


@dataclass
class BenchmarkEvidence:
    file: str
    benchmarkId: str
    candidateWins: bool
    scoreDelta: float | None
    generatedByOrchestrator: bool
    candidateRules: int
    tracePath: str | None
    traceExists: bool
    eventCount: int
    patchCount: int
    gateCount: int
    eventsWithSelectedRules: int
    dialogueIssueEvents: int
    dialogueBearingEvents: int
    eventContractIssueEvents: int
    stage8GateCount: int


@dataclass
class FieldCoverage:
    field: str
    status: FieldStatus
    reason: str
    chaptersObserved: int


@dataclass
class RuleCoverage:
    id: str
    axis: str
    priority: str
    patchUnit: str
    requiredFieldCount: int
    directFields: list[str]
    derivedFields: list[str]
    benchmarkMetricOnlyFields: list[str]
    missingFields: list[str]
    strictTraceFieldRate: float
    observableFieldRate: float
    triggerCandidateCount: int
    blockedByMissingFields: list[str]
    promotionBlocked: bool
    promotionBlockers: list[str]
    fieldCoverage: list[FieldCoverage]


def read_text_with_fallback(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(read_text_with_fallback(path))
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(f"{body}\n", encoding="utf-8")
    tmp_path.replace(path)


def iter_benchmark_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() == ".json" else []
    if not path.is_dir():
        return []
    return sorted(
        item for item in path.rglob("*.json")
        if item.is_file()
    )


def load_rules(path: Path) -> list[dict[str, Any]]:
    parsed = read_json(path)
    if isinstance(parsed, dict) and isinstance(parsed.get("entries"), list):
        return [entry for entry in parsed["entries"] if isinstance(entry, dict)]
    if isinstance(parsed, list):
        return [entry for entry in parsed if isinstance(entry, dict)]
    raise ValueError(f"{path} does not contain a rule entries array")


def as_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def resolve_path(project_root: Path, raw: str | None) -> Path | None:
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_absolute() else project_root / path


def is_replay_benchmark(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("benchmarkId"), str)
        and isinstance(value.get("candidateWins"), bool)
        and isinstance(value.get("metadata"), dict)
    )


def has_orchestrator_proof(benchmark: dict[str, Any]) -> bool:
    metadata = as_dict(benchmark.get("metadata"))
    candidate = as_dict(metadata.get("candidate"))
    values = [
        metadata.get("generatedBy"),
        metadata.get("generated_by"),
        metadata.get("generationTool"),
        metadata.get("generation_tool"),
        candidate.get("generatedBy"),
        candidate.get("generated_by"),
        candidate.get("generationTool"),
        candidate.get("generation_tool"),
    ]
    return any(as_string(value) == "novel_generate_chapter" for value in values)


def candidate_trace_path(benchmark: dict[str, Any]) -> str | None:
    metadata = as_dict(benchmark.get("metadata"))
    candidate = as_dict(metadata.get("candidate"))
    return (
        as_string(candidate.get("tracePath"))
        or as_string(candidate.get("trace_path"))
        or as_string(metadata.get("tracePath"))
        or as_string(metadata.get("trace_path"))
        or None
    )


def candidate_rules_count(benchmark: dict[str, Any]) -> int:
    rules = benchmark.get("candidateRules")
    return len([rule for rule in rules if isinstance(rule, dict)]) if isinstance(rules, list) else 0


def event_id(event: dict[str, Any]) -> str:
    return as_string(event.get("eventId")) or as_string(event.get("id"))


def event_metrics(event: dict[str, Any]) -> dict[str, Any]:
    return as_dict(as_dict(event.get("craftGate")).get("metrics"))


def getdraft_dialogue_trace(event: dict[str, Any]) -> dict[str, Any]:
    return as_dict(event.get("getdraftDialogueTrace"))


def bridge_string(event: dict[str, Any], field: str) -> str:
    return as_string(getdraft_dialogue_trace(event).get(field))


def bridge_float(event: dict[str, Any], field: str) -> float | None:
    return as_float(getdraft_dialogue_trace(event).get(field))


def bridge_bool(event: dict[str, Any], field: str) -> bool | None:
    return as_bool(getdraft_dialogue_trace(event).get(field))


def has_bridge_field(event: dict[str, Any], field: str) -> bool:
    return field in getdraft_dialogue_trace(event)


def progression_metrics(event: dict[str, Any]) -> dict[str, Any]:
    progression = as_dict(event.get("progression"))
    evidence = as_dict(progression.get("evidence"))
    return as_dict(evidence.get("metrics"))


def progression_evidence(event: dict[str, Any]) -> dict[str, Any]:
    return as_dict(as_dict(event.get("progression")).get("evidence"))


def metric_passed(event: dict[str, Any], name: str) -> bool | None:
    value = as_dict(progression_metrics(event).get(name)).get("passed")
    return as_bool(value)


def event_score(event: dict[str, Any], section: str) -> float | None:
    return as_float(as_dict(progression_evidence(event).get(section)).get("score"))


def dialogue_bearing_event_ids(trace: dict[str, Any]) -> set[str]:
    contract = as_dict(trace.get("chapterContract"))
    plan = as_dict(contract.get("dialoguePlan"))
    return {
        as_string(value)
        for value in as_list(plan.get("dialogueBearingEventIds"))
        if as_string(value)
    }


def is_dialogue_bearing(event: dict[str, Any], planned_ids: set[str]) -> bool:
    if bridge_string(event, "event_type") == "dialogue":
        return True
    if event_id(event) in planned_ids:
        return True
    dialogue_ratio = as_float(event_metrics(event).get("dialogueRatio"))
    return dialogue_ratio is not None and dialogue_ratio > 0


def gate_records(trace: dict[str, Any], stage_prefix: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for gate in as_list(trace.get("gates")):
        if isinstance(gate, dict) and as_string(gate.get("stage")).startswith(stage_prefix):
            records.append(gate)
    return records


def field_supported_in_trace(field: str, benchmark: dict[str, Any], trace: dict[str, Any] | None) -> FieldCoverage:
    if trace is None:
        metric_path = BENCHMARK_METRIC_FIELDS.get(field)
        if metric_path and metric_path.split(".", 1)[0] in benchmark:
            return FieldCoverage(field, "benchmark_metric_only", metric_path, 1)
        return FieldCoverage(field, "missing", "Trace file is missing or unreadable.", 0)

    events = [event for event in as_list(trace.get("events")) if isinstance(event, dict)]
    metrics = as_dict(benchmark.get("candidateMetrics"))

    if any(has_bridge_field(event, field) for event in events):
        return FieldCoverage(field, "direct", f"events[].getdraftDialogueTrace.{field}", 1)

    if field in DIRECT_FIELD_PATHS:
        found = False
        if field == "dialogue_propulsion_score":
            found = any("dialoguePropulsion" in event_metrics(event) for event in events)
        elif field == "contract_coverage":
            found = any("contractCoverage" in event_metrics(event) for event in events)
        elif field == "state_delta":
            found = any(metric_passed(event, "state_delta") is not None for event in events)
        elif field == "choice_delta":
            found = False
        elif field == "risk_delta":
            found = False
        elif field == "causal_chain":
            found = any(metric_passed(event, "causal_chain") is not None for event in events)
        elif field == "protagonist_active":
            found = any(metric_passed(event, "protagonist_active") is not None for event in events)
        elif field == "event_type":
            found = False
        elif field == "narrative_beat":
            found = False
        elif field == "style_match_score":
            found = False
        if found:
            return FieldCoverage(field, "direct", ", ".join(DIRECT_FIELD_PATHS[field]), 1)

    if field in DERIVED_FIELDS:
        found = False
        if field == "event_type":
            planned_ids = dialogue_bearing_event_ids(trace)
            found = bool(planned_ids) or any("dialogueRatio" in event_metrics(event) for event in events)
        elif field == "narrative_beat":
            found = any(as_string(event.get("sceneType")) or as_string(event.get("eventName")) for event in events)
        elif field == "risk_delta":
            found = any(event_score(event, "riskDelta") is not None for event in events)
        elif field == "information_delta":
            found = any(event_score(event, "informationDelta") is not None for event in events)
        elif field == "character_boundary_gate_pass":
            found = bool(gate_records(trace, "stage8.scene_continuity"))
        if found:
            return FieldCoverage(field, "derived", DERIVED_FIELDS[field], 1)

    if field in BENCHMARK_METRIC_FIELDS:
        metric_name = BENCHMARK_METRIC_FIELDS[field].split(".", 1)[1]
        if metric_name in metrics:
            return FieldCoverage(field, "benchmark_metric_only", BENCHMARK_METRIC_FIELDS[field], 1)

    if field == "span_problem_list_length":
        return FieldCoverage(field, "missing", "No span_problem_list is recorded in trace gates or patches.", 0)

    return FieldCoverage(field, "missing", "No stable trace field or replay metric was found.", 0)


def summarize_benchmark(project_root: Path, path: Path, benchmark: dict[str, Any]) -> tuple[BenchmarkEvidence, dict[str, Any] | None]:
    raw_trace_path = candidate_trace_path(benchmark)
    trace_path = resolve_path(project_root, raw_trace_path)
    trace = read_json(trace_path) if trace_path is not None and trace_path.exists() else None
    trace_dict = trace if isinstance(trace, dict) else None
    events = [event for event in as_list(trace_dict.get("events") if trace_dict else None) if isinstance(event, dict)]
    gates = [gate for gate in as_list(trace_dict.get("gates") if trace_dict else None) if isinstance(gate, dict)]
    planned_dialogue_ids = dialogue_bearing_event_ids(trace_dict or {})

    dialogue_issue_events = 0
    dialogue_bearing_events = 0
    event_contract_issue_events = 0
    for event in events:
        issues = {as_string(issue) for issue in as_list(as_dict(event.get("craftGate")).get("issueTypes"))}
        if "dialogue_propulsion" in issues:
            dialogue_issue_events += 1
        if "event_contract" in issues:
            event_contract_issue_events += 1
        if is_dialogue_bearing(event, planned_dialogue_ids):
            dialogue_bearing_events += 1

    return (
        BenchmarkEvidence(
            file=path.name,
            benchmarkId=as_string(benchmark.get("benchmarkId")),
            candidateWins=bool(benchmark.get("candidateWins")),
            scoreDelta=as_float(as_dict(benchmark.get("scores")).get("delta")),
            generatedByOrchestrator=has_orchestrator_proof(benchmark),
            candidateRules=candidate_rules_count(benchmark),
            tracePath=str(trace_path) if trace_path else None,
            traceExists=trace_dict is not None,
            eventCount=len(events),
            patchCount=len([patch for patch in as_list(trace_dict.get("patches") if trace_dict else None) if isinstance(patch, dict)]),
            gateCount=len(gates),
            eventsWithSelectedRules=len([
                event for event in events
                if any(as_string(rule_id) for rule_id in as_list(event.get("selectedRuleIds")))
            ]),
            dialogueIssueEvents=dialogue_issue_events,
            dialogueBearingEvents=dialogue_bearing_events,
            eventContractIssueEvents=event_contract_issue_events,
            stage8GateCount=len([
                gate for gate in gates
                if as_string(gate.get("stage")).startswith("stage8")
            ]),
        ),
        trace_dict,
    )


def dp001_trigger_candidates(trace: dict[str, Any]) -> int:
    planned_ids = dialogue_bearing_event_ids(trace)
    count = 0
    for event in [item for item in as_list(trace.get("events")) if isinstance(item, dict)]:
        if not is_dialogue_bearing(event, planned_ids):
            continue
        metrics = event_metrics(event)
        issues = {as_string(issue) for issue in as_list(as_dict(event.get("craftGate")).get("issueTypes"))}
        dialogue_score = bridge_float(event, "dialogue_propulsion_score")
        if dialogue_score is None:
            dialogue_score = as_float(metrics.get("dialoguePropulsion"))
        state_delta = bridge_bool(event, "state_delta")
        if state_delta is None:
            state_delta = metric_passed(event, "state_delta")
        choice_delta = bridge_float(event, "choice_delta")
        risk_delta = bridge_float(event, "risk_delta")
        if risk_delta is None:
            risk_delta = event_score(event, "riskDelta")
        weak_state_shift = (
            state_delta is False
            and (choice_delta is None or choice_delta <= 0)
            and (risk_delta is None or risk_delta <= 0)
        )
        if "dialogue_propulsion" in issues or (dialogue_score is not None and dialogue_score < 80) or weak_state_shift:
            count += 1
    return count


def dp002_trigger_candidates(trace: dict[str, Any]) -> int:
    planned_ids = dialogue_bearing_event_ids(trace)
    count = 0
    for event in [item for item in as_list(trace.get("events")) if isinstance(item, dict)]:
        protagonist_active = bridge_bool(event, "protagonist_active")
        if protagonist_active is None:
            protagonist_active = metric_passed(event, "protagonist_active")
        narrative_beat = (
            bridge_string(event, "narrative_beat")
            or as_string(event.get("narrativeBeat"))
            or as_string(event.get("sceneType"))
        ).lower()
        if (
            is_dialogue_bearing(event, planned_ids)
            and narrative_beat in {"revelation", "confrontation", "decision"}
            and protagonist_active is False
        ):
            count += 1
    return count


def hc002_trigger_candidates(benchmark: dict[str, Any]) -> int:
    metrics = as_dict(benchmark.get("candidateMetrics"))
    hook_movement = as_float(metrics.get("hookMovement"))
    risk_delta = as_float(metrics.get("riskDelta"))
    if hook_movement == 0 or risk_delta == 0:
        return 1
    return 0


def trigger_candidate_count(rule_id: str, benchmarks: list[dict[str, Any]], traces: list[dict[str, Any] | None]) -> int:
    total = 0
    for benchmark, trace in zip(benchmarks, traces):
        if rule_id == "DP-001" and trace is not None:
            total += dp001_trigger_candidates(trace)
        elif rule_id == "DP-002" and trace is not None:
            total += dp002_trigger_candidates(trace)
        elif rule_id == "HC-002":
            total += hc002_trigger_candidates(benchmark)
    return total


def coverage_for_rule(
    rule: dict[str, Any],
    benchmarks: list[dict[str, Any]],
    traces: list[dict[str, Any] | None],
) -> RuleCoverage:
    required = [
        as_string(field)
        for field in as_list(rule.get("required_trace_fields"))
        if as_string(field)
    ]
    coverage_by_field: list[FieldCoverage] = []
    for field in required:
        statuses: list[FieldCoverage] = [
            field_supported_in_trace(field, benchmark, trace)
            for benchmark, trace in zip(benchmarks, traces)
        ]
        best_status: FieldStatus
        reason = ""
        chapters = sum(1 for status in statuses if status.status != "missing")
        if any(status.status == "direct" for status in statuses):
            best_status = "direct"
            reason = next(status.reason for status in statuses if status.status == "direct")
        elif any(status.status == "derived" for status in statuses):
            best_status = "derived"
            reason = next(status.reason for status in statuses if status.status == "derived")
        elif any(status.status == "benchmark_metric_only" for status in statuses):
            best_status = "benchmark_metric_only"
            reason = next(status.reason for status in statuses if status.status == "benchmark_metric_only")
        else:
            best_status = "missing"
            reason = statuses[0].reason if statuses else "Field is absent from all benchmark traces."
        coverage_by_field.append(FieldCoverage(field, best_status, reason, chapters))

    direct_fields = [item.field for item in coverage_by_field if item.status == "direct"]
    derived_fields = [item.field for item in coverage_by_field if item.status == "derived"]
    benchmark_only = [item.field for item in coverage_by_field if item.status == "benchmark_metric_only"]
    missing_fields = [item.field for item in coverage_by_field if item.status == "missing"]
    required_count = max(1, len(required))
    trigger_count = trigger_candidate_count(as_string(rule.get("id")), benchmarks, traces)
    blocked_fields = sorted(set(missing_fields + [field for field in benchmark_only if field in PATCH_REQUIRED_FIELDS]))

    blockers: list[str] = []
    if missing_fields:
        blockers.append("required trace fields are missing")
    if benchmark_only:
        blockers.append("some fields are available only as chapter-level benchmark metrics, not trace evidence")
    if trigger_count == 0:
        blockers.append("no stable trigger candidates were observable in the real traces")
    if any(candidate_rules_count(benchmark) == 0 for benchmark in benchmarks):
        blockers.append("at least one benchmark candidateRules array is empty, so rule win/loss samples are incomplete")

    return RuleCoverage(
        id=as_string(rule.get("id")),
        axis=as_string(rule.get("axis")),
        priority=as_string(rule.get("priority")),
        patchUnit=as_string(rule.get("patch_unit")),
        requiredFieldCount=len(required),
        directFields=direct_fields,
        derivedFields=derived_fields,
        benchmarkMetricOnlyFields=benchmark_only,
        missingFields=missing_fields,
        strictTraceFieldRate=round(len(direct_fields) / required_count, 4),
        observableFieldRate=round((len(direct_fields) + len(derived_fields)) / required_count, 4),
        triggerCandidateCount=trigger_count,
        blockedByMissingFields=blocked_fields,
        promotionBlocked=bool(blockers),
        promotionBlockers=blockers,
        fieldCoverage=coverage_by_field,
    )


def audit(
    project_root: Path,
    benchmark_dir: Path,
    rules_path: Path,
) -> dict[str, Any]:
    rules = load_rules(rules_path)
    benchmark_files = iter_benchmark_files(benchmark_dir)
    benchmarks: list[dict[str, Any]] = []
    benchmark_evidence: list[BenchmarkEvidence] = []
    traces: list[dict[str, Any] | None] = []

    for path in benchmark_files:
        parsed = read_json(path)
        if not is_replay_benchmark(parsed):
            continue
        benchmarks.append(parsed)
        evidence, trace = summarize_benchmark(project_root, path, parsed)
        benchmark_evidence.append(evidence)
        traces.append(trace)

    rule_coverage = [coverage_for_rule(rule, benchmarks, traces) for rule in rules]
    wins = sum(1 for benchmark in benchmarks if benchmark.get("candidateWins") is True)
    deltas = [
        as_float(as_dict(benchmark.get("scores")).get("delta"))
        for benchmark in benchmarks
    ]
    numeric_deltas = [delta for delta in deltas if delta is not None]
    candidate_rule_samples = sum(candidate_rules_count(benchmark) for benchmark in benchmarks)
    trace_files = sum(1 for evidence in benchmark_evidence if evidence.traceExists)
    total_events = sum(evidence.eventCount for evidence in benchmark_evidence)
    total_patches = sum(evidence.patchCount for evidence in benchmark_evidence)
    events_with_rules = sum(evidence.eventsWithSelectedRules for evidence in benchmark_evidence)
    blocked_rules = [coverage.id for coverage in rule_coverage if coverage.promotionBlocked]

    verdict = "insufficient_trace_evidence" if blocked_rules else "trace_coverage_ready"
    if candidate_rule_samples > 0:
        conclusion_reason = (
            "Replay candidate rule samples exist, but required trace fields are still missing "
            "or only available as chapter-level benchmark metrics; promotion also requires "
            "enough per-rule replay samples and validated win rate."
        )
        next_step = (
            "Add the remaining event-level fields, especially choice_delta and style_match_score, "
            "then rerun multi-chapter replay so each candidate rule can meet sampleSize and win-rate gates."
        )
    else:
        conclusion_reason = (
            "Real replay chapters exist, but candidate rule samples are absent and several required "
            "trace fields are missing or only available as chapter-level benchmark metrics."
        )
        next_step = (
            "Bridge DP-001/DP-002 candidateRules into replay output first; then add event-level "
            "choice_delta and style_match_score before considering replay promotion."
        )
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": verdict,
        "projectRoot": str(project_root),
        "benchmarkDir": str(benchmark_dir),
        "rulesPath": str(rules_path),
        "summary": {
            "benchmarkFiles": len(benchmarks),
            "orchestratorGeneratedBenchmarks": sum(
                1 for evidence in benchmark_evidence if evidence.generatedByOrchestrator
            ),
            "candidateWins": wins,
            "candidateWinRate": round(wins / len(benchmarks), 4) if benchmarks else 0.0,
            "averageScoreDelta": round(sum(numeric_deltas) / len(numeric_deltas), 4) if numeric_deltas else None,
            "candidateRuleSamples": candidate_rule_samples,
            "traceFiles": trace_files,
            "traceEvents": total_events,
            "tracePatchRecords": total_patches,
            "traceEventsWithSelectedRules": events_with_rules,
            "rulesAudited": len(rule_coverage),
            "rulesPromotionBlocked": len(blocked_rules),
            "blockedRuleIds": blocked_rules,
        },
        "conclusion": {
            "canPromoteGetDraftDialogueRules": False,
            "reason": conclusion_reason,
            "nextSmallestUsefulStep": next_step,
        },
        "benchmarks": [asdict(item) for item in benchmark_evidence],
        "rules": [asdict(item) for item in rule_coverage],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit GetDraft dialogue candidate trace coverage.")
    parser.add_argument("--project-root", default=".", help="Project root. Defaults to the current directory.")
    parser.add_argument("--benchmark-dir", required=True, help="Replay benchmark directory or file.")
    parser.add_argument("--rules", required=True, help="GetDraft dialogue candidate rule JSON.")
    parser.add_argument("--output", help="Optional JSON report output path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    project_root = Path(args.project_root).resolve()
    benchmark_dir = resolve_path(project_root, args.benchmark_dir)
    rules_path = resolve_path(project_root, args.rules)
    if benchmark_dir is None or rules_path is None:
        raise SystemExit("benchmark-dir and rules are required")

    report = audit(
        project_root=project_root,
        benchmark_dir=benchmark_dir,
        rules_path=rules_path,
    )
    if args.output:
        output_path = resolve_path(project_root, args.output)
        if output_path is not None:
            write_json(output_path, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
