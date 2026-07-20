"""
PiNovelStudio — Layer 5: 对比蒸馏知识库构建脚本

从好作品与 AI/差作品的对比中提取精确的质量差异知识。
这是最难被复制的壁垒层。

对比维度：
1. 结构差异
2. 语言差异
3. 节奏差异
4. 情感差异

用法：
    python contrastive-distill.py --good-path corpus/good/ --output data/contrastive/
    python contrastive-distill.py --generate-samples --output data/contrastive/
"""

import argparse
import json
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional
from collections import defaultdict


# ============================================================================
# 对比分析类型
# ============================================================================

@dataclass
class ContrastPair:
    """对比对"""
    scene_type: str
    good_text: str
    average_text: str
    delta_analysis: list = field(default_factory=list)  # 差异分析
    injectable_rules: list = field(default_factory=list)  # 可注入规则
    improvement_score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ContrastSet:
    """对比集"""
    scene_type: str
    scene_name: str
    pairs: list = field(default_factory=list)
    common_patterns: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ============================================================================
# 对比分析引擎
# ============================================================================

class ContrastAnalyzer:
    """对比分析引擎"""

    # 好作品的特征
    GOOD_PATTERNS = {
        "structure": [
            "层层递进",
            "起伏有致",
            "节奏明快",
            "详略得当",
            "首尾呼应",
        ],
        "language": [
            "精准",
            "生动",
            "画面感",
            "张力",
            "凝练",
        ],
        "emotion": [
            "代入感强",
            "情感真挚",
            "触动人心",
            "共鸣",
        ],
        "technique": [
            "五感描写",
            "侧面烘托",
            "细节特写",
            "留白艺术",
        ]
    }

    # 差作品的特征
    BAD_PATTERNS = {
        "structure": [
            "平铺直叙",
            "流水账",
            "拖沓",
            "跳跃",
        ],
        "language": [
            "冗长",
            "重复",
            "空洞",
            "说教",
        ],
        "emotion": [
            "平淡",
            "做作",
            "尴尬",
            "无病呻吟",
        ],
        "technique": [
            "模板化",
            "套路",
            "公式化",
            "AI腔",
        ]
    }

    # AI腔常见模式
    AI_PATTERNS = [
        "首先",
        "其次",
        "最后",
        "这意味着",
        "一方面",
        "另一方面",
        "总之",
        "非常",
        "十分",
        "极其",
        "仿佛",
        "一般",
        "似的",
        "不知为何",
        "一股",
        "的气息",
        "眼中闪过",
        "心中涌起",
        "在...的过程中",
        "被...被...被...",
    ]

    def analyze_contrast(self, good_text: str, bad_text: str, scene_type: str) -> ContrastPair:
        """分析对比差异"""
        pair = ContrastPair(
            scene_type=scene_type,
            good_text=good_text[:2000],
            average_text=bad_text[:2000]
        )

        # 分析结构差异
        structure_delta = self._analyze_structure(good_text, bad_text)
        pair.delta_analysis.append(structure_delta)

        # 分析语言差异
        language_delta = self._analyze_language(good_text, bad_text)
        pair.delta_analysis.append(language_delta)

        # 分析节奏差异
        rhythm_delta = self._analyze_rhythm(good_text, bad_text)
        pair.delta_analysis.append(rhythm_delta)

        # 分析情感差异
        emotion_delta = self._analyze_emotion(good_text, bad_text)
        pair.delta_analysis.append(emotion_delta)

        # 生成可注入规则
        pair.injectable_rules = self._generate_rules(pair.delta_analysis)

        # 计算改进分数
        pair.improvement_score = self._calculate_improvement_score(good_text, bad_text)

        return pair

    def _analyze_structure(self, good: str, bad: str) -> dict:
        """分析结构差异"""
        good_sentences = len(re.findall(r'[。！？；\n]', good))
        bad_sentences = len(re.findall(r'[。！？；\n]', bad))

        good_paragraphs = len(good.split('\n\n'))
        bad_paragraphs = len(bad.split('\n\n'))

        # 检测递进结构
        good_has_progression = any(kw in good for kw in ["先", "然后", "接着", "最终", "终于"])
        bad_has_progression = any(kw in bad for kw in ["先", "然后", "接着", "最终", "终于"])

        # 检测悬念
        good_suspense = good.count('？') + good.count('悬念')
        bad_suspense = bad.count('？') + bad.count('悬念')

        return {
            "dimension": "结构",
            "good_features": [
                f"段落数: {good_paragraphs}",
                f"递进结构: {'有' if good_has_progression else '无'}",
                f"悬念设置: {good_suspense}处",
            ],
            "bad_features": [
                f"段落数: {bad_paragraphs}",
                f"递进结构: {'有' if bad_has_progression else '无'}",
                f"悬念设置: {bad_suspense}处",
            ],
            "delta": self._format_delta(
                f"好: 段落组织合理{'，有递进' if good_has_progression else '，缺少递进'}，悬念{good_suspense}处",
                f"差: 段落{'过多' if bad_paragraphs > good_paragraphs else '不足'}，{'缺少悬念' if bad_suspense == 0 else f'悬念{bad_suspense}处'}"
            )
        }

    def _analyze_language(self, good: str, bad: str) -> dict:
        """分析语言差异"""
        # 检测成语密度
        idioms = ["栩栩如生", "惊天动地", "势如破竹", "所向披靡", "叹为观止", "瞠目结舌"]
        good_idiom_count = sum(good.count(i) for i in idioms)
        bad_idiom_count = sum(bad.count(i) for i in idioms)

        # 检测AI腔
        good_ai_count = sum(bad.count(p) for p in self.AI_PATTERNS if len(p) > 2)
        bad_ai_count = sum(good.count(p) for p in self.AI_PATTERNS if len(p) > 2)

        # 交换检测逻辑 - 真正检测good和bad中的AI腔
        good_ai_count = sum(good.count(p) for p in self.AI_PATTERNS if len(p) > 2)
        bad_ai_count = sum(bad.count(p) for p in self.AI_PATTERNS if len(p) > 2)

        # 检测具体对话标签
        good_dialogue_tags = len(re.findall(r'\w+道[：:]', good))
        bad_dialogue_tags = len(re.findall(r'\w+道[：:]', bad))

        return {
            "dimension": "语言",
            "good_features": [
                f"成语密度: {good_idiom_count}",
                f"AI腔痕迹: {good_ai_count}处",
                f"对话标签: {good_dialogue_tags}种",
            ],
            "bad_features": [
                f"成语密度: {bad_idiom_count}",
                f"AI腔痕迹: {bad_ai_count}处",
                f"对话标签: {bad_dialogue_tags}种",
            ],
            "delta": self._format_delta(
                f"好: 语言{'精炼，' if good_ai_count < bad_ai_count else '啰嗦'}，成语运用得当",
                f"差: {'语言啰嗦' if bad_ai_count > good_ai_count else '语言精炼'}，{'AI腔明显' if bad_ai_count > 5 else 'AI腔较少'}"
            )
        }

    def _analyze_rhythm(self, good: str, bad: str) -> dict:
        """分析节奏差异"""
        # 句子长度分析
        good_sentences = re.split(r'[。！？；\n]', good)
        good_sentences = [s.strip() for s in good_sentences if s.strip()]
        good_lengths = [len(re.findall(r'[\u4e00-\u9fa5]', s)) for s in good_sentences]
        good_avg = sum(good_lengths) / len(good_lengths) if good_lengths else 0
        good_variance = max(good_lengths) - min(good_lengths) if good_lengths else 0

        bad_sentences = re.split(r'[。！？；\n]', bad)
        bad_sentences = [s.strip() for s in bad_sentences if s.strip()]
        bad_lengths = [len(re.findall(r'[\u4e00-\u9fa5]', s)) for s in bad_sentences]
        bad_avg = sum(bad_lengths) / len(bad_lengths) if bad_lengths else 0
        bad_variance = max(bad_lengths) - min(bad_lengths) if bad_lengths else 0

        # 检测感叹号
        good_exclaim = good.count('！')
        bad_exclaim = bad.count('！')

        return {
            "dimension": "节奏",
            "good_features": [
                f"平均句长: {good_avg:.0f}字",
                f"句长波动: {good_variance}",
                f"感叹号: {good_exclaim}处",
            ],
            "bad_features": [
                f"平均句长: {bad_avg:.0f}字",
                f"句长波动: {bad_variance}",
                f"感叹号: {bad_exclaim}处",
            ],
            "delta": self._format_delta(
                f"好: 句长{good_avg:.0f}字，节奏{good_variance > bad_variance and '有变化' or '平稳'}",
                f"差: 句长{bad_avg:.0f}字，节奏{'单调' if bad_variance < good_variance else '变化大'}"
            )
        }

    def _analyze_emotion(self, good: str, bad: str) -> dict:
        """分析情感差异"""
        # 检测情感词
        emotion_words = {
            "燃": ["热血", "激情", "斗志"],
            "爽": ["痛快", "过瘾", "爽感"],
            "感动": ["流泪", "心酸", "温暖"],
            "愤怒": ["愤怒", "暴怒", "气愤"],
        }

        good_emotions = {e: sum(good.count(w) for w in words) for e, words in emotion_words.items()}
        bad_emotions = {e: sum(bad.count(w) for w in words) for e, words in emotion_words.items()}

        # 检测内心独白
        good_inner = len(re.findall(r'心想|心中|暗道|想道', good))
        bad_inner = len(re.findall(r'心想|心中|暗道|想道', bad))

        return {
            "dimension": "情感",
            "good_features": [
                f"情感词丰富度: {sum(good_emotions.values())}",
                f"内心独白: {good_inner}处",
            ],
            "bad_features": [
                f"情感词丰富度: {sum(bad_emotions.values())}",
                f"内心独白: {bad_inner}处",
            ],
            "delta": self._format_delta(
                f"好: 情感{'丰富' if sum(good_emotions.values()) > sum(bad_emotions.values()) else '一般'}，有代入感",
                f"差: 情感{'平淡' if sum(bad_emotions.values()) < 3 else '有一定情感'}，{'内心独白过多' if bad_inner > 5 else '内心独白适中'}"
            )
        }

    def _format_delta(self, good_desc: str, bad_desc: str) -> str:
        """格式化差异描述"""
        return f"好: {good_desc}。差: {bad_desc}。"

    def _generate_rules(self, delta_analysis: list) -> list:
        """从差异分析生成可注入规则"""
        rules = []

        for delta in delta_analysis:
            dimension = delta.get("dimension", "")
            good_features = delta.get("good_features", [])

            if dimension == "结构":
                rules.append("保持段落组织清晰，避免流水账")
                if "递进结构" in str(good_features):
                    rules.append("使用递进结构：先铺垫，再发展，后高潮")
                rules.append("适当设置悬念，保持读者好奇心")

            elif dimension == "语言":
                rules.append("避免AI腔模式：不用'首先''其次''最后'等模板")
                rules.append("用具体细节替代程度副词（非常、十分）")
                rules.append("对话标签多样化，不只用'XX道'")

            elif dimension == "节奏":
                rules.append("句长有变化，长短交替")
                rules.append("关键节点使用短句增强冲击力")
                rules.append("感叹号适度使用，强化情绪")

            elif dimension == "情感":
                rules.append("内心活动外化为动作和表情")
                rules.append("情感推进要自然，不要突兀")
                rules.append("使用具体情感词，而非笼统描写")

        return list(set(rules))  # 去重

    def _calculate_improvement_score(self, good: str, bad: str) -> float:
        """计算改进分数"""
        score = 0.5  # 基础分

        # AI腔检测
        bad_ai_count = sum(bad.count(p) for p in self.AI_PATTERNS if len(p) > 2)
        good_ai_count = sum(good.count(p) for p in self.AI_PATTERNS if len(p) > 2)
        if bad_ai_count > good_ai_count:
            score += 0.1 * min((bad_ai_count - good_ai_count) / 10, 1)

        # 句长变化
        good_var = len(set([len(s) for s in good.split('。')]))
        bad_var = len(set([len(s) for s in bad.split('。')]))
        if good_var > bad_var:
            score += 0.1

        # 悬念设置
        if '？' in good and '？' not in bad:
            score += 0.1

        # 情感词密度
        emotion_words = ["热血", "感动", "愤怒", "痛快", "心酸"]
        good_em = sum(good.count(w) for w in emotion_words)
        bad_em = sum(bad.count(w) for w in emotion_words)
        if good_em > bad_em:
            score += 0.1

        return min(score, 1.0)


