"""
PiNovelStudio - Distill replay-gated candidate rules from GetDraft archives.

This script treats GetDraft as a provenance source for candidate experience,
not as runtime evidence. It emits abstract micro-rules for selected failure
axes only when matching archive evidence exists. It never writes validated
runtime rules; replay promotion remains the only path into default runtime use.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AxisTemplate:
    axis: str
    id: str
    sceneType: str
    appliesWhen: list[str]
    craftMove: str
    mustDo: list[str]
    avoid: list[str]
    microExample: str
    evidenceGroups: list[list[str]]
    pathHints: list[str]


@dataclass
class SourceDocument:
    path: Path
    displayPath: str
    text: str


@dataclass
class GetDraftCandidateRule:
    id: str
    sceneType: str
    appliesWhen: list[str]
    craftMove: str
    mustDo: list[str]
    avoid: list[str]
    microExample: str
    validationStatus: str
    distilledFrom: dict[str, Any]


AXIS_CATALOG: dict[str, AxisTemplate] = {
    "dialogue_propulsion": AxisTemplate(
        axis="dialogue_propulsion",
        id="getdraft-dialogue-propulsion",
        sceneType="general",
        appliesWhen=[
            "axis:dialogue_propulsion",
            "stage:stage2",
            "metric:progression",
            "metric:choiceDelta",
        ],
        craftMove="Make each dialogue turn change information, risk, decision, or relationship.",
        mustDo=[
            "Before accepting a dialogue span, name the state it changes.",
            "Tie at least one turn to new information, raised risk, a forced decision, or a relationship shift.",
            "Carry the changed state into the next beat instead of resetting to talk-only exchange.",
        ],
        avoid=[
            "Banter or explanation that leaves leverage unchanged.",
            "Multiple turns where speakers restate known positions.",
        ],
        microExample="[abstract] A reply reveals leverage, forces a choice, or changes the relationship before the exchange exits.",
        evidenceGroups=[
            ["dialogue", "对话"],
            ["information", "信息", "risk", "风险", "decision", "决定", "relationship", "关系", "推进", "改变"],
        ],
        pathHints=["dialogue", "对话", "群像戏"],
    ),
    "location_continuity": AxisTemplate(
        axis="location_continuity",
        id="getdraft-location-continuity",
        sceneType="general",
        appliesWhen=[
            "axis:location_continuity",
            "stage:stage8",
            "metric:progression",
            "gate:scene_continuity",
        ],
        craftMove="Open every location or scene shift with a spatial bridge and current-location anchor.",
        mustDo=[
            "When a scene changes location, make the first sentence anchor current place, route, or entry evidence.",
            "Show how the character got from the prior space to the new space when the jump could confuse continuity.",
            "For multi-character scenes, refresh spatial positions before escalating action or dialogue.",
        ],
        avoid=[
            "Hard location jumps with no bridge when the prior paragraph was anchored elsewhere.",
            "Entity arrivals that appear in a new space without entry evidence.",
        ],
        microExample="[abstract] Before the next action, the paragraph names the new place and the transition evidence that put the character there.",
        evidenceGroups=[
            ["location", "位置", "空间", "场景切换", "转场", "过门"],
            ["anchor", "锚", "重置", "第一句", "bridge", "进入"],
        ],
        pathHints=["ensemble", "群像戏"],
    ),
    "hook_causality": AxisTemplate(
        axis="hook_causality",
        id="getdraft-hook-causality",
        sceneType="general",
        appliesWhen=[
            "axis:hook_causality",
            "stage:stage2",
            "stage:stage8",
            "metric:hookMovement",
            "metric:readerNeedToContinue",
        ],
        craftMove="Make the ending hook causal to this chapter's evidence, choice, or risk change.",
        mustDo=[
            "Seed the hook with material that appeared earlier in the chapter.",
            "Let the final turn reframe a fact, choice, deadline, or cost the chapter actually changed.",
            "Leave a precise next question instead of a portable danger line.",
        ],
        avoid=[
            "A generic warning that could end any chapter.",
            "A hook that borrows tension from an unseeded new threat.",
        ],
        microExample="[abstract] A prior clue returns at the end with a changed implication and a specific next problem.",
        evidenceGroups=[
            ["hook", "钩子", "章末", "悬念"],
            ["causal", "因果", "evidence", "证据", "choice", "选择", "risk", "风险", "对应", "债"],
        ],
        pathHints=["hook", "hooks", "连载读者预期", "第九轮"],
    ),
    "anti_ai_span_repair": AxisTemplate(
        axis="anti_ai_span_repair",
        id="getdraft-anti-ai-span-repair",
        sceneType="general",
        appliesWhen=[
            "axis:anti_ai_span_repair",
            "stage:stage5",
            "stage:stage8",
            "metric:ai_filler_density",
            "metric:readerNeedToContinue",
        ],
        craftMove="Repair AI-flavored spans locally, then compare the patch against the original before accepting it.",
        mustDo=[
            "Locate the specific sentence or ending span carrying template language.",
            "Patch only the failing span with concrete chapter evidence, action, or sensory detail.",
            "Reject the patch if it weakens causality, voice, or reader pull compared with the original.",
        ],
        avoid=[
            "Whole-chapter rewriting for a small template phrase.",
            "Replacing one generic suspense phrase with another.",
        ],
        microExample="[abstract] The generic ending sentence is replaced by a specific consequence from this chapter, then regression-checked.",
        evidenceGroups=[
            ["anti-ai", "antiai", "AI腔", "模板"],
            ["rewrite", "重写", "局部", "span", "修订", "patch", "补丁"],
        ],
        pathHints=["连载读者预期", "第九轮", "实施报告"],
    ),
}


def read_text_with_fallback(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
        except OSError:
            return ""
    return ""


def normalize_for_match(value: str) -> str:
    return re.sub(r"\s+", " ", value).lower()


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def load_documents(source_dir: Path) -> list[SourceDocument]:
    if source_dir.is_file():
        paths = [source_dir]
    elif source_dir.is_dir():
        paths = sorted(
            item for item in source_dir.rglob("*.md")
            if item.is_file()
        )
    else:
        paths = []

    documents: list[SourceDocument] = []
    for path in paths:
        text = read_text_with_fallback(path)
        if not text.strip():
            continue
        documents.append(
            SourceDocument(
                path=path,
                displayPath=display_path(path),
                text=text,
            )
        )
    return documents


def group_matches(text: str, terms: list[str]) -> bool:
    normalized = normalize_for_match(text)
    return any(term.lower() in normalized for term in terms)


def path_matches(document: SourceDocument, hints: list[str]) -> bool:
    if not hints:
        return True
    normalized_path = normalize_for_match(document.displayPath)
    return any(hint.lower() in normalized_path for hint in hints)


def matching_documents(template: AxisTemplate, documents: list[SourceDocument]) -> list[SourceDocument]:
    matches: list[SourceDocument] = []
    for document in documents:
        if not path_matches(document, template.pathHints):
            continue
        if all(group_matches(document.text, group) for group in template.evidenceGroups):
            matches.append(document)
    return matches


def build_rule(template: AxisTemplate, documents: list[SourceDocument], generated_at: str) -> GetDraftCandidateRule:
    return GetDraftCandidateRule(
        id=template.id,
        sceneType=template.sceneType,
        appliesWhen=list(template.appliesWhen),
        craftMove=template.craftMove,
        mustDo=list(template.mustDo),
        avoid=list(template.avoid),
        microExample=template.microExample,
        validationStatus="candidate",
        distilledFrom={
            "source": "getdraft_archive",
            "failureAxis": template.axis,
            "documents": [document.displayPath for document in documents],
            "requiresReplayPromotion": True,
            "promotionGate": {
                "sampleSizeAtLeast": 3,
                "winRateAtLeast": 0.55,
            },
            "generatedAt": generated_at,
        },
    )


def resolve_axes(axis_values: list[str] | None) -> list[str]:
    axes = axis_values or list(AXIS_CATALOG)
    unknown = [axis for axis in axes if axis not in AXIS_CATALOG]
    if unknown:
        known = ", ".join(sorted(AXIS_CATALOG))
        raise ValueError(f"Unknown axis: {', '.join(unknown)}. Known axes: {known}")
    return axes


def distill_getdraft_candidates(source_dir: Path, axes: list[str]) -> dict[str, Any]:
    generated_at = datetime.now(timezone.utc).isoformat()
    documents = load_documents(source_dir)
    entries: list[dict[str, Any]] = []
    skipped_axes: list[dict[str, str]] = []

    for axis in axes:
        template = AXIS_CATALOG[axis]
        matches = matching_documents(template, documents)
        if not matches:
            skipped_axes.append(
                {
                    "axis": axis,
                    "reason": "no matching GetDraft archive evidence",
                }
            )
            continue
        entries.append(asdict(build_rule(template, matches, generated_at)))

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "source": "getdraft_archive",
        "validationStatus": "candidate",
        "runtimeDefaultEnabled": False,
        "entries": entries,
        "skippedAxes": skipped_axes,
    }


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Distill replay-gated candidate rules from GetDraft archive evidence."
    )
    parser.add_argument("--source-dir", required=True, help="GetDraft archive markdown file or directory.")
    parser.add_argument("--output", required=True, help="Output JSON path for candidate-only rules.")
    parser.add_argument(
        "--axis",
        action="append",
        help="Failure axis to distill. May be repeated. Defaults to all known axes.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        axes = resolve_axes(args.axis)
        result = distill_getdraft_candidates(Path(args.source_dir), axes)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    write_json(Path(args.output), result)


if __name__ == "__main__":
    main()
