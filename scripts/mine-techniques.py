"""
PiNovelStudio — Layer 3: 技法原子库挖掘脚本

从网文作品中挖掘可复用的写作技法单元。
每个技法原子包含：
- 公式（核心原理）
- 实例（来自作品）
- 适用场景
- 注入指令
- 反面案例

用法：
    python mine-techniques.py --input corpus/clean/ --output data/techniques/
"""

import argparse
import json
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional
from collections import defaultdict


# ============================================================================
# 技法类型定义
# ============================================================================

TECHNIQUE_CATEGORIES = {
    "emotion": {
        "name": "情绪技法",
        "techniques": [
            {
                "id": "T001",
                "name": "延迟满足",
                "formula": "先给予小奖励建立期待，再在关键时刻给出大奖励",
                "examples": [],
                "applicable_scenes": ["突破升级", "装逼打脸"],
                "anti_pattern": "直接给大奖励，缺乏铺垫"
            },
            {
                "id": "T002",
                "name": "对比反衬",
                "formula": "通过对比突出目标人物/事件的特殊性",
                "examples": [],
                "applicable_scenes": ["装逼打脸", "战斗描写"],
                "anti_pattern": "平铺直叙，缺乏对比"
            },
            {
                "id": "T003",
                "name": "情绪反转",
                "formula": "先压制情绪，再突然释放，制造强烈情感冲击",
                "examples": [],
                "applicable_scenes": ["悲情牺牲", "感情升温"],
                "anti_pattern": "情绪线性发展，缺乏起伏"
            },
            {
                "id": "T004",
                "name": "旁观者反应",
                "formula": "通过旁观者的震惊/反应来侧面表现",
                "examples": [],
                "applicable_scenes": ["装逼打脸", "战斗描写", "突破升级"],
                "anti_pattern": "只写主角反应，缺少旁观者视角"
            },
            {
                "id": "T005",
                "name": "内心独白外化",
                "formula": "将内心活动通过细节动作表现，而非直接描写心理",
                "examples": [],
                "applicable_scenes": ["感情升温", "日常过渡"],
                "anti_pattern": "大段内心独白，干涩说教"
            },
        ]
    },
    "structure": {
        "name": "结构技法",
        "techniques": [
            {
                "id": "T010",
                "name": "悬念叠放",
                "formula": "在一个悬念解开前埋下新的悬念，保持连续吸引力",
                "examples": [],
                "applicable_scenes": ["章末悬念", "伏笔揭示"],
                "anti_pattern": "悬念孤立，一个解决再埋下一个"
            },
            {
                "id": "T011",
                "name": "多视角叙事",
                "formula": "切换不同角色的视角，丰富信息层次",
                "examples": [],
                "applicable_scenes": ["势力交锋", "章末悬念"],
                "anti_pattern": "单一视角，信息单一"
            },
            {
                "id": "T012",
                "name": "插叙回忆",
                "formula": "在关键时刻插入回忆，既补充背景又调节节奏",
                "examples": [],
                "applicable_scenes": ["悲情牺牲", "设定解说"],
                "anti_pattern": "回忆与当前剧情脱节"
            },
            {
                "id": "T013",
                "name": "首尾呼应",
                "formula": "章节开头与结尾使用相似的意象或对话，形成闭环感",
                "examples": [],
                "applicable_scenes": ["章末悬念", "日常过渡"],
                "anti_pattern": "开头结尾毫无关联"
            },
            {
                "id": "T014",
                "name": "伏笔回收",
                "formula": "之前埋下的细节在关键时刻发挥作用，产生'原来如此'感",
                "examples": [],
                "applicable_scenes": ["伏笔揭示", "装逼打脸"],
                "anti_pattern": "伏笔无回收，浪费读者期待"
            },
        ]
    },
    "description": {
        "name": "描写技法",
        "techniques": [
            {
                "id": "T020",
                "name": "五感联动",
                "formula": "调动多种感官描写，创造沉浸感",
                "examples": [],
                "applicable_scenes": ["战斗描写", "环境描写"],
                "anti_pattern": "只用视觉，单一乏味"
            },
            {
                "id": "T021",
                "name": "动静结合",
                "formula": "在动态场景中穿插静态描写，张弛有度",
                "examples": [],
                "applicable_scenes": ["战斗描写", "感情升温"],
                "anti_pattern": "全程高能，缺乏节奏变化"
            },
            {
                "id": "T022",
                "name": "特写放大",
                "formula": "对关键细节进行放大描写，强化冲击力",
                "examples": [],
                "applicable_scenes": ["战斗描写", "突破升级"],
                "anti_pattern": "泛泛而谈，缺乏重点"
            },
            {
                "id": "T023",
                "name": "侧面烘托",
                "formula": "通过环境、其他人物的间接反应来表现目标",
                "examples": [],
                "applicable_scenes": ["战斗描写", "突破升级", "装逼打脸"],
                "anti_pattern": "直接描写主角，缺少环境渲染"
            },
            {
                "id": "T024",
                "name": "比喻创新",
                "formula": "用新颖的比喻替代俗套，创造独特意象",
                "examples": [],
                "applicable_scenes": ["战斗描写", "突破升级"],
                "anti_pattern": "滥用'如同''仿佛'等模板比喻"
            },
        ]
    },
    "dialogue": {
        "name": "对话技法",
        "techniques": [
            {
                "id": "T030",
                "name": "潜台词设计",
                "formula": "让角色说出一层意思，同时暗示另一层含义",
                "examples": [],
                "applicable_scenes": ["势力交锋", "感情升温"],
                "anti_pattern": "角色说话太直白，缺乏深度"
            },
            {
                "id": "T031",
                "name": "话不说满",
                "formula": "对话留白，让读者自己推断",
                "examples": [],
                "applicable_scenes": ["章末悬念", "势力交锋"],
                "anti_pattern": "所有信息都通过对话直接说出"
            },
            {
                "id": "T032",
                "name": "行动替代对话",
                "formula": "用动作和反应替代直接对话，增加画面感",
                "examples": [],
                "applicable_scenes": ["战斗描写", "感情升温"],
                "anti_pattern": "'XX说道''XX问道'标签过多"
            },
            {
                "id": "T033",
                "name": "信息密度控制",
                "formula": "对话中信息量适中，不一次性倾倒所有设定",
                "examples": [],
                "applicable_scenes": ["设定解说", "势力交锋"],
                "anti_pattern": "大段对话讲解设定，枯燥乏味"
            },
        ]
    },
    "plot": {
        "name": "情节技法",
        "techniques": [
            {
                "id": "T040",
                "name": "意外反转",
                "formula": "打破读者预期，给出意想不到的发展",
                "examples": [],
                "applicable_scenes": ["章末悬念", "伏笔揭示"],
                "anti_pattern": "剧情发展过于可预测"
            },
            {
                "id": "T041",
                "name": "代价意识",
                "formula": "任何收获都有代价，增强故事重量感",
                "examples": [],
                "applicable_scenes": ["突破升级", "设定解说"],
                "anti_pattern": "收获无代价，过于轻浮"
            },
            {
                "id": "T042",
                "name": "连锁反应",
                "formula": "一个事件引发一系列后续变化",
                "examples": [],
                "applicable_scenes": ["势力交锋", "日常过渡"],
                "anti_pattern": "事件孤立，无连锁反应"
            },
            {
                "id": "T043",
                "name": "命运交织",
                "formula": "多个角色的命运线相互交织，产生戏剧张力",
                "examples": [],
                "applicable_scenes": ["势力交锋", "团队集结"],
                "anti_pattern": "角色独立行动，缺少命运交织"
            },
            {
                "id": "T044",
                "name": "高潮铺垫",
                "formula": "通过一系列小高潮逐步推向大高潮",
                "examples": [],
                "applicable_scenes": ["战斗描写", "突破升级"],
                "anti_pattern": "直接跳到高潮，前期铺垫不足"
            },
        ]
    }
}


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class Technique:
    """技法原子"""
    id: str
    name: str
    category: str
    formula: str
    examples: list = field(default_factory=list)
    applicable_scenes: list = field(default_factory=list)
    injection_instruction: str = ""
    anti_pattern: str = ""
    source_works: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict, category: str = "") -> "Technique":
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            category=category,
            formula=data.get("formula", ""),
            examples=data.get("examples", []),
            applicable_scenes=data.get("applicable_scenes", []),
            injection_instruction=data.get("injection_instruction", ""),
            anti_pattern=data.get("anti_pattern", ""),
            source_works=data.get("source_works", [])
        )


