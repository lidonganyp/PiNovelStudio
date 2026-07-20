"""
PiNovelStudio — Runtime Knowledge Index Builder

将五层数据壁垒转换为运行时可检索的轻量索引。

输入:
    - data/scenes/*.json        (场景模式库)
    - data/techniques/*.json    (技法原子库)
    - data/styles/*.json        (风格指纹库)
    - data/fewshots/*.json      (Few-Shot 黄金示例库)
    - data/contrastive/*.json   (对比蒸馏知识库)

输出:
    - data/runtime/scenes-index.json
    - data/runtime/techniques-index.json
    - data/runtime/style-lessons.json
    - data/runtime/fewshot-index.json
    - data/runtime/contrastive-rules-index.json

用法:
    python build-runtime-knowledge-index.py --input data/ --output data/runtime/
"""

import argparse
import json
import re
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from collections import defaultdict


# ============================================================================
# 索引项数据结构
# ============================================================================

@dataclass
class SceneIndexEntry:
    """场景索引项"""
    id: str
    scene_type: str
    chapter_phase: str  # opening, development, climax, resolution
    emotion_target: str  # 燃, 爽, 虐, 悬, 甜, 虐
    narrative_function: str  # 推进, 铺垫, 高潮, 收束
    style_tags: list
    rule: str  # 短规则/短摘要
    anti_pattern: str  # 反面模式
    applicable_when: str  # 适用条件
    avoid_when: str  # 避免条件
    source: str  # 来源文件
    confidence: float  # 置信度 0-1


@dataclass
class TechniqueIndexEntry:
    """技法索引项"""
    id: str
    name: str
    category: str  # emotion, structure, dialogue, info_release, character, setting
    scene_types: list  # 适用的场景类型
    emotion_target: str
    narrative_function: str
    style_tags: list
    rule: str  # 技法公式
    anti_pattern: str
    applicable_when: str
    avoid_when: str
    source: str
    confidence: float


@dataclass
class StyleLessonEntry:
    """风格教训项（不保存原文，仅规则）"""
    id: str
    style_id: str
    lesson_type: str  # sentence, lexicon, narrative, emotion, rhythm
    rule: str
    anti_pattern: str
    applicable_when: str
    avoid_when: str
    source: str
    confidence: float


@dataclass
class FewshotIndexEntry:
    """Few-Shot 索引项"""
    id: str
    scene_type: str
    chapter_phase: str
    emotion_target: str
    narrative_function: str
    style_tags: list
    technique_tags: list
    rule: str  # 摘要规则，非原文
    anti_pattern: str
    applicable_when: str
    avoid_when: str
    source_work: str
    quality_score: float
    confidence: float


@dataclass
class ContrastiveRuleEntry:
    """对比蒸馏规则索引项"""
    id: str
    scene_type: str
    dimension: str  # structure, language, rhythm, emotion
    chapter_phase: str
    emotion_target: str
    rule: str  # 正面规则
    anti_pattern: str  # 反面模式
    applicable_when: str
    avoid_when: str
    source: str
    confidence: float


# ============================================================================
# 场景类型定义
# ============================================================================

