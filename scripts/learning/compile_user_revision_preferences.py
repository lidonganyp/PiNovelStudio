"""
PiNovelStudio — Compile user revision preferences into runtime rules.

将 workspaces/{workspaceId}/USER-REVISION-LEARNINGS.md 编译为
workspaces/{workspaceId}/runtime/user-preference-rules.json，供
craft/user-preference-rules.ts 在 Stage 2/5/8 自动消费。

支持两种输入格式：
  1. 结构化块（长期推荐）：
       ## Preference Rule: <名称>
       sceneType: emotional
       appliesWhen: 父子情绪段, 章末余韵
       craftMove: 用物理道具和动作承载情绪
       mustDo:
         - 让道具跨段回扣
         - 用动作/停顿外化情绪
       avoid:
         - 直接命名情绪
       microExample: 旧手表的滴答声再次出现。

  2. 旧版叙事条目（兼容现有资产）：
       ### 修正 N·标题
       或
       ### 微调 N·标题
     采用保守抽取：标题作 craftMove，正则从正文抽 mustDo/avoid。

输出 schema 见 craft/user-preference-rules.ts 的 UserPreferenceRule 接口。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
SOURCE_MARKER = "USER-REVISION-LEARNINGS.md"

# 结构化规则置信度（半结构化、字段完整）
STRUCTURED_CONFIDENCE = 0.85
# 旧版规则置信度区间
LEGACY_CONFIDENCE_RICH = 0.6  # 成功抽到 mustDo/avoid
LEGACY_CONFIDENCE_TITLE_ONLY = 0.4  # 仅标题

# 旧版条目 mustDo 句式
MUSTDO_PATTERNS = [
    re.compile(r"✅\s*(.+?)\s*(?:[|—\-]|$)"),
    re.compile(r"必须(.+?)(?:[。；;,\n]|$)"),
    re.compile(r"改用(.+?)(?:[。；;,\n]|$)"),
    re.compile(r"要用(.+?)(?:[。；;,\n]|$)"),
]
# 旧版条目 avoid 句式
AVOID_PATTERNS = [
    re.compile(r"❌\s*(.+?)\s*(?:[|—\-]|$)"),
    re.compile(r"不要(.+?)(?:[。；;,\n]|$)"),
    re.compile(r"避免(.+?)(?:[。；;,\n]|$)"),
    re.compile(r"禁止(.+?)(?:[。；;,\n]|$)"),
    re.compile(r"不能(.+?)(?:[。；;,\n]|$)"),
]

# 旧版条目标题正则：### 修正 14·标题 / ### 微调 3·标题
LEGACY_HEADING_RE = re.compile(r"^###\s+(修正|微调)\s+(\d+)\s*[·•・]\s*(.+?)\s*$")

# 结构化块标题正则：## Preference Rule: 名称
STRUCTURED_HEADING_RE = re.compile(r"^##\s+Preference Rule:\s*(.+?)\s*$")

# 结构化字段行
STRUCTURED_FIELD_RE = re.compile(r"^([a-zA-Z]+)\s*:\s*(.*?)\s*$")


@dataclass
class CompiledRule:
    id: str
    sceneType: str
    appliesWhen: list[str] = field(default_factory=list)
    craftMove: str = ""
    mustDo: list[str] = field(default_factory=list)
    avoid: list[str] = field(default_factory=list)
    microExample: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "sceneType": self.sceneType,
            "appliesWhen": self.appliesWhen,
            "craftMove": self.craftMove,
            "mustDo": self.mustDo,
            "avoid": self.avoid,
            "microExample": self.microExample,
            "evidence": self.evidence,
        }


def parse_structured_blocks(md: str) -> list[CompiledRule]:
    """解析 ## Preference Rule: <名称> 半结构化块。"""
    rules: list[CompiledRule] = []
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        match = STRUCTURED_HEADING_RE.match(line)
        if not match:
            i += 1
            continue

        name = match.group(1).strip()
        block_lines: list[str] = []
        i += 1
        # 块持续到下一个 ## 标题或 EOF
        while i < len(lines) and not lines[i].startswith("## "):
            block_lines.append(lines[i])
            i += 1

        rule = _build_structured_rule(name, block_lines, len(rules) + 1)
        if rule is not None:
            rules.append(rule)
    return rules