# ============================================================================
# 技法挖掘引擎
# ============================================================================

class TechniqueMiner:
    """技法挖掘引擎"""

    def __init__(self) -> None:
        self.technique_templates = self._load_technique_templates()

    def _load_technique_templates(self) -> dict:
        """加载技法模板"""
        return TECHNIQUE_CATEGORIES

    def extract_examples(self, text: str, technique: dict) -> list:
        """从文本中提取技法的使用示例"""
        examples = []
        technique_name = technique["name"]
        keywords = self._get_technique_keywords(technique_name)

        # 查找可能的示例段落
        for keyword in keywords:
            if keyword in text:
                # 提取包含关键词的段落
                pos = text.find(keyword)
                start = max(0, pos - 200)
                end = min(len(text), pos + 500)
                excerpt = text[start:end].strip()

                if len(excerpt) >= 100:  # 至少100字
                    examples.append({
                        "text": excerpt,
                        "source": "auto_extracted",
                        "match_keyword": keyword
                    })

        return examples[:3]  # 最多3个示例

    def _get_technique_keywords(self, technique_name: str) -> list:
        """获取技法相关的关键词"""
        keyword_map = {
            "延迟满足": ["终于", "等到了", "这一刻", "突破"],
            "对比反衬": ["相比", "而他", "截然不同", "却"],
            "情绪反转": ["然而", "没想到", "出乎意料", "谁知"],
            "旁观者反应": ["众人", "周围", "在场", "看到这一幕"],
            "内心独白外化": ["不由得", "忍不住", "下意识"],
            "悬念叠放": ["就在此时", "正当", "与此同时"],
            "多视角叙事": ["与此同时", "另一边", "却说"],
            "插叙回忆": ["想起", "回忆", "曾经", "那时候"],
            "首尾呼应": ["正如", "就像", "呼应"],
            "伏笔回收": ["原来", "竟是", "原来如此"],
            "五感联动": ["听到", "看到", "感到", "闻到", "触到"],
            "动静结合": ["突然", "紧接着", "此时"],
            "特写放大": ["只见", "尤其是", "特别是"],
            "侧面烘托": ["周围", "众人", "仿佛"],
            "比喻创新": ["如同", "仿佛", "好像"],
            "潜台词设计": ["话里有话", "意味深长", "一语双关"],
            "话不说满": ["欲言又止", "没有说"],
            "行动替代对话": ["点头", "摇头", "转身", "抬手"],
            "信息密度控制": ["简单", "不多说", "点到为止"],
            "意外反转": ["然而", "出人意料", "谁知", "没想到"],
            "代价意识": ["代价", "然而", "但也", "因此"],
            "连锁反应": ["随之", "紧接着", "于是", "于是乎"],
            "命运交织": ["纠缠", "交织", "命运", "缘分"],
            "高潮铺垫": ["终于", "即将", "眼看", "就在这一刻"],
        }
        return keyword_map.get(technique_name, [])

    def mine_from_corpus(self, novel_data: dict) -> dict:
        """从语料中挖掘技法"""
        work_title = novel_data.get("title", "")
        all_text = "\n".join(ch.get("text", "") for ch in novel_data.get("chapters", []))

        mined_techniques = {}

        for category, category_data in self.technique_templates.items():
            for technique_template in category_data["techniques"]:
                # 提取示例
                examples = self.extract_examples(all_text, technique_template)

                if examples:
                    technique = Technique.from_dict(technique_template, category)
                    technique.source_works = [work_title]
                    technique.examples = examples
                    technique.injection_instruction = self._generate_injection_instruction(technique)

                    mined_techniques[technique.id] = technique

        return mined_techniques

    def _generate_injection_instruction(self, technique: Technique) -> str:
        """生成注入指令"""
        return f"应用'{technique.name}'技法：{technique.formula}"