class ContrastiveLibrary:
    """对比蒸馏库"""

    def __init__(self):
        self.pairs = defaultdict(list)

    def add_pair(self, pair: ContrastPair):
        """添加对比对"""
        self.pairs[pair.scene_type].append(pair.to_dict())

    def generate_from_templates(self, scene_type: str, good_texts: list, bad_texts: list) -> list:
        """从模板生成对比"""
        analyzer = ContrastAnalyzer()
        pairs = []

        for good, bad in zip(good_texts, bad_texts):
            if good and bad:
                pair = analyzer.analyze_contrast(good, bad, scene_type)
                self.add_pair(pair)
                pairs.append(pair)

        return pairs

    def export(self) -> dict:
        """导出为JSON"""
        result = {
            "export_date": "2026-05-27",
            "scene_types": {},
            "total_pairs": 0,
            "pairs_by_scene": {}
        }

        for scene_type, pairs in self.pairs.items():
            result["pairs_by_scene"][scene_type] = pairs
            result["total_pairs"] += len(pairs)

        return result

    def export_rules(self) -> list:
        """导出为规则列表"""
        analyzer = ContrastAnalyzer()
        all_rules = []

        for pairs in self.pairs.values():
            for pair in pairs:
                for rule in pair.get("injectable_rules", []):
                    all_rules.append({
                        "scene_type": pair.get("scene_type"),
                        "rule": rule,
                        "source": "contrastive_distillation"
                    })

        return all_rules


