"""
PiNovelStudio - Materialize GetDraft dialogue distillation artifacts.

GetDraft dialogue outputs are treated as candidate experience only. This script
normalizes copied JSONL, validates replay-promotion gates, and writes separate
candidate rules / trace-field specifications without touching validated runtime
rules.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_RULE_IDS: tuple[str, ...] = (
    "DP-001",
    "DP-002",
    "LC-001",
    "LC-002",
    "HC-001",
    "HC-002",
    "AA-001",
    "AA-002",
)

EXPECTED_TRACE_FIELDS: tuple[str, ...] = (
    "transition_evidence",
    "entry_evidence",
    "hook_evidence_chain",
    "hook_movement",
    "span_problem_list",
    "information_core",
    "patch_accepted_rate",
    "rollback_count",
)

EXPECTED_TRACE_RULES: dict[str, tuple[str, ...]] = {
    "transition_evidence": ("LC-001",),
    "entry_evidence": ("LC-002",),
    "hook_evidence_chain": ("HC-001",),
    "hook_movement": ("HC-002",),
    "span_problem_list": ("AA-001", "AA-002"),
    "information_core": ("AA-002",),
    "patch_accepted_rate": ("AA-001", "AA-002"),
    "rollback_count": ("AA-001", "AA-002"),
}

OBSERVATION_METRIC_FIELDS: set[str] = {"patch_accepted_rate", "rollback_count"}
PATCH_BLOCKING_FIELDS: set[str] = {"hook_evidence_chain", "span_problem_list"}


@dataclass(frozen=True)
class MaterializedArtifacts:
    rulesPath: Path
    traceFieldsPath: Path
    summaryPath: Path


def read_text_with_fallback(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def normalize_jsonish_line(line: str) -> str:
    return (
        line.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u201e", '"')
        .replace("\u300c", '"')
        .replace("\u300d", '"')
        .replace("\uff1a", ":")
        .replace("\uff0c", ",")
    )


def parse_jsonl_objects(path: Path) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(read_text_with_fallback(path).splitlines(), start=1):
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue

        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            try:
                value = json.loads(normalize_jsonish_line(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number} is not valid JSONL after normalization: {error}") from error

        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} must contain a JSON object")
        objects.append(value)

    if not objects:
        raise ValueError(f"{path} did not contain any JSON objects")
    return objects


def as_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_rule(rule: dict[str, Any]) -> None:
    rule_id = as_string(rule.get("id"))
    ensure(rule_id in EXPECTED_RULE_IDS, f"unexpected GetDraft dialogue rule id: {rule_id or '<missing>'}")
    ensure(as_string(rule.get("validation_status")) == "candidate", f"{rule_id} must remain candidate")
    ensure(as_string(rule.get("source")) == "getdraft_dialogue", f"{rule_id} must be sourced from getdraft_dialogue")
    ensure(rule.get("runtime_default_enabled") is False, f"{rule_id} must not be runtime-default enabled")
    ensure(as_string(rule.get("axis")) != "", f"{rule_id} is missing axis")
    ensure(as_string(rule.get("priority")) in {"P0", "P1", "P2"}, f"{rule_id} has invalid priority")
    ensure(as_string(rule.get("patch_unit")) in {"event", "span", "chapter_end"}, f"{rule_id} has invalid patch_unit")
    ensure(as_string(rule.get("trigger_predicate")) != "", f"{rule_id} is missing trigger_predicate")
    ensure(as_string_list(rule.get("required_trace_fields")), f"{rule_id} is missing required_trace_fields")
    ensure(as_string_list(rule.get("repair_actions")), f"{rule_id} is missing repair_actions")
    ensure(isinstance(rule.get("acceptance_criteria"), dict), f"{rule_id} is missing acceptance_criteria")
    ensure(as_string_list(rule.get("rollback_criteria")), f"{rule_id} is missing rollback_criteria")
    ensure(as_string_list(rule.get("replay_metrics")), f"{rule_id} is missing replay_metrics")
    ensure(as_string_list(rule.get("fixture_coverage")), f"{rule_id} is missing fixture_coverage")
    ensure(as_string_list(rule.get("non_promotion_reasons")), f"{rule_id} is missing non_promotion_reasons")

    promotion_gate = rule.get("promotion_gate")
    ensure(isinstance(promotion_gate, dict), f"{rule_id} is missing promotion_gate")
    ensure(promotion_gate.get("requires_replay_promotion") is True, f"{rule_id} must require replay promotion")
    ensure(promotion_gate.get("sample_size_at_least") >= 3, f"{rule_id} requires sample_size_at_least >= 3")
    ensure(
        promotion_gate.get("validated_win_rate_at_least") >= 0.55,
        f"{rule_id} requires validated_win_rate_at_least >= 0.55",
    )

    expected_observation = rule_id.startswith("AA-")
    ensure(rule.get("observation_mode") is expected_observation, f"{rule_id} has wrong observation_mode")


def validate_rules(rules: list[dict[str, Any]]) -> None:
    rule_ids = [as_string(rule.get("id")) for rule in rules]
    ensure(rule_ids == list(EXPECTED_RULE_IDS), f"rule ids must be ordered as {list(EXPECTED_RULE_IDS)}")
    for rule in rules:
        validate_rule(rule)


def validate_trace_field(field: dict[str, Any]) -> None:
    field_name = as_string(field.get("field_name"))
    ensure(field_name in EXPECTED_TRACE_FIELDS, f"unexpected trace field: {field_name or '<missing>'}")
    ensure(
        tuple(as_string_list(field.get("applies_to_rules"))) == EXPECTED_TRACE_RULES[field_name],
        f"{field_name} applies_to_rules mismatch",
    )
    ensure(as_string(field.get("detection_scope")) != "", f"{field_name} is missing detection_scope")
    ensure(as_string(field.get("value_type")) != "", f"{field_name} is missing value_type")
    ensure(as_string(field.get("positive_condition")) != "", f"{field_name} is missing positive_condition")
    ensure(as_string(field.get("negative_condition")) != "", f"{field_name} is missing negative_condition")
    ensure(as_string_list(field.get("extraction_inputs")), f"{field_name} is missing extraction_inputs")
    ensure(as_string_list(field.get("false_positive_risks")), f"{field_name} is missing false_positive_risks")
    ensure(as_string_list(field.get("false_negative_risks")), f"{field_name} is missing false_negative_risks")
    ensure(as_string_list(field.get("replay_fixture_minimum")), f"{field_name} is missing replay_fixture_minimum")
    ensure(field.get("should_block_runtime_if_missing") is False, f"{field_name} must not block runtime if missing")
    ensure(
        field.get("observation_metric") is (field_name in OBSERVATION_METRIC_FIELDS),
        f"{field_name} has wrong observation_metric",
    )
    ensure(
        field.get("should_block_patch_if_missing") is (field_name in PATCH_BLOCKING_FIELDS),
        f"{field_name} has wrong should_block_patch_if_missing",
    )


def validate_trace_fields(fields: list[dict[str, Any]]) -> None:
    field_names = [as_string(field.get("field_name")) for field in fields]
    ensure(field_names == list(EXPECTED_TRACE_FIELDS), f"trace fields must be ordered as {list(EXPECTED_TRACE_FIELDS)}")
    for field in fields:
        validate_trace_field(field)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def materialize_getdraft_dialogue_candidates(
    rules_input: Path,
    trace_fields_input: Path,
    output_dir: Path,
) -> MaterializedArtifacts:
    generated_at = datetime.now(timezone.utc).isoformat()
    rules = parse_jsonl_objects(rules_input)
    trace_fields = parse_jsonl_objects(trace_fields_input)

    validate_rules(rules)
    validate_trace_fields(trace_fields)

    rules_path = output_dir / "getdraft-dialogue-candidate-rules.json"
    trace_fields_path = output_dir / "getdraft-dialogue-trace-fields.json"
    summary_path = output_dir / "getdraft-dialogue-materialization-summary.json"

    write_json(
        rules_path,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "source": "getdraft_dialogue",
            "validationStatus": "candidate",
            "runtimeDefaultEnabled": False,
            "promotionGate": {
                "sampleSizeAtLeast": 3,
                "validatedWinRateAtLeast": 0.55,
                "requiresReplayPromotion": True,
            },
            "entries": rules,
        },
    )
    write_json(
        trace_fields_path,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "source": "getdraft_dialogue",
            "validationStatus": "candidate",
            "runtimeDefaultEnabled": False,
            "fields": trace_fields,
        },
    )
    write_json(
        summary_path,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "source": "getdraft_dialogue",
            "validationStatus": "candidate",
            "runtimeDefaultEnabled": False,
            "ruleCount": len(rules),
            "traceFieldCount": len(trace_fields),
            "observationRuleIds": [rule["id"] for rule in rules if rule.get("observation_mode") is True],
            "observationMetricFields": [
                field["field_name"] for field in trace_fields if field.get("observation_metric") is True
            ],
            "patchBlockingMissingFields": [
                field["field_name"] for field in trace_fields if field.get("should_block_patch_if_missing") is True
            ],
        },
    )

    return MaterializedArtifacts(
        rulesPath=rules_path,
        traceFieldsPath=trace_fields_path,
        summaryPath=summary_path,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize candidate-only GetDraft dialogue rules and trace-field specs."
    )
    parser.add_argument("--rules-input", required=True, help="JSONL file containing 8 GetDraft dialogue candidate rules.")
    parser.add_argument(
        "--trace-fields-input",
        required=True,
        help="JSONL file containing trace-field specifications copied from GetDraft dialogue.",
    )
    parser.add_argument("--output-dir", required=True, help="Directory for materialized candidate-only artifacts.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        artifacts = materialize_getdraft_dialogue_candidates(
            rules_input=Path(args.rules_input),
            trace_fields_input=Path(args.trace_fields_input),
            output_dir=Path(args.output_dir),
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error

    print(
        json.dumps(
            {
                "rulesPath": artifacts.rulesPath.as_posix(),
                "traceFieldsPath": artifacts.traceFieldsPath.as_posix(),
                "summaryPath": artifacts.summaryPath.as_posix(),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
