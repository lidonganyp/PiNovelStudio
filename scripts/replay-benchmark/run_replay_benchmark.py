"""
PiNovelStudio — Replay benchmark runner.

Offline deterministic grader for comparing a generated candidate chapter or
segment against a reference text. The output is intentionally machine-readable:
it carries score evidence and candidate craft rules into the learning pipeline.
"""

import argparse
import json
import math
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ACTION_PATTERN = re.compile(
    r"按|推|拽|挡|递|拿|压|藏|偏|停|退|进|看|敲|摁|松|握|抬|落|掀|扣|翻|移|贴|撞|避|伸|收|"
    r"\b(hit|shut|pressed|slid|sliding|looked|stepped|lifted|stopped|moved|locked|opened|closed|took|gave|held)\b",
    re.IGNORECASE,
)
SENSORY_PATTERN = re.compile(
    r"雨|水|灯|风|血|汗|冷|热|疼|痛|声|响|气味|铁锈|尘|泥|砖|伞|账册|纸|门|巷|腕骨|指尖|呼吸|"
    r"\b(rain|wet|sign|seal|counter|drawer|lock|thumb|sleeve|finger|fingers|red|torn|clinic|ledger|receipt)\b",
    re.IGNORECASE,
)
CONFLICT_PATTERN = re.compile(
    r"威胁|代价|让步|暴露|危险|债|账|利息|翻倍|减半|拿走|副本|输|赢|逼|压|冲突|秘密|真相|"
    r"\b(fee|receipt|drawer|lock|stopped|danger|choice|risk|cost|keep|leaves|back)\b",
    re.IGNORECASE,
)
DIALOGUE_PATTERN = re.compile(r"[“”\"「」『』]")
AI_FILLER_PATTERN = re.compile(
    r"因为|所以|感到|就在这时|气氛变得|非常|十分|极其|很紧张|很危险|必须想办法|这个问题|"
    r"\b(very|extremely|important|dangerous|nervous|situation|problem|felt|because)\b",
    re.IGNORECASE,
)
EVIDENCE_DELTA_PATTERN = re.compile(
    r"\b(receipt|tag|number|marked|mismatch|evidence|cabinet|clue|locked|matched|compared|seal|ledger|document|record|proof|screenshot|photo|monitor|timestamp|fingerprint)\b",
    re.IGNORECASE,
)
CHOICE_DELTA_PATTERN = re.compile(
    r"\b(choosing|choose|chose|choice|leave|leaves|left|back stairs|instead|if|decided|refused|turned|kept|opened|closed|locked)\b",
    re.IGNORECASE,
)
RISK_DELTA_PATTERN = re.compile(
    r"\b(knocking|moved|closer|close|door beside|danger|ward|threat|near|approached|behind|beside|deadline|blood|locked)\b",
    re.IGNORECASE,
)
HOOK_MOVEMENT_PATTERN = re.compile(
    r"\b(final tag|phone number|own phone number|own number|carried|revealed|message|note|clue|evidence|receipt|tag|number|identity|name|door)\b|[?？]",
    re.IGNORECASE,
)
PROGRESSION_EVIDENCE_ANCHOR_PATTERN = re.compile(
    r"比对|核对|标记|确认|证明|对上|不匹配|错位|物证|证据|"
    r"\b(compared|marked|mismatch|matched|verified|proved|proof|evidence)\b",
    re.IGNORECASE,
)
PROGRESSION_CHOICE_ANCHOR_PATTERN = re.compile(
    r"选择|决定|拒绝|转而|改道|后退|退到|锁门|不开门|"
    r"\b(choosing|choose|chose|decided|refused|instead of|leave now|left|turned)\b",
    re.IGNORECASE,
)
PROGRESSION_RISK_ANCHOR_PATTERN = re.compile(
    r"逼近|靠近|移到|移动到|门边|门外|期限|威胁升级|风险升级|敲门声.{0,24}(?:靠近|逼近|移到)|"
    r"\b(knocking moved|moved from.{0,40}to|closer|approached|door beside|deadline|threat reached|risk rose)\b",
    re.IGNORECASE,
)
PROGRESSION_HOOK_ANCHOR_PATTERN = re.compile(
    r"钩子|尾声|号码.{0,24}(?:自己|本人|主角)|最后.{0,32}(?:证据|号码|标签|门|消息)|"
    r"\b(final tag|own phone number|own number|final.{0,32}(?:evidence|number|tag|door|message))\b",
    re.IGNORECASE,
)
PROGRESSION_EVIDENCE_SPAN_PATTERN = re.compile(
    r"(?:receipt|tag|number|record|document|screenshot|photo|monitor|timestamp|fingerprint|cabinet|drawer|seal|ledger|"
    r"\u7f16\u53f7|\u53f7\u7801|\u6807\u7b7e|\u5f55\u97f3|\u76d1\u63a7|\u622a\u56fe|\u7167\u7247|\u75c5\u5386|\u8bb0\u5f55|\u65f6\u95f4\u6233|\u67dc|\u62bd\u5c49|\u5c01\u6761|\u8d26\u518c)"
    r".{0,90}"
    r"(?:compared|marked|matched|mismatch|verified|proved|confirmed|"
    r"\u6bd4\u5bf9|\u6838\u5bf9|\u6807\u8bb0|\u786e\u8ba4|\u8bc1\u660e|\u5bf9\u4e0a|\u4e0d\u5339\u914d|\u9519\u4f4d)"
    r"|"
    r"(?:compared|marked|matched|mismatch|verified|proved|confirmed|"
    r"\u6bd4\u5bf9|\u6838\u5bf9|\u6807\u8bb0|\u786e\u8ba4|\u8bc1\u660e|\u5bf9\u4e0a|\u4e0d\u5339\u914d|\u9519\u4f4d)"
    r".{0,90}"
    r"(?:receipt|tag|number|record|document|screenshot|photo|monitor|timestamp|fingerprint|cabinet|drawer|seal|ledger|"
    r"\u7f16\u53f7|\u53f7\u7801|\u6807\u7b7e|\u5f55\u97f3|\u76d1\u63a7|\u622a\u56fe|\u7167\u7247|\u75c5\u5386|\u8bb0\u5f55|\u65f6\u95f4\u6233|\u67dc|\u62bd\u5c49|\u5c01\u6761|\u8d26\u518c)",
    re.IGNORECASE,
)
PROGRESSION_CHOICE_CONSEQUENCE_SPAN_PATTERN = re.compile(
    r"(?:choosing|choose|chose|choice|decided|refused|instead of|back stairs|turned|left|locked|closed|opened|"
    r"\u9009\u62e9|\u51b3\u5b9a|\u62d2\u7edd|\u8f6c\u800c|\u6539\u9053|\u540e\u9000|\u9000\u5230|\u9501\u95e8|\u4e0d\u5f00\u95e8)"
    r".{0,110}"
    r"(?:so|therefore|forced|forcing|made|left|no longer|changed|trapped|obtained|kept|lost|"
    r"\u5bfc\u81f4|\u8feb\u4f7f|\u8ba9|\u4e8e\u662f|\u56e0\u6b64|\u7ed3\u679c|\u4f7f\u5f97|\u4e0d\u518d|\u83b7\u5f97|\u5931\u53bb|\u6539\u53d8|\u53d8\u6210)"
    r"|"
    r"(?:so|therefore|forced|forcing|made|left|no longer|changed|trapped|obtained|kept|lost|"
    r"\u5bfc\u81f4|\u8feb\u4f7f|\u8ba9|\u4e8e\u662f|\u56e0\u6b64|\u7ed3\u679c|\u4f7f\u5f97|\u4e0d\u518d|\u83b7\u5f97|\u5931\u53bb|\u6539\u53d8|\u53d8\u6210)"
    r".{0,110}"
    r"(?:choosing|choose|chose|choice|decided|refused|instead of|back stairs|turned|left|"
    r"\u9009\u62e9|\u51b3\u5b9a|\u62d2\u7edd|\u8f6c\u800c|\u6539\u9053|\u540e\u9000|\u9000\u5230)",
    re.IGNORECASE,
)
PROGRESSION_RISK_MOVEMENT_SPAN_PATTERN = re.compile(
    r"(?:knocking|footsteps|shadow|door|ward|corridor|deadline|"
    r"\u6572\u95e8|\u811a\u6b65|\u5f71\u5b50|\u95e8\u5916|\u95e8\u8fb9|\u75c5\u623f|\u8d70\u5eca|\u671f\u9650)"
    r".{0,110}"
    r"(?:moved from|moved to|approached|reached|beside|outside|from .{0,40} to|"
    r"\u79fb\u5230|\u79fb\u52a8\u5230|\u903c\u8fd1|\u9760\u8fd1|\u4e34\u95e8|\u5230\u4e86|\u538b\u5230|\u8d34\u5230)"
    r"|"
    r"(?:moved from|moved to|approached|reached|beside|outside|from .{0,40} to|"
    r"\u79fb\u5230|\u79fb\u52a8\u5230|\u903c\u8fd1|\u9760\u8fd1|\u4e34\u95e8|\u5230\u4e86|\u538b\u5230|\u8d34\u5230)"
    r".{0,110}"
    r"(?:knocking|footsteps|shadow|door|ward|corridor|deadline|"
    r"\u6572\u95e8|\u811a\u6b65|\u5f71\u5b50|\u95e8\u5916|\u95e8\u8fb9|\u75c5\u623f|\u8d70\u5eca|\u671f\u9650)",
    re.IGNORECASE,
)
PROGRESSION_HOOK_LINK_SPAN_PATTERN = re.compile(
    r"(?:final|last|ending|tail|"
    r"\u6700\u540e|\u7ed3\u5c3e|\u5c3e\u58f0|\u94a9\u5b50)"
    r".{0,110}"
    r"(?:own|same|previous|receipt|tag|identity|phone number|record|number|door|"
    r"\u81ea\u5df1|\u672c\u4eba|\u540c\u4e00|\u524d\u6587|\u6807\u7b7e|\u53f7\u7801|\u8eab\u4efd|\u624b\u673a\u53f7|\u8bb0\u5f55|\u95e8)"
    r"|"
    r"(?:own|same|previous|receipt|tag|identity|phone number|record|number|door|"
    r"\u81ea\u5df1|\u672c\u4eba|\u540c\u4e00|\u524d\u6587|\u6807\u7b7e|\u53f7\u7801|\u8eab\u4efd|\u624b\u673a\u53f7|\u8bb0\u5f55|\u95e8)"
    r".{0,110}"
    r"(?:final|last|ending|tail|"
    r"\u6700\u540e|\u7ed3\u5c3e|\u5c3e\u58f0|\u94a9\u5b50)",
    re.IGNORECASE,
)
READER_NEED_PATTERN = re.compile(
    r"\b(final|own|phone|number|knocking|closer|door|mismatch|evidence|clue|why|who|where|how|next|if)\b|[?？]",
    re.IGNORECASE,
)
SENTENCE_SPLIT_PATTERN = re.compile(r"[。！？!?；;\n]+")
WORD_PATTERN = re.compile(r"[\u4e00-\u9fa5]|[A-Za-z0-9_]+")