def _build_structured_rule(name: str, block_lines: list[str], seq: int) -> CompiledRule | None:
    # fields 统一用 lowercase key，避免 camelCase/lowercase 混用导致 KeyError
    fields: dict[str, Any] = {
        "scenetype": "general",
        "applieswhen": [],
        "craftmove": "",
        "mustdo": [],
        "avoid": [],
        "microexample": None,
    }
    current_list: str | None = None

    for raw in block_lines:
        line = raw.rstrip()
        if not line.strip():
            current_list = None
            continue

        # 列表项：  - xxx （允许前导缩进）
        bullet_match = re.match(r"^\s*[-*]\s+(.+?)\s*$", line)
        if bullet_match and current_list is not None:
            fields[current_list].append(bullet_match.group(1).strip())
            continue

        field_match = STRUCTURED_FIELD_RE.match(line)
        if field_match:
            key = field_match.group(1).lower()
            value = field_match.group(2).strip()
            if key in ("mustdo", "avoid"):
                if value:
                    fields[key] = [v.strip() for v in re.split(r"[、,;；]", value) if v.strip()]
                current_list = key
            elif key in fields:
                if key in ("applieswhen",):
                    fields[key] = [v.strip() for v in re.split(r"[、,;；]", value) if v.strip()]
                elif key in ("scenetype", "craftmove", "microexample"):
                    fields[key] = value or fields[key]
                current_list = None
            else:
                current_list = None

    craft_move = (fields.get("craftmove") or "").strip() or name
    return CompiledRule(
        id=f"user-pref-{seq:03d}",
        sceneType=fields.get("scenetype") or "general",
        appliesWhen=fields.get("applieswhen", []),
        craftMove=craft_move,
        mustDo=fields.get("mustdo", []),
        avoid=fields.get("avoid", []),
        microExample=fields.get("microexample"),
        evidence={
            "source": "user_revision_learning",
            "format": "structured",
            "confidence": STRUCTURED_CONFIDENCE,
        },
    )


def parse_legacy_revisions(md: str) -> list[CompiledRule]:
    """解析 ### 修正 N·标题 / ### 微调 N·标题 旧版叙事条目。"""
    rules: list[CompiledRule] = []
    seen_ids: set[str] = set()
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        match = LEGACY_HEADING_RE.match(line)
        if not match:
            i += 1
            continue

        kind = match.group(1)  # 修正 | 微调
        number = match.group(2)
        title = match.group(3).strip()

        prefix = "r" if kind == "修正" else "t"
        rule_id = f"user-pref-{prefix}-{number}"
        if rule_id in seen_ids:
            # 跳过重复编号（保留首次出现）
            i += 1
            continue
        seen_ids.add(rule_id)

        body_lines: list[str] = []
        i += 1
        while i < len(lines) and not lines[i].startswith("### ") and not lines[i].startswith("## "):
            body_lines.append(lines[i])
            i += 1

        rule = _build_legacy_rule(rule_id, kind, number, title, body_lines)
        rules.append(rule)
    return rules