class TechniqueLibrary:
    """技法库管理器"""

    def __init__(self):
        self.techniques = {}
        self._load_templates()

    def _load_templates(self):
        """加载所有技法模板"""
        for category, category_data in TECHNIQUE_CATEGORIES.items():
            for template in category_data["techniques"]:
                technique = Technique.from_dict(template, category)
                self.techniques[technique.id] = technique

    def add_mined_technique(self, technique: Technique):
        """添加挖掘到的技法"""
        existing = self.techniques.get(technique.id)
        if existing:
            # 合并示例和来源
            existing.examples.extend(technique.examples)
            existing.source_works = list(set(existing.source_works + technique.source_works))
        else:
            self.techniques[technique.id] = technique

    def get_by_scene(self, scene_type: str) -> list[Technique]:
        """获取适用于特定场景的技法"""
        result = []
        for technique in self.techniques.values():
            if scene_type in technique.applicable_scenes:
                result.append(technique)
        return result

    def get_by_category(self, category: str) -> list[Technique]:
        """获取特定类别的技法"""
        return [t for t in self.techniques.values() if t.category == category]

    def export(self) -> dict:
        """导出为JSON格式"""
        by_category = defaultdict(list)
        for technique in self.techniques.values():
            by_category[technique.category].append(technique.to_dict())

        return {
            "export_date": "2026-05-27",
            "total_techniques": len(self.techniques),
            "categories": {
                cat: TECHNIQUE_CATEGORIES[cat]["name"]
                for cat in TECHNIQUE_CATEGORIES.keys()
            },
            "techniques_by_category": dict(by_category)
        }

    def export_flat(self) -> list:
        """导出为扁平列表"""
        return [t.to_dict() for t in self.techniques.values()]


