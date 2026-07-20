"""
PiNovelStudio — Knowledge Context Quality Evaluator

评估不同知识库增强方案对生成质量的影响。

对比三组：
- A: 无知识库增强
- B: 当前轻量知识库 (KnowledgeContextBuilder)
- C: Runtime 检索增强 (KnowledgeRetriever)

评估指标：
- Critic 总分
- StyleShaper 风格偏差
- AntiAIDetector AI 腔密度
- 信息噪音/说明腔
- 角色声音漂移
- 字数失控
- 场景完成度

用法：
    # 三组对比（从不同目录读取章节文件）
    python evaluate-knowledge-context.py \
        --input-a chapters/control/ \
        --input-b chapters/light/ \
        --input-c chapters/runtime/ \
        --chapters 3

    # 单模式评估（指定章节文件）
    python evaluate-knowledge-context.py --workspace workspaces/test-novel --mode A --chapter 5

注意：真正的 A/B/C 对比需要先生成三组章节：
1. A 组：关闭所有知识库增强
2. B 组：只启用轻量知识库
3. C 组：启用轻量 + Runtime 检索增强（需 manifest.json approved: true）

或者直接提供已有章节文件：
    --input-a path/to/chapters-without-enhancement/
    --input-b path/to/chapters-with-light-enhancement/
    --input-c path/to/chapters-with-runtime-enhancement/
"""

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Optional


# ============================================================================
# 评估指标数据结构
# ============================================================================

@dataclass
class EvaluationMetrics:
    """评估指标"""
    # 整体评分
    critic_score: float = 0.0  # 0-100

    # 风格一致性
    style_deviation: float = 0.0  # 0-100, 越小越好

    # AI 腔检测
    ai_density: float = 0.0  # 0-100, 越小越好

    # 信息质量
    info_noise_ratio: float = 0.0  # 0-100, 越小越好
    exposition_ratio: float = 0.0  # 0-100, 越小越好

    # 角色一致性
    character_voice_drift: float = 0.0  # 0-100, 越小越好

    # 结构完整性
    word_count: int = 0
    word_count_deviation: float = 0.0  # 偏离目标字数的百分比
    scene_completion: float = 0.0  # 0-100

    # 叙事质量
    show_dont_tell_ratio: float = 0.0  # 0-100, 越大越好
    dialogue_naturalness: float = 0.0  # 0-100

    # 情感质量
    emotion_consistency: float = 0.0  # 0-100
    emotional_engagement: float = 0.0  # 0-100

    def to_dict(self) -> dict:
        return asdict(self)

    def average(self) -> float:
        """计算综合平均分（排除字数偏离）"""
        scores = [
            self.critic_score,
            100 - self.style_deviation,
            100 - self.ai_density,
            100 - self.info_noise_ratio,
            100 - self.exposition_ratio,
            100 - self.character_voice_drift,
            self.scene_completion,
            self.show_dont_tell_ratio,
            self.dialogue_naturalness,
            self.emotion_consistency,
            self.emotional_engagement,
        ]
        return sum(scores) / len(scores)


@dataclass
class EvaluationResult:
    """评估结果"""
    mode: str  # A, B, or C
    chapter_num: int
    scene_type: str
    metrics: EvaluationMetrics
    raw_text: str
    evaluation_time_ms: int
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "chapter_num": self.chapter_num,
            "scene_type": self.scene_type,
            "metrics": self.metrics.to_dict(),
            "evaluation_time_ms": self.evaluation_time_ms,
            "errors": self.errors,
            "warnings": self.warnings,
        }