def _build_legacy_rule(
    rule_id: str, kind: str, number: str, title: str, body_lines: list[str]
) -> CompiledRule:
    body_text = "\n".join(body_lines)
    must_do = _extract_patterns(body_text, MUSTDO_PATTERNS)
    avoid = _extract_patterns(body_text, AVOID_PATTERNS)

    # craftMove：标题优先；若标题过短且正文首句更具体，则用正文首句
    craft_move = title.strip()
    if len(craft_move) < 6:
        first_sentence = _first_sentence(body_text)
        if first_sentence and len(first_sentence) > len(craft_move):
            craft_move = first_sentence

    # appliesWhen：从标题抽场景关键词
    applies_when = _extract_scene_keywords(title)

    rich = bool(must_do or avoid)
    confidence = LEGACY_CONFIDENCE_RICH if rich else LEGACY_CONFIDENCE_TITLE_ONLY

    return CompiledRule(
        id=rule_id,
        sceneType="general",
        appliesWhen=applies_when,
        craftMove=craft_move,
        mustDo=must_do,
        avoid=avoid,
        microExample=None,
        evidence={
            "source": "user_revision_learning",
            "format": "legacy_revision_r",
            "confidence": confidence,
            "sourceRef": f"{kind} {number}",
        },
    )


def _extract_patterns(text: str, patterns: list[re.Pattern[str]]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        for match in pattern.finditer(text):
            value = match.group(1).strip().rstrip("|").strip()
            if value and value not in seen and len(value) <= 80:
                seen.add(value)
                found.append(value)
    return found


def _first_sentence(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    # 取第一行非空
    for line in stripped.splitlines():
        line = line.strip().lstrip("*").strip()
        if line and not line.startswith("|") and not line.startswith("-"):
            return line[:80]
    return ""


_SCENE_KEYWORDS = [
    "对话", "章末", "钩子", "情绪", "揭示", "爽点", "身体反应", "内心独白",
    "感情线", "称谓", "数字", "空间", "哲理", "沉迷", "挫折", "安慰",
    "感知锚点", "压制", "留白", "过门",
]


def _extract_scene_keywords(title: str) -> list[str]:
    hits: list[str] = []
    for kw in _SCENE_KEYWORDS:
        if kw in title:
            hits.append(kw)
    return hits


def compile_markdown(md: str) -> list[CompiledRule]:
    """编译 markdown，先抽结构化块，再抽旧版条目；结构化优先。"""
    structured = parse_structured_blocks(md)
    legacy = parse_legacy_revisions(md)
    return structured + legacy


def resolve_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    if args.input and args.output:
        return Path(args.input), Path(args.output)

    repo_root = Path(__file__).resolve().parents[2]
    workspace_id = args.workspace
    workspace_dir = repo_root / "workspaces" / workspace_id

    md_path = Path(args.input) if args.input else workspace_dir / "USER-REVISION-LEARNINGS.md"
    out_path = Path(args.output) if args.output else workspace_dir / "runtime" / "user-preference-rules.json"
    return md_path, out_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile USER-REVISION-LEARNINGS.md into runtime user-preference-rules.json"
    )
    parser.add_argument("--workspace", help="workspace id (e.g. xinmo)")
    parser.add_argument("--input", help="path to source markdown (overrides workspace default)")
    parser.add_argument("--output", help="path to output json (overrides workspace default)")
    args = parser.parse_args(argv)

    if not args.workspace and not (args.input and args.output):
        parser.error("either --workspace or both --input and --output must be provided")

    md_path, out_path = resolve_paths(args)

    if not md_path.exists():
        print(f"[user-pref] 源 markdown 不存在: {md_path}", file=sys.stderr)
        return 1

    md_text = md_path.read_text(encoding="utf-8")
    rules = compile_markdown(md_text)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    document = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "source": SOURCE_MARKER,
        "entries": [rule.to_dict() for rule in rules],
    }
    out_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    structured_count = sum(1 for r in rules if r.evidence.get("format") == "structured")
    legacy_count = sum(1 for r in rules if r.evidence.get("format") == "legacy_revision_r")

    if not rules:
        print(
            f"[user-pref] 警告: {md_path} 未解析出任何偏好规则（无 ## Preference Rule: 块也无 ### 修正/微调 N·标题 条目），已写入空 entries 到 {out_path}",
            file=sys.stderr,
        )
    else:
        print(
            f"[user-pref] 编译完成: {len(rules)} 条规则 (structured={structured_count}, legacy={legacy_count}) → {out_path}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
