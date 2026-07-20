"""
PiNovelStudio — Layer 4: Few-Shot 黄金示例库构建脚本

为每个 {场景类型} × {风格} 组合构建精选的黄金段落库。
每个示例包含 200-500 字的精华片段，用于生成时的 Few-Shot 引导。

用法：
    python build-fewshots.py --scenes data/scenes/ --styles data/styles/ --output data/fewshots/
"""

import argparse
import json
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional
from collections import defaultdict


# ============================================================================
# 场景类型定义
# ============================================================================

SCENE_TYPES = [
    "breakthrough",      # 突破升级
    "face_slapping",    # 装逼打脸
    "combat",           # 战斗描写
    "romance",          # 感情升温
    "foreshadow_reveal", # 伏笔揭示
    "world_setting",    # 设定解说
    "daily_life",       # 日常过渡
    "faction_conflict",  # 势力交锋
    "sacrifice",         # 悲情牺牲
    "gamble",           # 豪赌博弈
    "team_gathering",    # 团队集结
    "cliffhanger",      # 章末悬念
]

SCENE_TYPE_NAMES = {
    "breakthrough": "突破升级",
    "face_slapping": "装逼打脸",
    "combat": "战斗描写",
    "romance": "感情升温",
    "foreshadow_reveal": "伏笔揭示",
    "world_setting": "设定解说",
    "daily_life": "日常过渡",
    "faction_conflict": "势力交锋",
    "sacrifice": "悲情牺牲",
    "gamble": "豪赌博弈",
    "team_gathering": "团队集结",
    "cliffhanger": "章末悬念",
}


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class FewshotExample:
    """黄金示例"""
    scene_type: str
    scene_name: str
    style_id: str
    style_name: str
    text: str
    word_count: int
    source_work: str
    source_author: str
    source_chapter: int = 0
    highlights: list = field(default_factory=list)  # 亮点标注
    technique_tags: list = field(default_factory=list)  # 使用技法
    quality_score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class FewshotSet:
    """Few-Shot 示例集"""
    scene_type: str
    scene_name: str
    style_id: str
    style_name: str
    examples: list = field(default_factory=list)
    total_words: int = 0
    avg_quality: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ============================================================================
# 示例选择引擎
# ============================================================================

class FewshotSelector:
    """Few-Shot 示例选择器"""

    def __init__(self, min_word_count: int = 200, max_word_count: int = 500) -> None:
        self.min_word_count = min_word_count
        self.max_word_count = max_word_count

    def select_from_scene_data(self, scene_data: dict, style_id: str, style_name: str) -> list[FewshotExample]:
        """从场景数据中选择最佳示例"""
        examples = []

        patterns = scene_data.get("patterns", [])
        for pattern in patterns:
            for excerpt in pattern.get("excerpts", []):
                text = excerpt.get("text", "")
                word_count = excerpt.get("word_count", 0)

                # 长度筛选
                if not (self.min_word_count <= word_count <= self.max_word_count * 2):
                    continue

                # 质量筛选
                quality_score = excerpt.get("quality_score", 0.5)
                if quality_score < 0.6:
                    continue

                # 提取亮点
                highlights = self._extract_highlights(text)

                # 检测技法标签
                technique_tags = self._detect_techniques(text)

                examples.append(FewshotExample(
                    scene_type=pattern.get("scene_type", ""),
                    scene_name=SCENE_TYPE_NAMES.get(pattern.get("scene_type", ""), ""),
                    style_id=style_id,
                    style_name=style_name,
                    text=text[:2500],  # 限制长度
                    word_count=word_count,
                    source_work=pattern.get("source_work", ""),
                    source_author=pattern.get("source_author", ""),
                    highlights=highlights,
                    technique_tags=technique_tags,
                    quality_score=quality_score
                ))

        return examples

    def _extract_highlights(self, text: str) -> list[str]:
        """提取文本亮点"""
        highlights = []

        # 检测各种亮点模式
        patterns = [
            (r'只见.*?。', "特写镜头"),
            (r'众人.*?。', "群体反应"),
            (r'突然.*?。', "突然转折"),
            (r'然而.*?。', "然而反转"),
            (r'.*?！', "感叹强化"),
            (r'就在这时.*?。', "关键时刻"),
            (r'他.*?道[：:].*?"', "对话推进"),
            (r'心中.*?。', "内心独白"),
        ]

        for pattern, label in patterns:
            matches = re.findall(pattern, text[:2000])  # 只检查前2000字
            if matches:
                highlights.append(f"{label}: {len(matches)}处")

        return highlights[:5]  # 最多5个亮点

    def _detect_techniques(self, text: str) -> list[str]:
        """检测使用的技法"""
        techniques = []

        technique_patterns = {
            "对比反衬": [r'相比', r'而.*?却', r'截然'],
            "旁观者反应": [r'众人', r'周围.*?都', r'看到.*?都'],
            "五感联动": [r'看到.*?听到.*?感到', r'视觉.*?听觉'],
            "悬念叠放": [r'就在.*?又', r'正当.*?突然'],
            "伏笔回收": [r'原来.*?正是', r'竟是', r'原来如此'],
            "细节特写": [r'只见', r'尤其是', r'特别是'],
            "情感外化": [r'不由得', r'忍不住', r'下意识'],
            "话不说满": [r'欲言又止', r'没有说'],
        }

        for technique, patterns in technique_patterns.items():
            if any(re.search(p, text) for p in patterns):
                techniques.append(technique)

        return techniques[:3]  # 最多3个技法标签