@dataclass
class ComparisonReport:
    """对比报告"""
    timestamp: str
    workspace: str
    chapters_tested: list
    results: dict  # mode -> list of EvaluationResult

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "workspace": self.workspace,
            "chapters_tested": self.chapters_tested,
            "results": {k: [r.to_dict() for r in v] for k, v in self.results.items()},
            "summary": self._generate_summary(),
        }

    def _generate_summary(self) -> dict:
        """生成摘要"""
        summary = {}
        for mode, results in self.results.items():
            if not results:
                continue

            avg_metrics = EvaluationMetrics()
            for r in results:
                m = r.metrics
                avg_metrics.critic_score += m.critic_score
                avg_metrics.style_deviation += m.style_deviation
                avg_metrics.ai_density += m.ai_density
                avg_metrics.info_noise_ratio += m.info_noise_ratio
                avg_metrics.exposition_ratio += m.exposition_ratio
                avg_metrics.character_voice_drift += m.character_voice_drift
                avg_metrics.scene_completion += m.scene_completion
                avg_metrics.show_dont_tell_ratio += m.show_dont_tell_ratio
                avg_metrics.dialogue_naturalness += m.dialogue_naturalness
                avg_metrics.emotion_consistency += m.emotion_consistency
                avg_metrics.emotional_engagement += m.emotional_engagement

            n = len(results)
            avg_metrics.critic_score /= n
            avg_metrics.style_deviation /= n
            avg_metrics.ai_density /= n
            avg_metrics.info_noise_ratio /= n
            avg_metrics.exposition_ratio /= n
            avg_metrics.character_voice_drift /= n
            avg_metrics.scene_completion /= n
            avg_metrics.show_dont_tell_ratio /= n
            avg_metrics.dialogue_naturalness /= n
            avg_metrics.emotion_consistency /= n
            avg_metrics.emotional_engagement /= n

            summary[mode] = {
                "avg_metrics": avg_metrics.to_dict(),
                "overall_score": avg_metrics.average(),
                "chapter_count": n,
            }

        return summary


# ============================================================================
# 评估引擎
# ============================================================================

