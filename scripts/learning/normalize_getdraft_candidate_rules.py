"""
PiNovelStudio — Normalize GetDraft dialogue candidate rules.

Splits the 8 GetDraft dialogue candidate rules into two role-specific outputs:

- Stage 2 craft rule candidates (DP-001/DP-002/HC-001/HC-002):
    Lightweight schema compatible with the runtime craft rule selector
    (id/sceneType/appliesWhen/craftMove/mustDo/avoid/microExample) plus a
    distilledFrom block. These are CANDIDATE only — they do not enter
    validated-craft-rules.json. Promotion still requires replay evidence
    aggregated by promote_validated_rules.py.

- Stage 5/8 local repair specs (LC-001/LC-002/AA-001/AA-002):
    Preserves trigger_predicate / repair_actions / rollback_criteria /
    observation_mode / replay_metrics. Stage 5/8 entry points may consume
    these for observation-mode logging only; PatchQualityComparator remains
    the sole patch acceptance authority.

This script never writes to validated-craft-rules.json.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STAGE2_RULE_IDS: tuple[str, ...] = ("DP-001", "DP-002", "HC-001", "HC-002")
LOCAL_REPAIR_RULE_IDS: tuple[str, ...] = ("LC-001", "LC-002", "AA-001", "AA-002")

# Stage 2 lightweight rule template — keyed by source rule id.
# craftMove / mustDo / avoid / microExample are abstract guidance phrased so
# the validated-craft-rule selector and event-writing-contract can consume
# them without leaking the full python-style trigger DSL.
STAGE2_TEMPLATES: dict[str, dict[str, Any]] = {
    "DP-001": {
        "sceneType": "general",
        "appliesWhen": [
            "axis:dialogue_propulsion",
            "stage:stage2",
            "metric:state_delta",
            "metric:choice_delta",
            "metric:risk_delta",
        ],
        "craftMove": "Make each dialogue event end with a visible state, choice, or risk delta.",
        "mustDo": [
            "Before closing a dialogue event, name the state shift (information, choice, risk).",
            "Tie at least one turn to a forced choice, raised risk, or new knowledge.",
            "Carry the changed state into the next beat instead of resetting to talk-only exchange.",
        ],
        "avoid": [
            "Banter or restated positions that leave leverage unchanged.",
            "Closing on emotion-only beats without any delta.",
        ],
        "microExample": (
            "[abstract] A reply forces a choice, raises risk, or "
            "delivers new information before the exchange exits."
        ),
    },
    "DP-002": {
        "sceneType": "general",
        "appliesWhen": [
            "axis:dialogue_propulsion",
            "stage:stage2",
            "beat:revelation",
            "beat:confrontation",
            "beat:decision",
            "metric:protagonist_active",
        ],
        "craftMove": "In revelation/confrontation/decision dialogue, keep the protagonist active.",
        "mustDo": [
            "Give the protagonist at least one turn that questions, challenges, or asserts.",
            "Refuse passive acceptance during revelation, confrontation, or decision beats.",
            "Tie the protagonist's active turn to a downstream consequence or commitment.",
        ],
        "avoid": [
            "Letting the protagonist only react with internal monologue during high-stakes beats.",
            "Replacing protagonist agency with bystander narration.",
        ],
        "microExample": (
            "[abstract] In a revelation beat, the protagonist names the "
            "stake, asks the cornering question, or refuses the framing."
        ),
    },
    "HC-001": {
        "sceneType": "general",
        "appliesWhen": [
            "axis:hook_causality",
            "stage:stage2",
            "scope:chapter_end",
            "metric:hook_evidence_chain",
        ],
        "craftMove": "Anchor the chapter-end hook in evidence introduced earlier in the chapter.",
        "mustDo": [
            "Reuse a prior fact, action, or risk seeded earlier when forming the hook.",
            "Let the final turn reframe earlier material rather than introducing brand-new elements.",
            "Leave a precise next question rather than a generic warning.",
        ],
        "avoid": [
            "Hook lines that could be attached to any chapter.",
            "Final turns that introduce wholly new entities or facts not seeded before.",
        ],
        "microExample": (
            "[abstract] A clue from earlier returns at the end with a "
            "new implication and a specific next question."
        ),
    },
    "HC-002": {
        "sceneType": "general",
        "appliesWhen": [
            "axis:hook_causality",
            "stage:stage2",
            "scope:chapter_end",
            "metric:hook_movement",
            "metric:information_delta",
            "metric:risk_delta",
        ],
        "craftMove": "Make the chapter-end hook move state — information, risk, or commitment must change.",
        "mustDo": [
            "Make the closing beat raise risk, deliver new information, or force a commitment.",
            "Show why waiting would be costly — the next chapter's first problem must be legible.",
            "Avoid restating the same suspense already present at chapter open.",
        ],
        "avoid": [
            "Endings that only restate atmosphere or repeat opening uncertainty.",
            "Stacking new mysteries without giving the reader new leverage.",
        ],
        "microExample": (
            "[abstract] The chapter ends with new leverage, new pressure, "
            "and one clear question for the next chapter."
        ),
    },
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, indent=2)
    path.write_text(body + "\n", encoding="utf-8")


def collect_source_documents(entry: dict[str, Any]) -> list[str]:
    raw = entry.get("source_documents") or entry.get("sourceDocuments") or []
    if isinstance(raw, list):
        return [str(item) for item in raw if isinstance(item, str)]
    return []


def build_stage2_entry(entry: dict[str, Any], generated_at: str) -> dict[str, Any]:
    rule_id = str(entry.get("id"))
    template = STAGE2_TEMPLATES[rule_id]
    promotion_gate = entry.get("promotion_gate") or {}
    distilled = {
        "source": "getdraft_dialogue",
        "axis": entry.get("axis"),
        "priority": entry.get("priority"),
        "originalRuleId": rule_id,
        "requiresReplayPromotion": True,
        "promotionGate": {
            "sampleSizeAtLeast": int(promotion_gate.get("sample_size_at_least", 3)),
            "validatedWinRateAtLeast": float(promotion_gate.get("validated_win_rate_at_least", 0.55)),
        },
        "generatedAt": generated_at,
    }
    documents = collect_source_documents(entry)
    if documents:
        distilled["documents"] = documents

    return {
        "id": rule_id,
        "sceneType": template["sceneType"],
        "appliesWhen": list(template["appliesWhen"]),
        "craftMove": template["craftMove"],
        "mustDo": list(template["mustDo"]),
        "avoid": list(template["avoid"]),
        "microExample": template["microExample"],
        "validationStatus": "candidate",
        "runtimeDefaultEnabled": False,
        "distilledFrom": distilled,
    }


def build_local_repair_entry(entry: dict[str, Any], generated_at: str) -> dict[str, Any]:
    promotion_gate = entry.get("promotion_gate") or {}
    return {
        "id": entry.get("id"),
        "axis": entry.get("axis"),
        "priority": entry.get("priority"),
        "validationStatus": "candidate",
        "runtimeDefaultEnabled": False,
        "observationMode": bool(entry.get("observation_mode", False)),
        "patchUnit": entry.get("patch_unit"),
        "triggerPredicate": entry.get("trigger_predicate"),
        "requiredTraceFields": list(entry.get("required_trace_fields") or []),
        "suggestedNewTraceFields": list(entry.get("suggested_new_trace_fields") or []),
        "repairActions": list(entry.get("repair_actions") or []),
        "acceptanceCriteria": entry.get("acceptance_criteria") or {},
        "rollbackCriteria": list(entry.get("rollback_criteria") or []),
        "replayMetrics": list(entry.get("replay_metrics") or []),
        "observationFields": list(entry.get("observation_fields") or []),
        "fixtureCoverage": list(entry.get("fixture_coverage") or []),
        "nonPromotionReasons": list(entry.get("non_promotion_reasons") or []),
        "promotionGate": {
            "sampleSizeAtLeast": int(promotion_gate.get("sample_size_at_least", 3)),
            "validatedWinRateAtLeast": float(promotion_gate.get("validated_win_rate_at_least", 0.55)),
            "requiresReplayPromotion": bool(promotion_gate.get("requires_replay_promotion", True)),
        },
        "distilledFrom": {
            "source": "getdraft_dialogue",
            "originalRuleId": entry.get("id"),
            "generatedAt": generated_at,
        },
    }


def normalize(input_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    parsed = read_json(input_path)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("entries"), list):
        raise ValueError(
            f"Expected GetDraft dialogue candidate file with 'entries' list at: {input_path}"
        )

    entries_by_id = {entry.get("id"): entry for entry in parsed["entries"] if isinstance(entry, dict)}
    missing_stage2 = [rule_id for rule_id in STAGE2_RULE_IDS if rule_id not in entries_by_id]
    missing_local = [rule_id for rule_id in LOCAL_REPAIR_RULE_IDS if rule_id not in entries_by_id]
    missing = missing_stage2 + missing_local
    if missing:
        raise ValueError(
            "GetDraft dialogue candidate file is missing required rule ids: "
            + ", ".join(missing)
        )

    generated_at = datetime.now(timezone.utc).isoformat()
    stage2_entries = [
        build_stage2_entry(entries_by_id[rule_id], generated_at) for rule_id in STAGE2_RULE_IDS
    ]
    local_repair_entries = [
        build_local_repair_entry(entries_by_id[rule_id], generated_at)
        for rule_id in LOCAL_REPAIR_RULE_IDS
    ]

    stage2_doc = {
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
        "entries": stage2_entries,
    }
    local_repair_doc = {
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
        "entries": local_repair_entries,
    }
    return stage2_doc, local_repair_doc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        default="data/runtime/getdraft-dialogue/getdraft-dialogue-candidate-rules.json",
        help="GetDraft dialogue candidate rules JSON.",
    )
    parser.add_argument(
        "--stage2-output",
        default="data/runtime/getdraft-stage2-candidate-rules.json",
        help="Stage 2 craft rule candidates output (DP-001/DP-002/HC-001/HC-002).",
    )
    parser.add_argument(
        "--local-repair-output",
        default="data/runtime/local-repair-candidate-specs.json",
        help="Stage 5/8 local repair candidate specs output (LC-001/LC-002/AA-001/AA-002).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    stage2_doc, local_repair_doc = normalize(Path(args.input))
    write_json(Path(args.stage2_output), stage2_doc)
    write_json(Path(args.local_repair_output), local_repair_doc)
    print(
        f"wrote {len(stage2_doc['entries'])} stage2 candidates -> {args.stage2_output}"
    )
    print(
        f"wrote {len(local_repair_doc['entries'])} local repair specs -> {args.local_repair_output}"
    )


if __name__ == "__main__":
    main()