SCENE_TYPES = {
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

CHAPTER_PHASES = ["opening", "development", "climax", "resolution"]
EMOTION_TARGETS = ["燃", "爽", "虐", "悬", "甜", "虐", "燃虐", "爽甜", "悬燃"]
NARRATIVE_FUNCTIONS = ["推进", "铺垫", "高潮", "收束", "转折", "过渡"]
TECHNIQUE_CATEGORIES = ["emotion", "structure", "dialogue", "info_release", "character", "setting"]


# ============================================================================
# 核心索引构建器
# ============================================================================

class RuntimeIndexBuilder:
    """运行时索引构建器"""

    def __init__(self, data_root: Path, output_root: Path):
        self.data_root = data_root
        self.output_root = output_root
        self.counter = 0

    def next_id(self, prefix: str) -> str:
        """生成唯一ID"""
        self.counter += 1
        return f"{prefix}_{self.counter:04d}"

    # -------------------------------------------------------------------------
    # 场景索引构建
    # -------------------------------------------------------------------------

    def build_scenes_index(self) -> list[dict]:
        """从 data/scenes/*.json 构建场景索引"""
        scenes_dir = self.data_root / "scenes"
        if not scenes_dir.exists():
            print(f"  [跳过] 场景目录不存在: {scenes_dir}")
            return []

        index_entries = []

        for scene_file in scenes_dir.glob("*.json"):
            if scene_file.name == "index.json":
                continue

            try:
                with open(scene_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                scene_type = scene_file.stem
                scene_name = data.get("scene_name", SCENE_TYPES.get(scene_type, scene_type))

                # 从 patterns 中提取规则
                patterns = data.get("patterns", [])
                for pattern in patterns[:5]:  # 最多5个pattern
                    excerpts = pattern.get("excerpts", [])
                    for excerpt in excerpts[:3]:  # 每个pattern最多3个excerpt
                        entry = self._extract_scene_entry(
                            scene_type=scene_type,
                            scene_name=scene_name,
                            excerpt=excerpt,
                            source=str(scene_file.name)
                        )
                        if entry:
                            index_entries.append(entry)

                # 如果没有从文件中提取到，生成默认规则
                if not index_entries and scene_type in SCENE_TYPES:
                    entry = self._generate_default_scene_entry(scene_type, scene_name, str(scene_file.name))
                    index_entries.append(entry)

            except Exception as e:
                print(f"  [警告] 处理场景文件失败: {scene_file.name} - {e}")

        # 去重
        seen_rules = set()
        unique_entries = []
        for entry in index_entries:
            if entry["rule"] not in seen_rules:
                seen_rules.add(entry["rule"])
                unique_entries.append(entry)

        return unique_entries

    def _extract_scene_entry(self, scene_type: str, scene_name: str, excerpt: dict, source: str) -> Optional[dict]:
        """从 excerpt 提取索引项"""
        text = excerpt.get("text", "")
        if len(text) < 50:
            return None

        # 检测章节阶段
        chapter_phase = self._detect_chapter_phase(text)

        # 检测情绪目标
        emotion_target = self._detect_emotion_target(text)

        # 检测叙事功能
        narrative_function = self._detect_narrative_function(text)

        # 提取规则（从文本中抽取核心要点）
        rule = self._extract_rule_from_text(text, scene_type)
        anti_pattern = self._extract_anti_pattern(text, scene_type)

        return {
            "id": self.next_id("scene"),
            "scene_type": scene_type,
            "chapter_phase": chapter_phase,
            "emotion_target": emotion_target,
            "narrative_function": narrative_function,
            "style_tags": excerpt.get("tags", [])[:3],
            "rule": rule,
            "anti_pattern": anti_pattern,
            "applicable_when": self._get_applicable_when(scene_type, chapter_phase),
            "avoid_when": self._get_avoid_when(scene_type),
            "source": source,
            "confidence": min(excerpt.get("quality_score", 0.7) + 0.1, 1.0)
        }

    def _generate_default_scene_entry(self, scene_type: str, scene_name: str, source: str) -> dict:
        """生成默认场景规则"""
        rules = {
            "combat": ("战斗推进必须由动作和代价驱动，避免冗长的内心独白", "战斗结果直接宣布，缺乏铺垫"),
            "breakthrough": ("突破需要层层递进的阻力，最终由主角抉择完成升华", "突破过于顺利，缺乏挫折"),
            "daily_life": ("日常场景用关系微变承载信息，避免流水账", "日常场景堆砌，无信息量"),
            "face_slapping": ("打脸需要先充分铺垫轻视，再展示实力碾压", "打脸缺乏铺垫，力度不足"),
            "cliffhanger": ("悬念需要在关键时刻截断，留下核心疑问", "悬念过于平淡，缺乏钩子"),
            "romance": ("感情推进依赖小动作和微表情，而非直接表白", "感情进展过于直白，缺少暧昧"),
            "sacrifice": ("牺牲需要有足够的羁绊铺垫，才能引发读者共鸣", "牺牲过于突兀，缺乏情感基础"),
            "faction_conflict": ("势力交锋需要明确的利益冲突和立场对立", "势力态度模糊，缺乏张力"),
            "gamble": ("博弈需要信息不对称，让读者既紧张又有所期待", "博弈结果过于可预测"),
            "sacrifice": ("悲情场景需要用细节替代直白描写", "悲情过于煽情，缺乏克制"),
        }

        rule, anti = rules.get(scene_type, (f"{scene_name}场景核心规则", "避免常见错误"))

        return {
            "id": self.next_id("scene"),
            "scene_type": scene_type,
            "chapter_phase": "development",
            "emotion_target": "燃",
            "narrative_function": "推进",
            "style_tags": [],
            "rule": rule,
            "anti_pattern": anti,
            "applicable_when": f"{scene_name}场景中",
            "avoid_when": f"{scene_name}场景不应",
            "source": source,
            "confidence": 0.6
        }

    def _detect_chapter_phase(self, text: str) -> str:
        """检测章节阶段"""
        if any(kw in text for kw in ["开头", "首先", "初始"]):
            return "opening"
        elif any(kw in text for kw in ["高潮", "关键时刻", "就在", "突然"]):
            return "climax"
        elif any(kw in text for kw in ["尾声", "最终", "结束", "收尾"]):
            return "resolution"
        return "development"

    def _detect_emotion_target(self, text: str) -> str:
        """检测情绪目标"""
        if any(w in text for w in ["热血", "燃", "激情", "斗志"]):
            return "燃"
        elif any(w in text for w in ["痛快", "爽", "过瘾"]):
            return "爽"
        elif any(w in text for w in ["悲伤", "虐", "心酸"]):
            return "虐"
        elif any(w in text for w in ["悬念", "紧张", "危机"]):
            return "悬"
        elif any(w in text for w in ["甜蜜", "心动", "脸红"]):
            return "甜"
        return "燃"  # 默认

    def _detect_narrative_function(self, text: str) -> str:
        """检测叙事功能"""
        if any(w in text for w in ["推动", "发展", "进行"]):
            return "推进"
        elif any(w in text for w in ["铺垫", "为了", "因此"]):
            return "铺垫"
        elif any(w in text for w in ["高潮", "终于", "决定"]):
            return "高潮"
        elif any(w in text for w in ["结束", "于是", "最终"]):
            return "收束"
        elif any(w in text for w in ["然而", "但是", "转折"]):
            return "转折"
        return "推进"

    def _extract_rule_from_text(self, text: str, scene_type: str) -> str:
        """从文本中提取核心规则"""
        # 取第一段作为规则摘要
        lines = text.split('\n')
        first_para = lines[0] if lines else text[:200]

        # 清理并截断
        rule = first_para.strip()[:150]
        if len(first_para) > 150:
            rule = rule.rstrip('，,。') + '...'

        return rule or f"{SCENE_TYPES.get(scene_type, scene_type)}场景描写"

    def _extract_anti_pattern(self, text: str, scene_type: str) -> str:
        """提取反面模式"""
        anti_patterns = {
            "combat": "战斗描写冗长解释招式原理，而非用动作展现",
            "breakthrough": "突破过程平铺直叙，缺乏层层阻力",
            "daily_life": "日常场景堆砌琐事，没有信息推进",
            "face_slapping": "打脸缺乏铺垫，力度不足",
            "cliffhanger": "悬念设置过于平淡，没有核心钩子",
            "romance": "感情进展过于直白，缺少暧昧和留白",
        }
        return anti_patterns.get(scene_type, "避免模板化、套路化的描写")

    def _get_applicable_when(self, scene_type: str, phase: str) -> str:
        """获取适用条件"""
        conditions = {
            "combat": "需要展现战斗激烈程度时",
            "breakthrough": "主角需要获得成长或实力提升时",
            "daily_life": "需要过渡剧情或展现角色关系时",
            "cliffhanger": "章节结尾需要留下悬念时",
        }
        return conditions.get(scene_type, f"{SCENE_TYPES.get(scene_type, scene_type)}场景适用")

    def _get_avoid_when(self, scene_type: str) -> str:
        """获取避免条件"""
        conditions = {
            "combat": "不应在战斗中进行大段原理说明",
            "breakthrough": "不应让突破过于轻松，缺乏挑战",
            "cliffhanger": "不应设置读者不关心的悬念",
        }
        return conditions.get(scene_type, "避免在该场景类型中滥用")

    # -------------------------------------------------------------------------
    # 技法索引构建
    # -------------------------------------------------------------------------

    def build_techniques_index(self) -> list[dict]:
        """构建技法索引"""
        # 内置核心技法定义（与 scene-technique-meta.ts 保持一致）
        # P33 中文化改造：T004 场景蒙太奇→横云断峰、T006 角色弧光展示→背面傅粉
        # 避免西方创意写作术语激活英文写作范式
        CORE_TECHNIQUES = [
            {"id": "T001", "name": "延迟满足", "category": "emotion", "formula": "先给予小奖励建立期待，再在关键时刻给出大奖励"},
            {"id": "T002", "name": "信息梯度释放", "category": "info_release", "formula": "分层次释放信息，保持读者好奇心"},
            {"id": "T003", "name": "情绪反转", "category": "emotion", "formula": "在高潮点突然反转情绪走向"},
            {"id": "T004", "name": "横云断峰", "category": "structure", "formula": "事写到要紧处突然切线，张力翻倍"},
            {"id": "T005", "name": "伏笔埋设", "category": "structure", "formula": "早期埋设线索，后期回收"},
            {"id": "T006", "name": "背面傅粉", "category": "character", "formula": "写表面动作，衬出人物底细，不点破"},
            {"id": "T007", "name": "感官细节叠加", "category": "setting", "formula": "多感官描写增强沉浸感"},
            {"id": "T008", "name": "对话潜文本", "category": "dialogue", "formula": "表面对话传递深层含义"},
        ]

        SCENE_TYPE_MAPPING = {
            "combat": ["T001", "T003", "T007"],
            "breakthrough": ["T006", "T002", "T005"],
            "daily_life": ["T008", "T007", "T002"],
            "cliffhanger": ["T005", "T003", "T002"],
            "face_slapping": ["T003", "T006", "T004"],
            "confrontation": ["T008", "T003", "T007"],
            "faction_conflict": ["T008", "T003", "T002"],
            "foreshadow_reveal": ["T005", "T002", "T003"],
            "gamble": ["T008", "T005", "T002"],
            "romance": ["T008", "T007", "T006"],
            "sacrifice": ["T003", "T006", "T001"],
            "team_gathering": ["T008", "T004", "T007"],
            "world_setting": ["T002", "T007", "T005"],
            "general": ["T002", "T007", "T005"],
        }

        index_entries = []
        for tech in CORE_TECHNIQUES:
            # 确定适用的场景类型
            applicable_scenes = []
            for scene_type, tech_ids in SCENE_TYPE_MAPPING.items():
                if tech["id"] in tech_ids:
                    applicable_scenes.append(scene_type)

            entry = {
                "id": tech["id"],
                "name": tech["name"],
                "category": tech["category"],
                "scene_types": applicable_scenes,
                "emotion_target": self._tech_to_emotion(tech["category"]),
                "narrative_function": self._tech_to_function(tech["category"]),
                "style_tags": [],
                "rule": tech["formula"],
                "anti_pattern": self._tech_anti_pattern(tech["name"]),
                "applicable_when": f"{tech['name']}技法适用于{applicable_scenes[0] if applicable_scenes else '各'}场景" if applicable_scenes else "",
                "avoid_when": "避免机械化套用，需根据具体情境灵活运用",
                "source": "scene-technique-meta",
                "confidence": 0.8
            }
            index_entries.append(entry)

        return index_entries

    def _tech_to_emotion(self, category: str) -> str:
        """技法类别到情绪目标的映射"""
        mapping = {
            "emotion": "燃",
            "structure": "悬",
            "dialogue": "甜",
            "info_release": "悬",
            "character": "虐",
            "setting": "燃",
        }
        return mapping.get(category, "燃")

    def _tech_to_function(self, category: str) -> str:
        """技法类别到叙事功能的映射"""
        mapping = {
            "emotion": "高潮",
            "structure": "推进",
            "dialogue": "推进",
            "info_release": "铺垫",
            "character": "高潮",
            "setting": "铺垫",
        }
        return mapping.get(category, "推进")

    def _tech_anti_pattern(self, tech_name: str) -> str:
        """技法反面模式"""
        anti_patterns = {
            "延迟满足": "过早给出全部奖励，丧失期待感",
            "信息梯度释放": "一次性倾倒所有信息",
            "情绪反转": "反转过于突兀，缺乏铺垫",
            "横云断峰": "切线过早或过频，叙事断裂",
            "伏笔埋设": "伏笔过于明显，缺乏隐藏",
            "背面傅粉": "衬笔喧宾夺主，底细点破",
            "感官细节叠加": "感官描写堆砌，影响节奏",
            "对话潜文本": "潜文本过于直白，失去意味",
        }
        return anti_patterns.get(tech_name, "避免机械套用技法")

    # -------------------------------------------------------------------------
    # 风格教训索引构建
    # -------------------------------------------------------------------------

    def build_style_lessons(self) -> list[dict]:
        """从 data/styles/*.json 构建风格教训索引"""
        styles_dir = self.data_root / "styles"
        if not styles_dir.exists():
            print(f"  [跳过] 风格目录不存在: {styles_dir}")
            return []

        index_entries = []

        for style_file in styles_dir.glob("*.json"):
            if style_file.name in ["index.json", "default.json"]:
                continue

            try:
                with open(style_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                style_id = style_file.stem

                # 从风格指纹中提取教训
                entry = self._extract_style_lesson(style_id, data, str(style_file.name))
                if entry:
                    index_entries.append(entry)

            except Exception as e:
                print(f"  [警告] 处理风格文件失败: {style_file.name} - {e}")

        return index_entries

    def _extract_style_lesson(self, style_id: str, data: dict, source: str) -> Optional[dict]:
        """从风格数据提取教训"""
        narrative = data.get("narrative", {})
        sentence = data.get("sentence", {})
        emotion = data.get("emotion", {})

        # P33 中文化：POV→视角、Show/Tell→展示叙述比，避免英文术语污染 Narrator 提示词
        rule = f"句长{sentence.get('avgLength', 25)}±{sentence.get('lengthVariance', 15)}字，视角{narrative.get('povStyle', '第三人称')}，展示叙述比={narrative.get('showTellRatio', 0.7)}"
        anti_pattern = "避免风格与该指纹偏差过大，保持句子长度和视角一致性"

        return {
            "id": f"style_{style_id}",
            "style_id": style_id,
            "lesson_type": "narrative",
            "rule": rule,
            "anti_pattern": anti_pattern,
            "applicable_when": f"风格ID={style_id}的章节",
            "avoid_when": "避免在该风格章节中使用其他风格的标志性句式",
            "source": source,
            "confidence": 0.7
        }

    # -------------------------------------------------------------------------
    # Few-Shot 索引构建
    # -------------------------------------------------------------------------

    def build_fewshot_index(self) -> list[dict]:
        """从 data/fewshots/*.json 构建 Few-Shot 索引"""
        fewshots_dir = self.data_root / "fewshots"
        if not fewshots_dir.exists():
            print(f"  [跳过] Few-Shot 目录不存在: {fewshots_dir}")
            return []

        flat_file = fewshots_dir / "fewshots_flat.json"
        if not flat_file.exists():
            print(f"  [跳过] Few-Shot 扁平文件不存在: {flat_file}")
            return []

        try:
            with open(flat_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            index_entries = []
            for item in data[:500]:  # 最多500条
                entry = self._extract_fewshot_entry(item)
                if entry:
                    index_entries.append(entry)

            return index_entries

        except Exception as e:
            print(f"  [警告] 处理 Few-Shot 文件失败: {e}")
            return []

    def _extract_fewshot_entry(self, item: dict) -> Optional[dict]:
        """从 Few-Shot 项提取索引"""
        text = item.get("text") or item.get("excerpt", "")
        if len(text) < 50:
            return None

        scene_type = item.get("scene_type", "general")

        # 检测章节阶段
        chapter_phase = self._detect_chapter_phase(text)

        # 检测情绪目标
        emotion_target = self._detect_emotion_target(text)

        # 检测叙事功能
        narrative_function = self._detect_narrative_function(text)

        # 提取摘要规则
        rule = self._extract_rule_from_text(text, scene_type)
        technique_tags = item.get("technique_tags", [])[:3]
        style_tags = item.get("highlights", [])[:3]

        return {
            "id": self.next_id("fewshot"),
            "scene_type": scene_type,
            "chapter_phase": chapter_phase,
            "emotion_target": emotion_target,
            "narrative_function": narrative_function,
            "style_tags": style_tags,
            "technique_tags": technique_tags,
            "rule": rule,
            "anti_pattern": self._extract_anti_pattern(text, scene_type),
            "applicable_when": f"{SCENE_TYPES.get(scene_type, scene_type)}场景，{chapter_phase}阶段",
            "avoid_when": "避免将该示例的技巧生硬套用到不相关的场景",
            "source_work": item.get("source_work", "unknown"),
            "quality_score": item.get("quality_score", 0.7),
            "confidence": item.get("quality_score", 0.7)
        }

    # -------------------------------------------------------------------------
    # 对比蒸馏规则索引构建
    # -------------------------------------------------------------------------

    def build_contrastive_index(self) -> list[dict]:
        """从 data/contrastive/*.json 构建对比蒸馏规则索引"""
        contrastive_dir = self.data_root / "contrastive"
        if not contrastive_dir.exists():
            print(f"  [跳过] 对比蒸馏目录不存在: {contrastive_dir}")
            return []

        injectable_file = contrastive_dir / "injectable_rules.json"
        if not injectable_file.exists():
            print(f"  [跳过] 可注入规则文件不存在: {injectable_file}")
            return []

        try:
            with open(injectable_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            index_entries = []
            for item in data[:200]:  # 最多200条
                entry = self._extract_contrastive_entry(item)
                if entry:
                    index_entries.append(entry)

            return index_entries

        except Exception as e:
            print(f"  [警告] 处理对比蒸馏文件失败: {e}")
            return []

    def _extract_contrastive_entry(self, item: dict) -> Optional[dict]:
        """从对比蒸馏项提取索引"""
        rule = item.get("rule", "")
        if not rule:
            return None

        scene_type = item.get("scene_type", "general")
        source = item.get("source", "contrastive_distillation")

        # 检测维度
        dimension = self._detect_dimension(rule)

        return {
            "id": self.next_id("contrastive"),
            "scene_type": scene_type,
            "dimension": dimension,
            "chapter_phase": "development",
            "emotion_target": "燃",
            "rule": rule,
            "anti_pattern": self._get_anti_for_rule(rule),
            "applicable_when": f"{SCENE_TYPES.get(scene_type, scene_type)}场景的{dimension}维度",
            "avoid_when": "避免将规则生硬化为模板",
            "source": source,
            "confidence": 0.75
        }

    def _detect_dimension(self, rule: str) -> str:
        """检测规则维度"""
        if any(w in rule for w in ["结构", "段落", "递进", "节奏"]):
            return "structure"
        elif any(w in rule for w in ["语言", "句式", "词汇", "对话"]):
            return "language"
        elif any(w in rule for w in ["情感", "情绪", "代入"]):
            return "emotion"
        elif any(w in rule for w in ["悬念", "节奏", "句长"]):
            return "rhythm"
        return "structure"

    def _get_anti_for_rule(self, rule: str) -> str:
        """获取规则的反面模式"""
        anti_map = {
            "递进": "平铺直叙，缺乏层次",
            "悬念": "直接揭示答案，缺乏钩子",
            "动作": "过多的内心独白替代动作",
            "细节": "笼统概括，缺乏具体描写",
            "对话": "对话标签单一，只有'XX道'",
        }
        for key, anti in anti_map.items():
            if key in rule:
                return anti
        return "避免违背该规则的写法"

    # -------------------------------------------------------------------------
    # 批量构建
    # -------------------------------------------------------------------------

    def build_all(self) -> dict:
        """构建所有索引"""
        print("开始构建运行时知识索引...")

        results = {
            "build_date": "2026-06-01",
            "scenes-index": self.build_scenes_index(),
            "techniques-index": self.build_techniques_index(),
            "style-lessons": self.build_style_lessons(),
            "fewshot-index": self.build_fewshot_index(),
            "contrastive-rules-index": self.build_contrastive_index(),
        }

        print(f"\n索引构建完成:")
        for key, entries in results.items():
            if isinstance(entries, list):
                print(f"  - {key}: {len(entries)} 条")

        return results

    def save_all(self, results: dict, approved: bool = False):
        """保存所有索引到文件

        Args:
            results: 索引构建结果
            approved: 是否自动批准 manifest（默认为 False，需要人工审核）
        """
        self.output_root.mkdir(parents=True, exist_ok=True)

        file_mappings = {
            "scenes-index": "scenes-index.json",
            "techniques-index": "techniques-index.json",
            "style-lessons": "style-lessons.json",
            "fewshot-index": "fewshot-index.json",
            "contrastive-rules-index": "contrastive-rules-index.json",
        }

        for key, filename in file_mappings.items():
            entries = results.get(key, [])
            output_file = self.output_root / filename
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "index_type": key,
                    "count": len(entries),
                    "entries": entries
                }, f, ensure_ascii=False, indent=2)
            print(f"  保存: {output_file} ({len(entries)} 条)")

        # P11修复：生成 manifest.json，使 KnowledgeRetriever.isAvailable() 返回 true
        # approved 默认为 False，需要人工审核后改为 true 或使用 --approve 参数
        manifest = {
            "version": "1.0",
            "generated_at": datetime.now().isoformat(),
            "approved": approved,  # P11修复：支持通过 --approve 参数自动批准
            "total_entries": sum(
                len(results.get(k, [])) for k in file_mappings.keys()
            ),
            "index_files": list(file_mappings.values()),
            "note": "将 approved 改为 true 以启用运行时知识检索"
        }
        manifest_path = self.output_root / "manifest.json"
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        approved_status = "approved=True" if approved else "approved=False (需要人工审核)"
        print(f"  保存: {manifest_path} ({approved_status})")


# ============================================================================
# 主程序
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="PiNovelStudio 运行时知识索引构建",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python build-runtime-knowledge-index.py --input data/ --output data/runtime/
    python build-runtime-knowledge-index.py --input data/ --output data/runtime/ --skip-scenes
        """
    )
    parser.add_argument("--input", "-i", required=True, help="输入数据目录 (data/)")
    parser.add_argument("--output", "-o", required=True, help="输出目录 (data/runtime/)")
    parser.add_argument("--skip-scenes", action="store_true", help="跳过场景索引构建")
    parser.add_argument("--skip-techniques", action="store_true", help="跳过技法索引构建")
    parser.add_argument("--skip-styles", action="store_true", help="跳过风格教训索引构建")
    parser.add_argument("--skip-fewshots", action="store_true", help="跳过 Few-Shot 索引构建")
    parser.add_argument("--skip-contrastive", action="store_true", help="跳过对比蒸馏索引构建")
    parser.add_argument("--approve", action="store_true", help="自动批准 manifest（approved=true），跳过人工审核")

    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"错误: 输入目录不存在: {input_path}")
        return 1

    print(f"输入目录: {input_path}")
    print(f"输出目录: {output_path}")

    builder = RuntimeIndexBuilder(input_path, output_path)
    results = builder.build_all()
    builder.save_all(results, approved=args.approve)

    print("\n运行时知识索引构建完成!")
    return 0


if __name__ == "__main__":
    exit(main())