# ============================================================================
# 内置对比模板
# ============================================================================

BUILTIN_CONTRAST_TEMPLATES = {
    "breakthrough": {
        "good_patterns": [
            "林雷感受着体内斗气的流转，心中涌起一股难以言喻的力量感。",
            "就在突破的那一刻，天空中乌云翻滚，雷光闪烁。",
            "众人看到那道冲天的光芒，皆是倒吸一口凉气。",
            "终于成功了！林雷握紧拳头，眼中闪烁着坚定的光芒。",
        ],
        "bad_patterns": [
            "他开始突破，感觉到力量在体内流动。",
            "突破完成，他感觉变强了。",
            "他成功了。大家都看到了。",
            "突破成功。他很开心。",
        ]
    },
    "face_slapping": {
        "good_patterns": [
            "张三冷笑一声，'就凭你？'他轻轻抬手，一道剑气横空而出。",
            "李四脸色大变，想要躲避却已来不及，只能眼睁睁看着剑气落下。",
            "围观众人顿时鸦雀无声，方才还在嘲笑张三的嘴脸，此刻满是震惊。",
            "张三收回剑气，看都不看倒在地上的李四一眼，'不过如此。'",
        ],
        "bad_patterns": [
            "张三很强，李四不是他的对手。",
            "李四被张三打败了，大家都说他很厉害。",
            "战斗结束了，张三赢了。",
            "李四后悔惹了张三。",
        ]
    },
    "combat": {
        "good_patterns": [
            "刀光剑影间，两道身影不断交错。",
            "王五眼神一凝，手中长刀横扫而出，带起一片血色光芒。",
            "尘土飞扬中，两人又交手了数十招，谁也无法奈何对方。",
            "就在此时，王五身形一闪，长刀直取对方咽喉，快如闪电！",
        ],
        "bad_patterns": [
            "两人开始战斗，你来我往。",
            "战斗很激烈，最后王五赢了。",
            "王五很强，对方打不过他。",
            "战斗结束了。",
        ]
    }
}