class QualityEvaluator:
    """质量评估引擎"""

    # AI 腔特征词
    AI_PATTERNS = [
        r"首先", r"其次", r"最后",
        r"这意味着", r"一方面", r"另一方面",
        r"总之", r"值得注意的是",
        r"非常", r"十分", r"极其", r"格外",
        r"仿佛", r"一般", r"似的",
        r"不知为何", r"一股.*?的气息",
        r"眼中闪过", r"心中涌起",
        r"在.*?的过程中",
        r"被.*?被.*?被",
    ]

    # 弱描写词
    WEAK_DESCRIPTORS = [
        "非常好", "十分重要", "极其关键",
        "非常高兴", "十分感动", "极其愤怒",
    ]

    def __init__(self, target_word_count: int = 3000):
        self.target_word_count = target_word_count

    def evaluate(self, text: str, scene_type: str = "general") -> EvaluationMetrics:
        """评估文本质量"""
        metrics = EvaluationMetrics()

        # 基本统计
        chinese_chars = re.findall(r'[\u4e00-\u9fa5]', text)
        metrics.word_count = len(chinese_chars)
        metrics.word_count_deviation = abs(metrics.word_count - self.target_word_count) / self.target_word_count * 100

        # AI 腔检测
        metrics.ai_density = self._evaluate_ai_density(text)

        # 风格一致性（基于句长变化）
        metrics.style_deviation = self._evaluate_style_deviation(text)

        # 信息噪音
        metrics.info_noise_ratio = self._evaluate_info_noise(text)

        # 说明腔比例
        metrics.exposition_ratio = self._evaluate_exposition_ratio(text)

        # 角色声音漂移（简化版）
        metrics.character_voice_drift = self._evaluate_character_drift(text)

        # 场景完成度
        metrics.scene_completion = self._evaluate_scene_completion(text, scene_type)

        # Show don't tell
        metrics.show_dont_tell_ratio = self._evaluate_show_dont_tell(text)

        # 对话自然度
        metrics.dialogue_naturalness = self._evaluate_dialogue_naturalness(text)

        # 情感一致性
        metrics.emotion_consistency = self._evaluate_emotion_consistency(text)

        # 情感投入度
        metrics.emotional_engagement = self._evaluate_emotional_engagement(text)

        # Critic 分数（模拟，实际需要调用 Critic Agent）
        metrics.critic_score = self._calculate_critic_score(metrics)

        return metrics

    def _evaluate_ai_density(self, text: str) -> float:
        """评估 AI 腔密度"""
        ai_count = 0
        for pattern in self.AI_PATTERNS:
            ai_count += len(re.findall(pattern, text))

        # 归一化到 0-100
        chinese_chars = len(re.findall(r'[\u4e00-\u9fa5]', text))
        if chinese_chars == 0:
            return 0.0

        density = (ai_count / chinese_chars) * 10000  # 每万字
        return min(density, 100.0)

    def _evaluate_style_deviation(self, text: str) -> float:
        """评估风格偏差（基于句长变化）"""
        sentences = re.split(r'[。！？；\n]', text)
        sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 2]

        if len(sentences) < 5:
            return 0.0

        # 计算句长标准差
        lengths = [len(re.findall(r'[\u4e00-\u9fa5]', s)) for s in sentences]
        if len(lengths) < 2:
            return 0.0

        mean = sum(lengths) / len(lengths)
        variance = sum((l - mean) ** 2 for l in lengths) / len(lengths)
        std_dev = variance ** 0.5

        # 标准差越小，风格越一致
        # 正常网文句长标准差在 5-15 之间
        deviation = abs(std_dev - 10) / 10 * 100
        return min(deviation, 100.0)

    def _evaluate_info_noise(self, text: str) -> float:
        """评估信息噪音"""
        # 检测说明性语句
        explanatory_patterns = [
            r"这是因为",
            r"原因在于",
            r"也就是说",
            r"换句话说",
            r"简单来说",
            r"可以说",
            r"实际上",
            r"事实上",
        ]

        noise_count = 0
        for pattern in explanatory_patterns:
            noise_count += len(re.findall(pattern, text))

        # 归一化
        sentences = len(re.findall(r'[。！？]', text))
        if sentences == 0:
            return 0.0

        return min((noise_count / sentences) * 100, 100.0)

    def _evaluate_exposition_ratio(self, text: str) -> float:
        """评估说明腔比例"""
        # 检测大段说明性文字
        exposition_markers = [
            r"所谓的",
            r"原来如此",
            r"也就是",
            r"顾名思义",
        ]

        total_chars = len(re.findall(r'[\u4e00-\u9fa5]', text))
        if total_chars == 0:
            return 0.0

        exposition_chars = 0
        for pattern in exposition_markers:
            matches = re.findall(pattern, text)
            exposition_chars += sum(len(m) for m in matches)

        return min((exposition_chars / total_chars) * 1000, 100.0)

    def _evaluate_character_drift(self, text: str) -> float:
        """评估角色声音漂移"""
        # 简化实现：检测对话标签多样性
        dialogue_tags = re.findall(r'[\u4e00-\u9fa5]{1,4}道[：:]', text)
        unique_tags = len(set(dialogue_tags))

        # 对话标签太少说明角色声音单一
        if len(dialogue_tags) == 0:
            return 50.0  # 中等分数

        diversity = unique_tags / len(dialogue_tags)
        # 理想的多样性在 0.3-0.7 之间
        drift = abs(diversity - 0.5) * 100
        return min(drift, 100.0)

    def _evaluate_scene_completion(self, text: str, scene_type: str) -> float:
        """评估场景完成度"""
        score = 50.0  # 基础分

        # 检查基本场景元素
        if scene_type == "combat":
            # 战斗场景需要动作描写
            if any(w in text for w in ["出手", "攻击", "战斗", "对决"]):
                score += 15
            if any(w in text for w in ["倒下", "击退", "胜利"]):
                score += 15
        elif scene_type == "breakthrough":
            # 突破场景需要升级结果
            if any(w in text for w in ["突破", "晋升", "提升"]):
                score += 15
            if any(w in text for w in ["力量", "实力", "境界"]):
                score += 15
        elif scene_type == "romance":
            # 感情场景需要情感描写
            if any(w in text for w in ["心动", "脸红", "眼神"]):
                score += 15
            if any(w in text for w in ["心跳", "紧张"]):
                score += 15
        elif scene_type == "cliffhanger":
            # 悬念场景需要钩子
            if "？" in text or "！" in text:
                score += 20
            if any(w in text for w in ["突然", "就在", "悬念"]):
                score += 10

        return min(score, 100.0)

    def _evaluate_show_dont_tell(self, text: str) -> float:
        """评估 Show don't tell"""
        # 检测 tell 模式
        tell_patterns = [
            r"感到.*?很",
            r"觉得.*?非常",
            r"她是.*?人",
            r"他是.*?人",
        ]

        sentences = len(re.findall(r'[。！？]', text))
        if sentences == 0:
            return 50.0

        tell_count = 0
        for pattern in tell_patterns:
            tell_count += len(re.findall(pattern, text))

        # show_dont_tell 比率
        ratio = (sentences - tell_count) / sentences
        return min(ratio * 100, 100.0)

    def _evaluate_dialogue_naturalness(self, text: str) -> float:
        """评估对话自然度"""
        # 检测对话的自然性
        dialogue_count = len(re.findall(r'["""\'\']', text))
        if dialogue_count < 4:
            return 40.0  # 对话太少

        # 检测对话标签多样性
        tags = re.findall(r'道[：:]', text)
        unique_tags = len(set(tags)) if tags else 0

        # 理想对话标签多样性
        if unique_tags < 3:
            return 50.0
        elif unique_tags < 5:
            return 70.0
        else:
            return 85.0

    def _evaluate_emotion_consistency(self, text: str) -> float:
        """评估情感一致性"""
        # 简化实现：检测情感词的连贯性
        emotion_words = {
            "positive": ["开心", "高兴", "兴奋", "激动", "感动", "温暖", "幸福"],
            "negative": ["悲伤", "痛苦", "愤怒", "恐惧", "绝望", "沮丧"],
            "neutral": ["平静", "淡然", "冷静"],
        }

        pos_count = sum(text.count(w) for w in emotion_words["positive"])
        neg_count = sum(text.count(w) for w in emotion_words["negative"])

        total = pos_count + neg_count
        if total == 0:
            return 60.0  # 没有明显情感倾向

        # 情感应该有一定倾向性
        ratio = abs(pos_count - neg_count) / total
        return min(ratio * 100, 100.0)

    def _evaluate_emotional_engagement(self, text: str) -> float:
        """评估情感投入度"""
        # 检测情感描写的丰富度
        emotional_markers = [
            "心跳", "屏息", "紧张", "激动",
            "眼眶", "泪水", "颤抖", "握紧",
            "深吸", "低吼", "怒吼", "微笑",
        ]

        count = sum(text.count(w) for w in emotional_markers)
        sentences = len(re.findall(r'[。！？]', text))

        if sentences == 0:
            return 40.0

        density = count / sentences * 10
        return min(density * 20, 100.0)

    def _calculate_critic_score(self, metrics: EvaluationMetrics) -> float:
        """计算 Critic 综合分数（简化版）"""
        # 权重
        weights = {
            "ai_density": -0.25,  # AI腔越少越好
            "style_deviation": -0.15,  # 风格偏差越小越好
            "info_noise_ratio": -0.15,  # 信息噪音越少越好
            "exposition_ratio": -0.10,  # 说明腔越少越好
            "scene_completion": 0.20,  # 场景完成度越高越好
            "show_dont_tell_ratio": 0.15,  # Show don't tell 越多越好
        }

        score = 70.0  # 基础分

        score += weights["ai_density"] * (metrics.ai_density - 5)
        score += weights["style_deviation"] * (metrics.style_deviation - 20)
        score += weights["info_noise_ratio"] * (metrics.info_noise_ratio - 10)
        score += weights["exposition_ratio"] * (metrics.exposition_ratio - 5)
        score += weights["scene_completion"] * (metrics.scene_completion - 70)
        score += weights["show_dont_tell_ratio"] * (metrics.show_dont_tell_ratio - 60)

        return min(max(score, 0.0), 100.0)