class FewshotLibraryBuilder:
    """Few-Shot 库构建器"""

    def __init__(self):
        self.selector = FewshotSelector()
        self.library = defaultdict(list)

    def add_from_scene_style(self, scene_data: dict, style_id: str, style_name: str):
        """从场景-风格组合添加示例"""
        examples = self.selector.select_from_scene_data(scene_data, style_id, style_name)

        if examples:
            # 按质量排序，取前5个
            examples.sort(key=lambda x: x.quality_score, reverse=True)
            self.library[(scene_data.get("scene_type", ""), style_id)] = examples[:5]

    def build_set(self, scene_type: str, style_id: str) -> Optional[FewshotSet]:
        """构建 Few-Shot 示例集"""
        key = (scene_type, style_id)
        examples = self.library.get(key, [])

        if not examples:
            return None

        total_words = sum(e.word_count for e in examples)
        avg_quality = sum(e.quality_score for e in examples) / len(examples)

        scene_name = SCENE_TYPE_NAMES.get(scene_type, scene_type)
        style_name = examples[0].style_name if examples else ""

        return FewshotSet(
            scene_type=scene_type,
            scene_name=scene_name,
            style_id=style_id,
            style_name=style_name,
            examples=[e.to_dict() for e in examples],
            total_words=total_words,
            avg_quality=avg_quality
        )

    def export(self) -> dict:
        """导出库数据"""
        result = {
            "export_date": "2026-05-27",
            "scene_types": SCENE_TYPE_NAMES,
            "sets": {}
        }

        for (scene_type, style_id), examples in self.library.items():
            fewset = self.build_set(scene_type, style_id)
            if fewset:
                key = f"{scene_type}_{style_id}"
                result["sets"][key] = fewset.to_dict()

        result["total_sets"] = len(result["sets"])
        result["total_examples"] = sum(
            len(s["examples"]) for s in result["sets"].values()
        )

        return result

    def export_flat(self) -> list:
        """导出为扁平列表"""
        result = []
        for examples in self.library.values():
            result.extend([e.to_dict() for e in examples])
        return result


# ============================================================================
# 主程序
# ============================================================================