# ============================================================================
# 主程序
# ============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 对比蒸馏")
    parser.add_argument("--good-path", "-g", help="好作品目录")
    parser.add_argument("--bad-path", "-b", help="差作品目录")
    parser.add_argument("--output", "-o", required=True, help="输出目录")
    parser.add_argument("--generate-samples", action="store_true", help="生成示例对比")
    parser.add_argument("--num-pairs", "-n", type=int, default=10, help="生成的对数")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    library = ContrastiveLibrary()

    if args.generate_samples:
        # 生成示例对比
        print("生成示例对比...")

        for scene_type, templates in BUILTIN_CONTRAST_TEMPLATES.items():
            good_texts = templates["good_patterns"]
            bad_texts = templates["bad_patterns"]

            pairs = library.generate_from_templates(
                scene_type,
                good_texts,
                bad_texts
            )
            print(f"  {scene_type}: {len(pairs)} 对")

    elif args.good_path and args.bad_path:
        # 从文件对比
        good_dir = Path(args.good_path)
        bad_dir = Path(args.bad_path)

        good_files = list(good_dir.glob("*.txt")) + list(good_dir.glob("*.json"))
        print(f"加载 {len(good_files)} 个好作品")

        analyzer = ContrastAnalyzer()

        for good_file in good_files[:args.num_pairs]:
            try:
                # 读取文件
                if good_file.suffix == ".json":
                    with open(good_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        good_text = "\n".join(ch.get("text", "") for ch in data.get("chapters", []))
                else:
                    with open(good_file, 'r', encoding='utf-8') as f:
                        good_text = f.read()

                # 查找对应的差作品（如果没有就用简化版本）
                bad_file = bad_dir / good_file.name
                if bad_file.exists():
                    if bad_file.suffix == ".json":
                        with open(bad_file, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            bad_text = "\n".join(ch.get("text", "") for ch in data.get("chapters", []))
                    else:
                        with open(bad_file, 'r', encoding='utf-8') as f:
                            bad_text = f.read()
                else:
                    # 生成简化版本作为对比
                    bad_text = _simplify_text(good_text)

                # 分析对比
                pair = analyzer.analyze_contrast(
                    good_text[:5000],
                    bad_text[:5000],
                    "general"
                )
                library.add_pair(pair)
                print(f"  {good_file.stem}: 改进分数 {pair.improvement_score:.2f}")

            except Exception as e:
                print(f"  错误: {good_file.stem} - {e}")

    # 导出结果
    print(f"\n导出对比蒸馏库...")

    result = library.export()
    output_file = output_dir / "contrastive_full.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"保存到: {output_file}")

    # 导出规则
    rules = library.export_rules()
    rules_file = output_dir / "injectable_rules.json"
    with open(rules_file, 'w', encoding='utf-8') as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)
    print(f"保存到: {rules_file}")

    # 生成对比指南
    guidelines = _generate_guidelines(result)
    guidelines_file = output_dir / "contrastive_guidelines.md"
    with open(guidelines_file, 'w', encoding='utf-8') as f:
        f.write(guidelines)
    print(f"保存到: {guidelines_file}")

    print(f"\n对比蒸馏完成:")
    print(f"  - 总对比对数: {result['total_pairs']}")


def _simplify_text(text: str) -> str:
    """生成简化版本作为对比"""
    # 简化文本（模拟AI生成）
    lines = text.split('\n')
    simplified = []

    for line in lines[:50]:
        # 移除细节描写
        line = re.sub(r'只见.*?。', '他看到了什么。', line)
        line = re.sub(r'感到.*?。', '他感觉到了什么。', line)
        line = re.sub(r'心中.*?。', '他心想。', line)
        simplified.append(line)

    return '\n'.join(simplified)


def _generate_guidelines(result: dict) -> str:
    """生成对比指南"""
    guidelines = """# 对比蒸馏指南

> 基于好作品与差作品的对比分析生成的写作指南

## 通用规则

### 结构规则
- 保持段落组织清晰，避免流水账
- 使用递进结构：先铺垫，再发展，后高潮
- 适当设置悬念，保持读者好奇心

### 语言规则
- 避免AI腔模式：不用"首先""其次""最后"等模板
- 用具体细节替代程度副词（非常、十分）
- 对话标签多样化，不只用"XX道"

### 节奏规则
- 句长有变化，长短交替
- 关键节点使用短句增强冲击力
- 感叹号适度使用，强化情绪

### 情感规则
- 内心活动外化为动作和表情
- 情感推进要自然，不要突兀
- 使用具体情感词，而非笼统描写

"""

    # 按场景添加具体规则
    for scene_type, pairs in result.get("pairs_by_scene", {}).items():
        if pairs:
            guidelines += f"## {scene_type} 场景规则\n\n"

            # 收集所有规则
            all_rules = set()
            for pair in pairs:
                for rule in pair.get("injectable_rules", []):
                    all_rules.add(rule)

            for rule in all_rules:
                guidelines += f"- {rule}\n"

            guidelines += "\n"

    return guidelines


if __name__ == "__main__":
    main()