# ============================================================================
# 评估运行器
# ============================================================================

class EvaluationRunner:
    """评估运行器"""

    def __init__(
        self,
        workspace_path: str,
        evaluator: QualityEvaluator,
        input_dirs: Optional[dict[str, Path]] = None
    ):
        self.workspace_path = Path(workspace_path)
        self.evaluator = evaluator
        # 对比评估时 explicit input_dirs；单模式评估时为空（从默认位置读取）
        self.input_dirs: dict[str, Path] = input_dirs or {}
        # 标记是否为对比评估模式（有明确的 A/B/C 目录）
        self.is_contrastive_mode = len(self.input_dirs) >= 3

    def _get_chapter_path(self, mode: str, chapter_num: int) -> Path:
        """获取章节文件路径

        对比评估模式（提供了 A/B/C 三组目录）：
            必须从对应目录读取，缺失直接报错
        单模式评估（无 input_dirs）：
            从 workspace/chapters/ 默认位置读取
        """
        chapter_file_name = f"chapter_{chapter_num:03d}.txt"

        if mode in self.input_dirs:
            # 对比评估：明确指定了目录，必须从该目录读取
            input_dir = self.input_dirs[mode]
            chapter_file = input_dir / chapter_file_name
            if chapter_file.exists():
                return chapter_file
            raise FileNotFoundError(
                f"[{mode}组] 章节文件不存在: {chapter_file}\n"
                f"请确认 --input-{mode.lower()} 目录包含章节文件 {chapter_file_name}"
            )

        # 单模式评估：从默认位置读取
        chapter_file = self.workspace_path / "chapters" / chapter_file_name
        if chapter_file.exists():
            return chapter_file
        raise FileNotFoundError(f"章节文件不存在: {chapter_file}")

    def run_single(self, mode: str, chapter_num: int) -> EvaluationResult:
        """运行单次评估"""
        start_time = time.time()
        errors = []
        warnings = []

        try:
            # 获取章节文件路径
            chapter_file = self._get_chapter_path(mode, chapter_num)

            with open(chapter_file, 'r', encoding='utf-8') as f:
                text = f.read()

            # 推断场景类型（从文件名或内容）
            scene_type = self._infer_scene_type(chapter_file)

            # 评估
            metrics = self.evaluator.evaluate(text, scene_type)

            return EvaluationResult(
                mode=mode,
                chapter_num=chapter_num,
                scene_type=scene_type,
                metrics=metrics,
                raw_text=text[:500],  # 只保留前500字
                evaluation_time_ms=int((time.time() - start_time) * 1000),
            )

        except FileNotFoundError as e:
            errors.append(str(e))
            return EvaluationResult(
                mode=mode,
                chapter_num=chapter_num,
                scene_type="unknown",
                metrics=EvaluationMetrics(),
                raw_text="",
                evaluation_time_ms=int((time.time() - start_time) * 1000),
                errors=errors,
            )
        except Exception as e:
            errors.append(str(e))
            return EvaluationResult(
                mode=mode,
                chapter_num=chapter_num,
                scene_type="unknown",
                metrics=EvaluationMetrics(),
                raw_text="",
                evaluation_time_ms=int((time.time() - start_time) * 1000),
                errors=errors,
            )

    def _infer_scene_type(self, chapter_file: Path) -> str:
        """从文件名推断场景类型"""
        filename = chapter_file.stem.lower()

        if "combat" in filename or "战斗" in filename:
            return "combat"
        elif "breakthrough" in filename or "突破" in filename:
            return "breakthrough"
        elif "romance" in filename or "感情" in filename:
            return "romance"
        elif "cliffhanger" in filename or "悬念" in filename:
            return "cliffhanger"
        elif "sacrifice" in filename or "牺牲" in filename:
            return "sacrifice"

        return "general"

    def run_comparison(
        self,
        modes: list,
        chapter_nums: list,
        output_dir: Optional[Path] = None
    ) -> ComparisonReport:
        """运行对比评估"""
        results = {mode: [] for mode in modes}

        for chapter_num in chapter_nums:
            for mode in modes:
                print(f"  [{mode}] 评估第 {chapter_num} 章...")
                result = self.run_single(mode, chapter_num)
                results[mode].append(result)

                if result.errors:
                    print(f"    错误: {result.errors}")
                else:
                    print(f"    Critic分数: {result.metrics.critic_score:.1f}")
                    print(f"    AI腔密度: {result.metrics.ai_density:.1f}")

        # 生成报告
        report = ComparisonReport(
            timestamp=datetime.now().isoformat(),
            workspace=str(self.workspace_path),
            chapters_tested=chapter_nums,
            results=results,
        )

        # 保存报告
        if output_dir:
            output_dir.mkdir(parents=True, exist_ok=True)
            report_file = output_dir / f"comparison_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            with open(report_file, 'w', encoding='utf-8') as f:
                json.dump(report.to_dict(), f, ensure_ascii=False, indent=2)
            print(f"\n报告已保存: {report_file}")

        # 打印摘要
        self._print_summary(report)

        return report

    def _print_summary(self, report: ComparisonReport):
        """打印摘要"""
        print("\n" + "=" * 60)
        print("评估摘要")
        print("=" * 60)

        summary = report._generate_summary()
        modes = sorted(summary.keys())

        # 打印表头
        print(f"\n{'模式':<8} {'Critic':<10} {'AI腔':<10} {'风格偏差':<10} {'场景完成':<10} {'综合分':<10}")
        print("-" * 60)

        # 打印各模式结果
        for mode in modes:
            data = summary[mode]
            m = data["avg_metrics"]
            print(
                f"{mode:<8} "
                f"{m['critic_score']:<10.1f} "
                f"{m['ai_density']:<10.1f} "
                f"{m['style_deviation']:<10.1f} "
                f"{m['scene_completion']:<10.1f} "
                f"{data['overall_score']:<10.1f}"
            )

        print("-" * 60)

        # 判断最优模式
        if len(modes) >= 2:
            best_mode = max(modes, key=lambda m: summary[m]["overall_score"])
            print(f"\n最优模式: {best_mode} (综合分: {summary[best_mode]['overall_score']:.1f})")

            # 准入判断（仅在真正有 A/B/C 三组对比数据时）
            if "C" in modes and "B" in modes and "A" in modes:
                c_score = summary["C"]["overall_score"]
                b_score = summary["B"]["overall_score"]
                a_score = summary["A"]["overall_score"]

                print(f"\n--- Runtime 检索增强准入评估 ---")
                print(f"A组 (无增强): {a_score:.1f}")
                print(f"B组 (轻量知识库): {b_score:.1f}")
                print(f"C组 (Runtime检索增强): {c_score:.1f}")

                if c_score > b_score + 3:  # 超过3分才启用
                    print(f"\n✓ Runtime 检索增强已满足准入条件 (C={c_score:.1f} > B={b_score:.1f} + 3)")
                    print("  建议: 在 manifest.json 中设置 approved: true 启用运行时检索")
                else:
                    print(f"\n✗ Runtime 检索增强未满足准入条件 (C={c_score:.1f} <= B={b_score:.1f} + 3)")
                    print("  建议: 保持 manifest.json 中 approved: false 或不创建 manifest.json")
            elif "C" in modes and "B" in modes:
                # 只有 B 和 C 的对比
                c_score = summary["C"]["overall_score"]
                b_score = summary["B"]["overall_score"]
                print(f"\n--- Runtime 检索增强准入评估（缺少 A 组对照组）---")
                print(f"B组 (轻量知识库): {b_score:.1f}")
                print(f"C组 (Runtime检索增强): {c_score:.1f}")
                if c_score > b_score + 3:
                    print(f"\n✓ Runtime 检索增强相对 B 组更优 (C={c_score:.1f} > B={b_score:.1f} + 3)")
                else:
                    print(f"\n✗ Runtime 检索增强未显著优于轻量知识库")
                    print("  建议: 增加 A 组对照组进行完整评估")


