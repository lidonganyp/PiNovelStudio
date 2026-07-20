"""
PiNovelStudio - Distill candidate author rules from replay regressions.

This script is intentionally local and deterministic. It reads replay benchmark
JSON reports, looks for replay-sensitive metric deficits, and writes enriched
benchmark copies with abstract candidateRules. It does not read reference or
candidate prose files and does not promote anything into runtime rules.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


METRIC_SLUGS = {
    "progression": "progression",
    "evidenceDelta": "evidence-delta",
    "choiceDelta": "choice-delta",
    "riskDelta": "risk-delta",
    "hookMovement": "hook-movement",
    "readerNeedToContinue": "reader-need-to-continue",
}


RULE_TEMPLATES = {
    "progression": {
        "craftMove": "Convert static description into a visible state change before the beat ends.",
        "mustDo": [
            "Name the before/after visible state change.",
            "Make one action change leverage, location, knowledge, risk, or obligation.",
            "Carry the changed state into the next beat.",
        ],
        "avoid": [
            "Atmosphere-only paragraphs that end with the same story state.",
            "Internal worry that replaces an observable consequence.",
        ],
        "microExample": "[abstract] Before: unknown risk. Beat: action tests one clue. After: risk, leverage, or obligation changes.",
    },
    "evidenceDelta": {
        "craftMove": "Add a verifiable information gain instead of leaving suspense as mood only.",
        "mustDo": [
            "Introduce one concrete clue, mismatch, proof, record, witness reaction, or physical trace.",
            "Let a character interpret or test the clue on-page.",
            "Show what the new information changes.",
        ],
        "avoid": [
            "Explaining that something is strange without adding a checkable fact.",
            "Repeating known setup as if it were new evidence.",
        ],
        "microExample": "[abstract] The scene supplies a checkable clue, then shows the new inference it forces.",
    },
    "choiceDelta": {
        "craftMove": "Force a visible character choice with cost, tradeoff, or irreversible direction.",
        "mustDo": [
            "Give the character two incompatible options.",
            "Attach a cost or lost opportunity to the selected option.",
            "Make the next beat inherit that choice.",
        ],
        "avoid": [
            "Passive reaction with no external decision.",
            "Choosing after the scene has already removed all alternatives.",
        ],
        "microExample": "[abstract] The character chooses one route and loses access to another.",
    },
    "riskDelta": {
        "craftMove": "Move danger closer, more specific, or more costly within the current beat.",
        "mustDo": [
            "Turn named danger into proximity, deadline, exposure, injury, debt, or loss.",
            "Make the risk harder to ignore than it was at the start.",
            "Tie the risk increase to the event's action or discovery.",
        ],
        "avoid": [
            "Declaring danger abstractly without changing pressure.",
            "Using the same threat label across multiple beats.",
        ],
        "microExample": "[abstract] Risk changes from background concern to immediate pressure with a concrete cost.",
    },
    "hookMovement": {
        "craftMove": "Make the ending hook causal to this chapter's evidence, choice, or risk change.",
        "mustDo": [
            "Seed the hook with a fact, action, or risk introduced earlier in the chapter.",
            "Let the final turn reframe that earlier material.",
            "Leave a precise next question rather than a generic warning.",
        ],
        "avoid": [
            "A final line that only says danger is coming.",
            "A hook that could be attached to any chapter.",
        ],
        "microExample": "[abstract] A prior clue returns at the end with a new implication and a specific question.",
    },
    "readerNeedToContinue": {
        "craftMove": "Combine new information, immediate pressure, and a concrete next question.",
        "mustDo": [
            "Show why the reader knows more than before.",
            "Show why waiting is costly or impossible.",
            "Make the next chapter's first problem legible.",
        ],
        "avoid": [
            "Ending on vague unease without a changed fact.",
            "Stacking mysteries without giving the reader new leverage.",
        ],
        "microExample": "[abstract] The chapter ends with new leverage, new pressure, and one clear question.",
    },
}


SCENE_ALIASES = {
    "daily": "daily_life",
    "daily_life": "daily_life",
    "slice_of_life": "daily_life",
    "suspense": "horror",
    "mystery": "horror",
    "horror": "horror",
    "conflict": "confrontation",
    "confrontation": "confrontation",
    "combat": "combat",
    "action": "combat",
    "romance": "romance",
    "general": "general",
}


@dataclass
class MetricDeficit:
    metric: str
    reference: float
    candidate: float
    gap: float


@dataclass
class CandidateRule:
    id: str
    sceneType: str
    narrativeBeat: str
    appliesWhen: list[str]
    craftMove: str
    mustDo: list[str]
    avoid: list[str]
    microExample: str
    sourceBook: str
    validationStatus: str
    distilledFrom: dict[str, Any]


@dataclass
class DistilledBenchmark:
    benchmarkId: str
    outputPath: str
    ruleIds: list[str] = field(default_factory=list)


@dataclass
class DistillSummary:
    schemaVersion: int
    generatedAt: str
    totalBenchmarks: int
    enrichedBenchmarks: int
    skippedBenchmarks: int
    totalRules: int
    benchmarks: list[DistilledBenchmark]


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def iter_json_files(path: Path) -> list[Path]:
    if path.is_file() and path.suffix.lower() == ".json":
        return [path]
    if path.is_dir():
        return sorted(item for item in path.rglob("*.json") if item.is_file())
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
        values.extend(
            [
                candidate.get("generatedBy"),
                candidate.get("generated_by"),
                candidate.get("generationTool"),
                candidate.get("generation_tool"),
            ]
        )

    return any(str(value).strip() == "novel_generate_chapter" for value in values if value is not None)


def as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def as_string(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_ -]+", "", value.strip().lower())
    cleaned = re.sub(r"[\s_]+", "-", cleaned).strip("-")
    return cleaned or "general"


def normalize_scene_type(value: Any) -> str:
    raw = as_string(value, "general").lower()
    return SCENE_ALIASES.get(raw, raw or "general")


def metadata_events(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    events = metadata.get("events")
    if not isinstance(events, list):
        return []
    return [event for event in events if isinstance(event, dict)]


def derive_scene_type(metadata: dict[str, Any]) -> str:
    candidates: list[Any] = [
        metadata.get("sceneType"),
        metadata.get("scene_type"),
        metadata.get("genre"),
    ]
    candidates.extend(event.get("sceneType") or event.get("scene_type") for event in metadata_events(metadata))
    for candidate in candidates:
        if as_string(candidate):
            return normalize_scene_type(candidate)
    return "general"


def derive_narrative_beat(metadata: dict[str, Any]) -> str:
    candidates: list[Any] = [
        metadata.get("narrativeBeat"),
        metadata.get("narrative_beat"),
        metadata.get("chapterFunction"),
        metadata.get("chapter_function"),
    ]
    candidates.extend(event.get("narrativeBeat") or event.get("narrative_beat") or event.get("type") for event in metadata_events(metadata))
    for candidate in candidates:
        if as_string(candidate):
            return slug(str(candidate))
    return "general"


def derive_source_book(metadata: dict[str, Any]) -> str:
    for key in ("sourceBook", "source_book", "bookId", "book_id"):
        value = as_string(metadata.get(key))
        if value:
            return value
    source = metadata.get("source")
    if isinstance(source, dict):
        for key in ("bookId", "book_id", "title"):
            value = as_string(source.get(key))
            if value:
                return value
    return "unknown"


def find_metric_deficits(benchmark: dict[str, Any], min_gap: float, min_floor: float) -> list[MetricDeficit]:
    reference = benchmark.get("referenceMetrics")
    candidate = benchmark.get("candidateMetrics")
    if not isinstance(reference, dict) or not isinstance(candidate, dict):
        return []

    deficits: list[MetricDeficit] = []
    for metric in METRIC_SLUGS:
        reference_value = as_float(reference.get(metric))
        candidate_value = as_float(candidate.get(metric))
        if reference_value is None or candidate_value is None:
            continue
        gap = round(reference_value - candidate_value, 4)
        if gap >= min_gap or (candidate_value <= min_floor and gap > 0.01):
            deficits.append(
                MetricDeficit(
                    metric=metric,
                    reference=round(reference_value, 4),
                    candidate=round(candidate_value, 4),
                    gap=gap,
                )
            )
    return deficits


def build_rule(
    benchmark: dict[str, Any],
    metadata: dict[str, Any],
    deficit: MetricDeficit,
    generated_at: str,
) -> CandidateRule:
    scene_type = derive_scene_type(metadata)
    narrative_beat = derive_narrative_beat(metadata)
    source_book = derive_source_book(metadata)
    benchmark_id = as_string(benchmark.get("benchmarkId"), "unknown")
    metric_slug = METRIC_SLUGS[deficit.metric]
    template = RULE_TEMPLATES[deficit.metric]

    applies_when = [
        f"scene:{scene_type}",
        f"beat:{narrative_beat}",
        f"metric:{deficit.metric}",
    ]

    return CandidateRule(
        id=f"replay-{slug(scene_type)}-{metric_slug}",
        sceneType=scene_type,
        narrativeBeat=narrative_beat,
        appliesWhen=applies_when,
        craftMove=template["craftMove"],
        mustDo=list(template["mustDo"]),
        avoid=list(template["avoid"]),
        microExample=template["microExample"],
        sourceBook=source_book,
        validationStatus="candidate",
        distilledFrom={
            "source": "replay_benchmark",
            "benchmarkId": benchmark_id,
            "metric": deficit.metric,
            "referenceScore": deficit.reference,
            "candidateScore": deficit.candidate,
            "gap": deficit.gap,
            "generatedAt": generated_at,
        },
    )


def rule_key(rule: dict[str, Any]) -> str:
    return as_string(rule.get("id")) or slug(as_string(rule.get("craftMove"), "rule"))


def merge_candidate_rules(existing: Any, distilled: list[CandidateRule]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    if isinstance(existing, list):
        for item in existing:
            if not isinstance(item, dict):
                continue
            key = rule_key(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    for rule in distilled:
        item = asdict(rule)
        key = rule_key(item)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)

    return merged


def output_path_for(input_path: Path, benchmark_root: Path, output_dir: Path) -> Path:
    if benchmark_root.is_file():
        return output_dir / input_path.name
    try:
        relative = input_path.relative_to(benchmark_root)
    except ValueError:
        relative = Path(input_path.name)
    return output_dir / relative


def distill_author_rules(
    benchmark_dir: Path,
    output_dir: Path,
    min_gap: float,
    min_floor: float,
) -> DistillSummary:
    generated_at = datetime.now(timezone.utc).isoformat()
    total_benchmarks = 0
    skipped_benchmarks = 0
    total_rules = 0
    benchmarks: list[DistilledBenchmark] = []

    for input_path in iter_json_files(benchmark_dir):
        parsed = read_json(input_path)
        if not is_replay_benchmark(parsed):
            continue
        total_benchmarks += 1

        if not has_orchestrator_proof(parsed):
            skipped_benchmarks += 1
            continue

        metadata = parsed["metadata"]
        deficits = find_metric_deficits(parsed, min_gap=min_gap, min_floor=min_floor)
        distilled_rules = [
            build_rule(parsed, metadata, deficit, generated_at=generated_at)
            for deficit in deficits
        ]
        enriched = dict(parsed)
        enriched["candidateRules"] = merge_candidate_rules(parsed.get("candidateRules"), distilled_rules)

        output_path = output_path_for(input_path, benchmark_dir, output_dir)
        write_json(output_path, enriched)
        rule_ids = [rule.id for rule in distilled_rules]
        total_rules += len(enriched["candidateRules"])
        benchmarks.append(
            DistilledBenchmark(
                benchmarkId=as_string(parsed.get("benchmarkId"), input_path.stem),
                outputPath=str(output_path),
                ruleIds=rule_ids,
            )
        )

    return DistillSummary(
        schemaVersion=1,
        generatedAt=generated_at,
        totalBenchmarks=total_benchmarks,
        enrichedBenchmarks=len(benchmarks),
        skippedBenchmarks=skipped_benchmarks,
        totalRules=total_rules,
        benchmarks=benchmarks,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Distill candidate author rules from replay benchmark regressions.")
    parser.add_argument("--benchmark-dir", required=True, help="Replay benchmark JSON file or directory.")
    parser.add_argument("--output-dir", required=True, help="Directory for enriched benchmark copies and summary.")
    parser.add_argument("--min-gap", type=float, default=0.15, help="Minimum reference-candidate metric gap.")
    parser.add_argument("--min-floor", type=float, default=0.2, help="Candidate floor that triggers a rule when reference is higher.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    summary = distill_author_rules(
        benchmark_dir=Path(args.benchmark_dir),
        output_dir=Path(args.output_dir),
        min_gap=max(0.0, args.min_gap),
        min_floor=max(0.0, min(1.0, args.min_floor)),
    )
    write_json(Path(args.output_dir) / "distilled-author-rules.json", asdict(summary))


if __name__ == "__main__":
    main()