# ============================================================================
# 主程序
# ============================================================================

def load_novel_json(file_path: str) -> dict:
    """加载小说JSON"""
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 技法挖掘")
    parser.add_argument("--input", "-i", required=True, help="输入文件或目录")
    parser.add_argument("--output", "-o", required=True, help="输出目录")
    parser.add_argument("--batch", "-b", action="store_true", help="批量处理")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    library = TechniqueLibrary()

    if args.batch:
        # 批量处理
        input_dir = Path(args.input)
        json_files = list(input_dir.glob("*.json"))
        print(f"批量处理: {len(json_files)} 个文件")

        for json_file in json_files:
            try:
                print(f"\n处理: {json_file.name}")
                novel_data = load_novel_json(str(json_file))

                miner = TechniqueMiner()
                mined = miner.mine_from_corpus(novel_data)

                for technique_id, technique in mined.items():
                    library.add_mined_technique(technique)

                print(f"  -> 挖掘 {len(mined)} 个技法")

            except Exception as e:
                print(f"  -> 错误: {e}")

    else:
        # 单文件处理
        print(f"处理: {args.input}")
        novel_data = load_novel_json(args.input)

        miner = TechniqueMiner()
        mined = miner.mine_from_corpus(novel_data)

        for technique_id, technique in mined.items():
            library.add_mined_technique(technique)

        print(f"挖掘 {len(mined)} 个技法")

    # 导出结果
    print(f"\n总计: {len(library.techniques)} 个技法")

    # 导出按类别分类
    output_data = library.export()
    output_file = output_dir / "techniques_by_category.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
    print(f"保存到: {output_file}")

    # 导出扁平列表
    flat_output = output_dir / "techniques_flat.json"
    with open(flat_output, 'w', encoding='utf-8') as f:
        json.dump(library.export_flat(), f, ensure_ascii=False, indent=2)
    print(f"保存到: {flat_output}")

    # 导出按场景索引
    scenes_index = {}
    scene_types = [
        "突破升级", "装逼打脸", "战斗描写", "感情升温",
        "伏笔揭示", "设定解说", "日常过渡", "势力交锋",
        "悲情牺牲", "豪赌博弈", "团队集结", "章末悬念"
    ]
    for scene in scene_types:
        scenes_index[scene] = [t.id for t in library.get_by_scene(scene)]

    scenes_output = output_dir / "techniques_by_scene.json"
    with open(scenes_output, 'w', encoding='utf-8') as f:
        json.dump(scenes_index, f, ensure_ascii=False, indent=2)
    print(f"保存到: {scenes_output}")


if __name__ == "__main__":
    main()