@dataclass
class TextMetrics:
    word_count: int
    sentence_count: int
    coverage: float
    concrete_density: float
    action_density: float
    conflict_density: float
    dialogue_density: float
    ai_filler_density: float
    sentence_balance: float
    progression: float
    evidenceDelta: float
    choiceDelta: float
    riskDelta: float
    hookMovement: float
    readerNeedToContinue: float


@dataclass
class ReplayScores:
    reference: float
    candidate: float
    delta: float


@dataclass
class ReplayBenchmarkResult:
    schemaVersion: int
    benchmarkId: str
    createdAt: str
    candidateWins: bool
    minDelta: float
    scores: ReplayScores
    referenceMetrics: TextMetrics
    candidateMetrics: TextMetrics
    metadata: dict[str, Any]
    candidateRules: list[dict[str, Any]] = field(default_factory=list)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def has_orchestrator_proof(metadata: dict[str, Any]) -> bool:
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


def require_orchestrator_proof(metadata: dict[str, Any], metadata_path: Path) -> None:
    if has_orchestrator_proof(metadata):
        return
    raise ValueError(
        f"{metadata_path}: replay metadata must prove the candidate came from novel_generate_chapter "
        "before it can enter the learning pipeline."
    )


def as_string(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def candidate_result_path(metadata: dict[str, Any]) -> str | None:
    candidate = metadata.get("candidate")
    if isinstance(candidate, dict):
        value = as_string(candidate.get("resultPath")) or as_string(candidate.get("result_path"))
        if value:
            return value
    return as_string(metadata.get("resultPath")) or as_string(metadata.get("result_path")) or None


def candidate_trace_path(metadata: dict[str, Any]) -> str | None:
    candidate = metadata.get("candidate")
    if isinstance(candidate, dict):
        value = (
            as_string(candidate.get("tracePath"))
            or as_string(candidate.get("trace_path"))
            or as_string(candidate.get("qualityTracePath"))
            or as_string(candidate.get("quality_trace_path"))
        )
        if value:
            return value
    return (
        as_string(metadata.get("tracePath"))
        or as_string(metadata.get("trace_path"))
        or as_string(metadata.get("qualityTracePath"))
        or as_string(metadata.get("quality_trace_path"))
        or None
    )


def resolve_metadata_path(raw_path: str, metadata_path: Path) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path

    candidates = [
        Path.cwd() / path,
        metadata_path.parent / path,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def read_json_object_safely(path: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def route_should_request_upstream_rewrite(route: dict[str, Any] | None) -> bool:
    return isinstance(route, dict) and route.get("shouldRequestUpstreamRewrite") is True


def find_stage8_anti_ai_repairable_route(stage8: dict[str, Any]) -> dict[str, Any] | None:
    anti_ai = stage8.get("antiAI")
    if isinstance(anti_ai, dict) and as_string(anti_ai.get("routeGate")) == "anti_ai_repairable":
        return anti_ai

    anti_ai_routes = stage8.get("antiAIRoutes")
    if not isinstance(anti_ai_routes, list):
        return None

    for entry in anti_ai_routes:
        if isinstance(entry, dict) and as_string(entry.get("gate")) == "anti_ai_repairable":
            return entry
    return None


def is_reviewable_anti_ai_generation_result(parsed: dict[str, Any] | None) -> bool:
    if not isinstance(parsed, dict):
        return False

    stage_results = parsed.get("stageResults")
    if not isinstance(stage_results, dict):
        return False

    stage8 = stage_results.get("stage8")
    if not isinstance(stage8, dict):
        return False

    anti_ai_route = find_stage8_anti_ai_repairable_route(stage8)
    if anti_ai_route is None or route_should_request_upstream_rewrite(anti_ai_route):
        return False

    anti_ai = stage8.get("antiAI")
    if isinstance(anti_ai, dict) and route_should_request_upstream_rewrite(anti_ai):
        return False

    return True


def require_successful_generation_result(metadata: dict[str, Any], metadata_path: Path) -> None:
    raw_path = candidate_result_path(metadata)
    if raw_path is None:
        return

    result_path = resolve_metadata_path(raw_path, metadata_path)
    parsed = read_json_object_safely(result_path)
    status = as_string(parsed.get("status")) if isinstance(parsed, dict) else ""
    # P0: completed_with_review 需要人工复核，不能自动视为成功
    if status in {"success", "passed", "complete", "completed"}:
        return
    if is_reviewable_anti_ai_generation_result(parsed):
        return

    raise ValueError(
        f"{metadata_path}: replay metadata references {result_path}, but candidate generation "
        "result must be successful before it can enter replay benchmark statistics."
    )


def event_has_stage2_evidence(event: Any) -> bool:
    return isinstance(event, dict) and (
        isinstance(event.get("progression"), dict) or isinstance(event.get("evaluation"), dict)
    )


def trace_has_revision_or_final_gate_evidence(trace: dict[str, Any]) -> bool:
    patches = trace.get("patches")
    if isinstance(patches, list) and any(isinstance(patch, dict) for patch in patches):
        return True

    gates = trace.get("gates")
    if not isinstance(gates, list):
        return False
    for gate in gates:
        if not isinstance(gate, dict):
            continue
        stage = as_string(gate.get("stage")).lower()
        if stage.startswith("stage5") or stage.startswith("stage8"):
            return True
        route_decision = as_string(gate.get("routeDecision")).lower()
        result = as_string(gate.get("result")).lower()
        if route_decision == "completed_with_review" or result == "human_review":
            return True
    return False


def has_complete_quality_trace(trace: dict[str, Any]) -> bool:
    if trace.get("schemaVersion") != 1:
        return False
    events = trace.get("events")
    if not isinstance(events, list) or not events:
        return False
    if not any(event_has_stage2_evidence(event) for event in events):
        return False
    return trace_has_revision_or_final_gate_evidence(trace)


def require_complete_quality_trace(metadata: dict[str, Any], metadata_path: Path) -> None:
    raw_path = candidate_trace_path(metadata)
    if raw_path is None:
        return

    trace_path = resolve_metadata_path(raw_path, metadata_path)
    parsed = read_json_object_safely(trace_path)
    if isinstance(parsed, dict) and has_complete_quality_trace(parsed):
        return

    raise ValueError(
        f"{metadata_path}: replay metadata references {trace_path}, but the quality trace is missing "
        "or incomplete. Required replay evidence: Stage 2 event progression/evaluation plus Stage 5/8 "
        "patch or gate evidence."
    )


def require_candidate_generation_artifacts(metadata: dict[str, Any], metadata_path: Path) -> None:
    require_successful_generation_result(metadata, metadata_path)
    require_complete_quality_trace(metadata, metadata_path)


def compact(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def tokenize(text: str) -> list[str]:
    return WORD_PATTERN.findall(text)


def sentence_count(text: str) -> int:
    sentences = [part.strip() for part in SENTENCE_SPLIT_PATTERN.split(text) if part.strip()]
    return max(1, len(sentences))


def count(pattern: re.Pattern[str], text: str) -> int:
    return len(pattern.findall(text))


def metadata_content_points(metadata: dict[str, Any]) -> list[str]:
    points: list[str] = []
    for event in metadata.get("events", []):
        if isinstance(event, dict):
            for value in event.get("contentPoints", []):
                if isinstance(value, str) and value.strip():
                    points.append(value.strip())
    for value in metadata.get("contentPoints", []):
        if isinstance(value, str) and value.strip():
            points.append(value.strip())
    return unique_strings(points)


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = compact(value)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def fuzzy_contains(text: str, needle: str) -> bool:
    normalized_text = compact(text)
    normalized_needle = compact(needle)
    if not normalized_needle:
        return False
    if normalized_needle in normalized_text:
        return True
    tokens = re.findall(r"[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_]{3,}", needle.lower())
    return any(token[: min(5, len(token))] in normalized_text for token in tokens)


def coverage_score(text: str, metadata: dict[str, Any]) -> float:
    points = metadata_content_points(metadata)
    if not points:
        return 0.62
    covered = sum(1 for point in points if fuzzy_contains(text, point))
    return covered / len(points)


def balance_score(words: int, sentences: int) -> float:
    average = words / max(1, sentences)
    if 7 <= average <= 28:
        return 1.0
    distance = min(abs(average - 7), abs(average - 28))
    return max(0.0, 1.0 - distance / 28)


def gated_progression_component(score: float, anchor: bool, span: bool) -> float:
    if not anchor or not span:
        return 0.0
    return score


def progression_score(
    text: str,
    evidence_delta: float | None = None,
    choice_delta: float | None = None,
    risk_delta: float | None = None,
    hook_movement: float | None = None,
) -> float:
    evidence_delta = evidence_delta_score(text) if evidence_delta is None else evidence_delta
    choice_delta = choice_delta_score(text) if choice_delta is None else choice_delta
    risk_delta = risk_delta_score(text) if risk_delta is None else risk_delta
    hook_movement = hook_movement_score(text) if hook_movement is None else hook_movement
    evidence_anchor = bool(PROGRESSION_EVIDENCE_ANCHOR_PATTERN.search(text))
    choice_anchor = bool(PROGRESSION_CHOICE_ANCHOR_PATTERN.search(text))
    risk_anchor = bool(PROGRESSION_RISK_ANCHOR_PATTERN.search(text))
    hook_anchor = bool(PROGRESSION_HOOK_ANCHOR_PATTERN.search(text))
    evidence_span = bool(PROGRESSION_EVIDENCE_SPAN_PATTERN.search(text))
    choice_span = bool(PROGRESSION_CHOICE_CONSEQUENCE_SPAN_PATTERN.search(text))
    risk_span = bool(PROGRESSION_RISK_MOVEMENT_SPAN_PATTERN.search(text))
    hook_span = bool(PROGRESSION_HOOK_LINK_SPAN_PATTERN.search(text))
    anchored_evidence = gated_progression_component(evidence_delta, evidence_anchor, evidence_span)
    anchored_choice = gated_progression_component(choice_delta, choice_anchor, choice_span)
    anchored_risk = gated_progression_component(risk_delta, risk_anchor, risk_span)
    anchored_hook = gated_progression_component(hook_movement, hook_anchor, hook_span)
    weighted = (
        anchored_evidence * 0.32
        + anchored_choice * 0.22
        + anchored_risk * 0.22
        + anchored_hook * 0.24
    )
    active_components = sum(
        1 for score in [anchored_evidence, anchored_choice, anchored_risk, anchored_hook] if score >= 0.2
    )
    active_anchors = sum(1 for anchored in [evidence_anchor, choice_anchor, risk_anchor, hook_anchor] if anchored)
    active_spans = sum(1 for span in [evidence_span, choice_span, risk_span, hook_span] if span)
    if active_anchors < 2:
        weighted = min(weighted, 0.34)
    if active_components < 2:
        weighted = min(weighted, 0.34)
    if active_spans < 2:
        weighted = min(weighted, 0.34)
    if not anchored_evidence and not anchored_hook:
        weighted = min(weighted, 0.25)
    return round(min(1.0, weighted), 4)


def evidence_delta_score(text: str) -> float:
    return min(1.0, count(EVIDENCE_DELTA_PATTERN, text) / 4)


def choice_delta_score(text: str) -> float:
    return min(1.0, count(CHOICE_DELTA_PATTERN, text) / 3)


def risk_delta_score(text: str) -> float:
    return min(1.0, count(RISK_DELTA_PATTERN, text) / 4)


def hook_movement_score(text: str) -> float:
    tail = text[int(len(text) * 0.65):] if text else ""
    if not tail.strip():
        tail = text
    return min(1.0, count(HOOK_MOVEMENT_PATTERN, tail) / 3)


def reader_need_to_continue_score(
    text: str,
    evidence_delta: float,
    choice_delta: float,
    risk_delta: float,
    hook_movement: float,
) -> float:
    reader_signal = min(1.0, count(READER_NEED_PATTERN, text) / 6)
    combined = (
        evidence_delta * 0.22
        + choice_delta * 0.18
        + risk_delta * 0.22
        + hook_movement * 0.28
        + reader_signal * 0.10
    )
    return round(min(1.0, combined), 4)


def measure_text(text: str, metadata: dict[str, Any]) -> TextMetrics:
    words = tokenize(text)
    word_count = max(1, len(words))
    sentences = sentence_count(text)
    evidence_delta = evidence_delta_score(text)
    choice_delta = choice_delta_score(text)
    risk_delta = risk_delta_score(text)
    hook_movement = hook_movement_score(text)
    return TextMetrics(
        word_count=word_count,
        sentence_count=sentences,
        coverage=coverage_score(text, metadata),
        concrete_density=min(1.0, count(SENSORY_PATTERN, text) / max(10, sentences * 4)),
        action_density=min(1.0, count(ACTION_PATTERN, text) / max(6, sentences * 2)),
        conflict_density=min(1.0, count(CONFLICT_PATTERN, text) / max(8, sentences * 3)),
        dialogue_density=min(1.0, count(DIALOGUE_PATTERN, text) / max(4, sentences * 2)),
        ai_filler_density=min(1.0, count(AI_FILLER_PATTERN, text) / max(2, sentences)),
        sentence_balance=balance_score(word_count, sentences),
        progression=progression_score(text, evidence_delta, choice_delta, risk_delta, hook_movement),
        evidenceDelta=evidence_delta,
        choiceDelta=choice_delta,
        riskDelta=risk_delta,
        hookMovement=hook_movement,
        readerNeedToContinue=reader_need_to_continue_score(
            text,
            evidence_delta,
            choice_delta,
            risk_delta,
            hook_movement,
        ),
    )


def score_metrics(metrics: TextMetrics) -> float:
    positive = (
        metrics.coverage * 16
        + metrics.concrete_density * 10
        + metrics.action_density * 8
        + metrics.conflict_density * 8
        + metrics.dialogue_density * 6
        + metrics.sentence_balance * 5
        + metrics.progression * 12
        + metrics.evidenceDelta * 10
        + metrics.choiceDelta * 8
        + metrics.riskDelta * 9
        + metrics.hookMovement * 8
        + metrics.readerNeedToContinue * 10
    )
    penalty = metrics.ai_filler_density * 20
    return round(max(0.0, min(100.0, positive - penalty)), 4)


def extract_candidate_rules(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    direct_rules = metadata.get("candidateRules", [])
    rules: list[dict[str, Any]] = [rule for rule in direct_rules if isinstance(rule, dict)]

    for event in metadata.get("events", []):
        if not isinstance(event, dict):
            continue
        event_rules = event.get("candidateRules", [])
        for rule in event_rules:
            if isinstance(rule, dict):
                merged = dict(rule)
                merged.setdefault("sceneType", event.get("sceneType"))
                rules.append(merged)

    return dedupe_rules(rules)


def dedupe_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for index, rule in enumerate(rules):
        rule_id = str(rule.get("id") or f"candidate-rule-{index + 1}")
        if rule_id in seen:
            continue
        seen.add(rule_id)
        normalized = dict(rule)
        normalized["id"] = rule_id
        result.append(normalized)
    return result


def make_benchmark_id(candidate_path: Path, metadata: dict[str, Any]) -> str:
    chapter_id = str(metadata.get("chapterId") or metadata.get("chapter") or candidate_path.stem)
    stable = re.sub(r"[^A-Za-z0-9_.-]+", "-", chapter_id).strip("-") or candidate_path.stem
    return stable


def run_benchmark(reference_path: Path, candidate_path: Path, metadata_path: Path, min_delta: float) -> ReplayBenchmarkResult:
    metadata = read_json(metadata_path)
    require_orchestrator_proof(metadata, metadata_path)
    require_candidate_generation_artifacts(metadata, metadata_path)
    reference_text = read_text(reference_path)
    candidate_text = read_text(candidate_path)
    reference_metrics = measure_text(reference_text, metadata)
    candidate_metrics = measure_text(candidate_text, metadata)
    reference_score = score_metrics(reference_metrics)
    candidate_score = score_metrics(candidate_metrics)
    delta = round(candidate_score - reference_score, 4)

    return ReplayBenchmarkResult(
        schemaVersion=1,
        benchmarkId=make_benchmark_id(candidate_path, metadata),
        createdAt=datetime.now(timezone.utc).isoformat(),
        candidateWins=delta >= min_delta and not math.isclose(delta, min_delta - 1e-9),
        minDelta=min_delta,
        scores=ReplayScores(reference=reference_score, candidate=candidate_score, delta=delta),
        referenceMetrics=reference_metrics,
        candidateMetrics=candidate_metrics,
        metadata=metadata,
        candidateRules=extract_candidate_rules(metadata),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an offline replay benchmark comparison.")
    parser.add_argument("--reference", required=True, help="Reference chapter or segment text path.")
    parser.add_argument("--candidate", required=True, help="Candidate generated chapter or segment text path.")
    parser.add_argument("--metadata", required=True, help="Benchmark metadata JSON path.")
    parser.add_argument("--output", required=True, help="Output benchmark JSON path.")
    parser.add_argument("--min-delta", type=float, default=0.0, help="Minimum score delta required for a candidate win.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        result = run_benchmark(
            reference_path=Path(args.reference),
            candidate_path=Path(args.candidate),
            metadata_path=Path(args.metadata),
            min_delta=args.min_delta,
        )
        write_json(Path(args.output), asdict(result))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