# ============================================================================
# 主程序
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="PiNovelStudio 知识库质量评估",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    # 从不同目录读取 A/B/C 三组章节进行对比评估
    python evaluate-knowledge-context.py \\
        --workspace workspaces/test-novel \\
        --input-a chapters/control/ \\
        --input-b chapters/light/ \\
        --input-c chapters/runtime/ \\
        --chapters 5

    # 单模式评估（从默认位置读取章节文件）
    python evaluate-knowledge-context.py --workspace workspaces/test-novel --mode A --chapter 5

    # 指定输出目录
    python evaluate-knowledge-context.py --workspace workspaces/test-novel --output results/

前置条件说明:
    要进行真正的 A/B/C 对比，需要先生成三组章节文件：
    - A 组：关闭所有知识库增强（无 Prompt 注入）
    - B 组：只启用轻量知识库
    - C 组：启用轻量 + Runtime 检索增强（需 manifest.json approved: true）

    可以使用 novel_generate_chapter 工具并配置不同增强级别来生成各组章节。
        """
    )

    parser.add_argument("--workspace", "-w", required=True, help="工作区路径")
    parser.add_argument("--mode", "-m", choices=["A", "B", "C"], help="评估模式 (默认: A, B, C)")
    parser.add_argument("--chapters", "-c", type=int, default=1, help="评估章节数 (默认: 1)")
    parser.add_argument("--chapter", "-n", type=int, help="指定章节号 (与 --chapters 互斥)")
    parser.add_argument("--output", "-o", help="输出目录")
    parser.add_argument("--target-words", "-t", type=int, default=3000, help="目标字数 (默认: 3000)")

    # A/B/C 三组章节的输入目录
    parser.add_argument("--input-a", help="A组章节目录（无增强）【对比评估必填】")
    parser.add_argument("--input-b", help="B组章节目录（轻量知识库）【对比评估必填】")
    parser.add_argument("--input-c", help="C组章节目录（Runtime检索增强）【对比评估必填】")

    args = parser.parse_args()

    workspace = Path(args.workspace)
    if not workspace.exists():
        print(f"错误: 工作区不存在: {workspace}")
        return 1

    # 构建输入目录映射
    input_dirs = {}
    provided_dirs = []

    if args.input_a:
        path_a = Path(args.input_a)
        if not path_a.exists():
            print(f"错误: A组目录不存在: {path_a}")
            return 1
        input_dirs["A"] = path_a
        provided_dirs.append("A")
    if args.input_b:
        path_b = Path(args.input_b)
        if not path_b.exists():
            print(f"错误: B组目录不存在: {path_b}")
            return 1
        input_dirs["B"] = path_b
        provided_dirs.append("B")
    if args.input_c:
        path_c = Path(args.input_c)
        if not path_c.exists():
            print(f"错误: C组目录不存在: {path_c}")
            return 1
        input_dirs["C"] = path_c
        provided_dirs.append("C")

    # 确定评估模式
    if args.mode:
        # 单模式评估：允许只指定一个目录或从默认位置读取
        modes = [args.mode]
    else:
        # 对比评估（A/B/C 三组）：必须同时提供全部三个输入目录
        required = {"A", "B", "C"}
        provided = set(provided_dirs)
        missing = required - provided
        if missing:
            print("错误: 对比评估（A/B/C 三组）必须同时提供 --input-a、--input-b、--input-c 三个目录")
            print(f"  缺少: {', '.join(sorted(missing))}")
            print()
            print("示例:")
            print("  python evaluate-knowledge-context.py \\")
            print("    --workspace workspaces/test-novel \\")
            print("    --input-a chapters/control/ \\")
            print("    --input-b chapters/light/ \\")
            print("    --input-c chapters/runtime/ \\")
            print("    --chapters 5")
            print()
            print("单模式评估（不需要 --input-*）:")
            print("  python evaluate-knowledge-context.py --workspace workspaces/test-novel --mode A --chapter 5")
            return 1
        modes = ["A", "B", "C"]

    # 确定评估章节
    if args.chapter is not None:
        chapters = [args.chapter]
    else:
        chapters = list(range(1, args.chapters + 1))

    # 创建评估器
    evaluator = QualityEvaluator(target_word_count=args.target_words)
    runner = EvaluationRunner(str(workspace), evaluator, input_dirs if input_dirs else None)

    # 运行评估
    print(f"评估工作区: {workspace}")
    print(f"评估模式: {modes}")
    print(f"评估章节: {chapters}")
    if input_dirs:
        print(f"A/B/C 输入目录: {input_dirs}")
    print()

    report = runner.run_comparison(
        modes=modes,
        chapter_nums=chapters,
        output_dir=Path(args.output) if args.output else None,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