def load_scene_data(scenes_dir: Path, scene_type: str) -> Optional[dict]:
    """加载场景数据"""
    scene_file = scenes_dir / f"{scene_type}.json"
    if not scene_file.exists():
        return None

    with open(scene_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_style_data(styles_dir: Path, style_id: str) -> Optional[dict]:
    """加载风格数据"""
    style_file = styles_dir / f"{style_id}.json"
    if not style_file.exists():
        return None

    with open(style_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_styles_index(styles_dir: Path) -> list:
    """加载风格索引"""
    index_file = styles_dir.parent / "styles" / "index.json"
    if index_file.exists():
        with open(index_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return [s["id"] for s in data.get("styles", [])]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio Few-Shot 黄金示例库构建")
    parser.add_argument("--scenes", "-s", required=True, help="场景数据目录")
    parser.add_argument("--styles", "-t", required=True, help="风格数据目录")
    parser.add_argument("--output", "-o", required=True, help="输出目录")
    parser.add_argument("--min-words", "-m", type=int, default=200, help="最小字数")
    parser.add_argument("--max-words", "-x", type=int, default=500, help="最大字数")
    args = parser.parse_args()

    scenes_dir = Path(args.scenes)
    styles_dir = Path(args.styles)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 加载风格索引
    style_ids = load_styles_index(styles_dir)
    if not style_ids:
        style_ids = ["custom"]

    print(f"加载 {len(style_ids)} 个风格")
    print(f"处理 {len(SCENE_TYPES)} 个场景类型")

    builder = FewshotLibraryBuilder()

    # 处理每个场景类型
    for scene_type in SCENE_TYPES:
        print(f"\n处理场景: {SCENE_TYPE_NAMES[scene_type]}")

        scene_data = load_scene_data(scenes_dir, scene_type)
        if not scene_data:
            print(f"  [跳过] 无场景数据")
            continue

        # 处理每个风格
        for style_id in style_ids:
            style_name = style_id
            style_data = load_style_data(styles_dir, style_id)
            if style_data:
                style_name = style_data.get("name", style_id)

            builder.add_from_scene_style(scene_data, style_id, style_name)

            # 统计该场景-风格的示例数
            key = (scene_type, style_id)
            count = len(builder.library.get(key, []))
            if count > 0:
                print(f"  {style_id}: {count} 个示例")

    # 导出结果
    print(f"\n导出 Few-Shot 库...")

    # 完整导出
    full_export = builder.export()
    output_file = output_dir / "fewshots_full.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(full_export, f, ensure_ascii=False, indent=2)
    print(f"保存到: {output_file}")

    # 扁平导出
    flat_export = builder.export_flat()
    flat_file = output_dir / "fewshots_flat.json"
    with open(flat_file, 'w', encoding='utf-8') as f:
        json.dump(flat_export, f, ensure_ascii=False, indent=2)
    print(f"保存到: {flat_file}")

    # 生成检索索引
    index = {
        "by_scene": defaultdict(list),
        "by_style": defaultdict(list),
        "by_technique": defaultdict(list),
    }

    for examples in builder.library.values():
        for example in examples:
            index["by_scene"][example.scene_type].append({
                "style_id": example.style_id,
                "quality": example.quality_score,
                "source": example.source_work
            })
            index["by_style"][example.style_id].append({
                "scene_type": example.scene_type,
                "quality": example.quality_score,
                "source": example.source_work
            })
            for tech in example.technique_tags:
                index["by_technique"][tech].append({
                    "scene_type": example.scene_type,
                    "style_id": example.style_id,
                    "quality": example.quality_score
                })

    index_file = output_dir / "fewshots_index.json"
    with open(index_file, 'w', encoding='utf-8') as f:
        json.dump(dict(index), f, ensure_ascii=False, indent=2)
    print(f"保存到: {index_file}")

    print(f"\n构建完成:")
    print(f"  - 场景×风格组合: {full_export['total_sets']}")
    print(f"  - 总示例数: {full_export['total_examples']}")


if __name__ == "__main__":
    main()
