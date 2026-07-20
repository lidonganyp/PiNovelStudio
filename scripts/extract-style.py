"""
PiNovelStudio — Layer 1: 风格指纹提取脚本

从网文作品中提取定量风格指纹，包括：
- 句式特征 (sentence)
- 词汇特征 (lexicon)
- 叙事特征 (narrative)
- 情绪特征 (emotion)
- 意象特征 (imagery)
- 节奏特征 (rhythm)

用法：
    python extract-style.py --input corpus/clean/盘龙.json --output data/styles/panlong.json
    python extract-style.py --input corpus/clean/ --output data/styles/ --batch
"""

import argparse
import json
import re
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional
import statistics


# ============================================================================
# 数据结构定义
# ============================================================================

@dataclass
class StyleFingerprint:
    name: str
    source_file: str
    extraction_date: str = ""
    reference_works: list = field(default_factory=list)

    # 句式特征
    sentence_avg_length: float = 18.0
    sentence_length_variance: float = 5.0
    sentence_short_bursts_context: str = "战斗/紧张"
    sentence_long_flows_context: str = "环境/内心"
    sentence_fragment_ratio: float = 0.1
    sentence_comma_density: float = 50.0
    sentence_exclamation_density: float = 3.0
    sentence_ellipsis_density: float = 1.0
    sentence_signature_patterns: list = field(default_factory=list)

    # 词汇特征
    lexicon_richness: float = 0.6
    lexicon_idiom_density: float = 5.0
    lexicon_colloquial_ratio: float = 0.2
    lexicon_adverb_density: float = 3.0
    lexicon_specialized_terms: list = field(default_factory=list)
    lexicon_forbidden_words: list = field(default_factory=list)
    lexicon_preferred_transitions: list = field(default_factory=list)

    # 叙事特征
    narrative_pov_style: str = "第三人称"
    narrative_pov_switch_freq: float = 0.0
    narrative_inner_monologue_ratio: float = 0.2
    narrative_show_tell_ratio: float = 0.7
    narrative_dialogue_ratio: float = 0.35
    narrative_fight_ratio: float = 0.2
    narrative_info_dump_strategy: str = "自然融入"
    narrative_chapter_end_pattern: str = "悬念"
    narrative_humor_style: str = "轻松"

    # 情绪特征
    emotion_primary_types: list = field(default_factory=list)
    emotion_satisfaction_interval: int = 4000
    emotion_oppression_max: int = 3000
    emotion_tension_wave_period: int = 2000
    emotion_climax_pattern: str = "燃→爽"
    emotion_cliffhanger_type: str = "悬念"

    # 意象特征
    imagery_color_palette: list = field(default_factory=list)
    imagery_power_visualization: str = "光效"
    imagery_environment_style: str = "简洁"
    imagery_fight_choreography: str = "动态"
    imagery_metaphor_source: list = field(default_factory=list)
    imagery_sensory_emphasis: list = field(default_factory=list)

    # 节奏特征
    rhythm_paragraph_avg: float = 150.0
    rhythm_paragraph_variance: float = 50.0
    rhythm_scene_avg: float = 500.0
    rhythm_scene_variance: float = 200.0
    rhythm_action_pace: str = "快"
    rhythm_dialogue_pace: str = "中"
    rhythm_description_pace: str = "慢"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "StyleFingerprint":
        return cls(**data)


# ============================================================================
# 分析引擎
# ============================================================================

class StyleAnalyzer:
    """风格指纹分析引擎"""

    # 常见成语列表（简化版）
    COMMON_IDIOMS = [
        "栩栩如生", "津津有味", "息息相关", "当仁不让", "见微知著",
        "举世瞩目", "引人入胜", "出神入化", "一蹴而就", "毋庸置疑",
        "毋庸置疑", "势如破竹", "如雷贯耳", "心驰神往", "魂牵梦萦",
        "刻骨铭心", "惊心动魄", "势不可挡", "所向披靡", "一往无前",
        "意气风发", "斗志昂扬", "气吞山河", "威风凛凛", "所向无敌",
        "披荆斩棘", "乘风破浪", "天翻地覆", "惊天动地", "叹为观止",
        "瞠目结舌", "难以置信", "不可思议", "匪夷所思", "出类拔萃",
        "独树一帜", "别具一格", "独具匠心", "匠心独运", "标新立异",
        "口若悬河", "滔滔不绝", "侃侃而谈", "妙语连珠", "字字珠玑",
    ]

    # 常见程度副词
    ADVERB_LIST = [
        "非常", "十分", "极其", "格外", "分外", "相当", "特别", "尤其",
        "极其", "最", "更", "越发", "愈加", "越来越", "越来越",
        "太", "真", "实在", "确实", "的确", "委实",
    ]

    # 禁止词汇（AI腔常见词）
    FORBIDDEN_WORDS = [
        "非常", "十分", "极其", "格外", "分外",  # 弱程度修饰
        "首先", "其次", "最后",  # 模板化递进
        "这意味着",  # 过度解释
        "一方面", "另一方面",  # 二元对立
        "总之",  # 教科书总结
        "仿佛", "一般", "似的",  # 滥用比喻
        "不知为何",  # 偷懒神秘
        "一股", "的气息",  # 万能描写
    ]

    def __init__(self, text: str, min_analysis_chars: int = 50000):
        self.text = text
        self.min_analysis_chars = min_analysis_chars
        self.chinese_chars = re.findall(r'[\u4e00-\u9fa5]', text)
        self.all_text = text

        if len(self.chinese_chars) < min_analysis_chars:
            print(f"警告: 文本仅 {len(self.chinese_chars)} 字，建议 ≥{min_analysis_chars} 字以获得准确结果")

    def analyze(self) -> StyleFingerprint:
        """执行完整分析"""
        print("开始风格分析...")

        # 1. 句式分析
        print("  [1/6] 分析句式特征...")
        sentence_features = self._analyze_sentences()

        # 2. 词汇分析
        print("  [2/6] 分析词汇特征...")
        lexicon_features = self._analyze_lexicon()

        # 3. 叙事分析
        print("  [3/6] 分析叙事特征...")
        narrative_features = self._analyze_narrative()

        # 4. 情绪分析
        print("  [4/6] 分析情绪特征...")
        emotion_features = self._analyze_emotion()

        # 5. 意象分析
        print("  [5/6] 分析意象特征...")
        imagery_features = self._analyze_imagery()

        # 6. 节奏分析
        print("  [6/6] 分析节奏特征...")
        rhythm_features = self._analyze_rhythm()

        # 合并所有特征
        return StyleFingerprint(
            name="",
            source_file="",
            extraction_date="",
            reference_works=[],
            **sentence_features,
            **lexicon_features,
            **narrative_features,
            **emotion_features,
            **imagery_features,
            **rhythm_features,
        )

    def _analyze_sentences(self) -> dict:
        """分析句式特征"""
        # 分割句子
        sentences = re.split(r'[。！？；\n]', self.all_text)
        sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 2]

        if not sentences:
            return self._default_sentence_features()

        # 句长统计
        lengths = [len(re.findall(r'[\u4e00-\u9fa5]', s)) for s in sentences]

        avg_length = statistics.mean(lengths) if lengths else 18.0
        variance = statistics.stdev(lengths) if len(lengths) > 1 else 5.0

        # 标点密度
        total_chars = len(self.all_text)
        comma_count = self.all_text.count('，') + self.all_text.count('、')
        exclamation_count = self.all_text.count('！') + self.all_text.count('!')
        ellipsis_count = self.all_text.count('……') + self.all_text.count('...')

        comma_density = (comma_count / total_chars * 1000) if total_chars > 0 else 50.0
        exclamation_density = (exclamation_count / total_chars * 1000) if total_chars > 0 else 3.0
        ellipsis_density = (ellipsis_count / total_chars * 1000) if total_chars > 0 else 1.0

        # 碎片句比例（短于5个汉字的句子）
        fragment_count = sum(1 for l in lengths if l < 5)
        fragment_ratio = fragment_count / len(lengths) if lengths else 0.1

        # 检测标志性句式
        signature_patterns = self._detect_signature_patterns(sentences)

        return {
            "sentence_avg_length": round(avg_length, 1),
            "sentence_length_variance": round(variance, 1),
            "sentence_fragment_ratio": round(fragment_ratio, 2),
            "sentence_comma_density": round(comma_density, 1),
            "sentence_exclamation_density": round(exclamation_density, 1),
            "sentence_ellipsis_density": round(ellipsis_density, 1),
            "sentence_signature_patterns": signature_patterns,
        }

    def _detect_signature_patterns(self, sentences: list) -> list:
        """检测标志性句式"""
        patterns = []
        text_sample = "".join(sentences[:1000])  # 取前1000句分析

        # 检测各种句式特征
        if "！" in text_sample:
            patterns.append("感叹句频繁")
        if "？" in text_sample:
            patterns.append("疑问句频繁")
        if "——" in text_sample or "—" in text_sample:
            patterns.append("破折号使用")

        # 检测"XXX道"式对话
        dialogue_pattern = re.findall(r'[\u4e00-\u9fa5]{1,5}道[：:"]', text_sample)
        if len(dialogue_pattern) > len(sentences) * 0.1:
            patterns.append("对话标签'XX道'")

        # 检测内心独白模式
        inner_patterns = [
            r'心中想',
            r'暗道',
            r'寻思',
            r'想到',
            r'在心中',
            r'念头',
        ]
        inner_count = sum(len(re.findall(p, text_sample)) for p in inner_patterns)
        if inner_count > 5:
            patterns.append("内心独白模式")

        # 检测战斗描写模式
        fight_patterns = [
            r'爆发',
            r'轰出',
            r'斩杀',
            r'一击',
            r'光芒',
            r'爆炸',
        ]
        fight_count = sum(len(re.findall(p, text_sample)) for p in fight_patterns)
        if fight_count > 10:
            patterns.append("战斗光效描写")

        return patterns

    def _analyze_lexicon(self) -> dict:
        """分析词汇特征"""
        total_chars = len(self.chinese_chars)
        total_text = "".join(self.chinese_chars)

        if total_chars == 0:
            return self._default_lexicon_features()

        # 词汇丰富度
        unique_chars = set(self.chinese_chars)
        richness = len(unique_chars) / total_chars if total_chars > 0 else 0.6

        # 成语密度
        idiom_count = sum(1 for idiom in self.COMMON_IDIOMS if idiom in total_text)
        idiom_density = (idiom_count / total_chars * 1000) if total_chars > 0 else 5.0

        # 口语化比例（感叹词、语气词）
        colloquial_markers = ['啊', '呀', '吧', '呢', '嘛', '哦', '哈', '嗯', '噢']
        colloquial_count = sum(total_text.count(m) for m in colloquial_markers)
        colloquial_ratio = min(colloquial_count / total_chars * 10, 0.5) if total_chars > 0 else 0.2

        # 程度副词密度
        adverb_count = sum(total_text.count(adv) for adv in self.ADVERB_LIST)
        adverb_density = (adverb_count / total_chars * 1000) if total_chars > 0 else 3.0

        # 提取专业术语（重复出现3次以上的2-4字词）
        words = re.findall(r'[\u4e00-\u9fa5]{2,4}', total_text)
        word_freq = {}
        for w in words:
            word_freq[w] = word_freq.get(w, 0) + 1
        specialized_terms = [w for w, c in word_freq.items() if c >= 3 and len(w) >= 2][:20]

        return {
            "lexicon_richness": round(richness, 3),
            "lexicon_idiom_density": round(idiom_density, 1),
            "lexicon_colloquial_ratio": round(colloquial_ratio, 2),
            "lexicon_adverb_density": round(adverb_density, 1),
            "lexicon_specialized_terms": specialized_terms,
            "lexicon_forbidden_words": self.FORBIDDEN_WORDS,
        }

    def _analyze_narrative(self) -> dict:
        """分析叙事特征"""
        text_sample = self.all_text[:min(len(self.all_text), 100000)]

        # 检测POV风格
        first_person_markers = ['我', '我的', '我自己']
        third_person_markers = ['他', '她', '他们', '主角', '男主', '女主']

        first_count = sum(text_sample.count(m) for m in first_person_markers)
        third_count = sum(text_sample.count(m) for m in third_person_markers)

        pov_style = "第一人称" if first_count > third_count * 2 else "第三人称"

        # 检测对话比例
        dialogue_chars = len(re.findall(r'["""\'\'].*?["""\'\']', text_sample))
        dialogue_ratio = dialogue_chars / len(text_sample) if text_sample else 0.35

        # 检测内心独白
        inner_markers = ['心想', '心中', '暗道', '想道', '暗想', '思忖', '念头']
        inner_count = sum(len(re.findall(m, text_sample)) for m in inner_markers)
        inner_ratio = min(inner_count / 100, 0.5) if len(text_sample) > 0 else 0.2

        # 检测战斗描写
        fight_markers = ['战斗', '出手', '爆发', '轰出', '斩杀', '击退', '对决']
        fight_count = sum(text_sample.count(m) for m in fight_markers)
        fight_ratio = min(fight_count / 50, 0.4) if len(text_sample) > 0 else 0.2

        # 检测Show vs Tell（动作/对话 vs 叙述/解释）
        show_markers = ['看着', '听着', '转身', '抬手', '笑了', '说道', '喊道']
        tell_markers = ['感到', '觉得', '知道', '明白', '理解', '认为']
        show_count = sum(text_sample.count(m) for m in show_markers)
        tell_count = sum(text_sample.count(m) for m in tell_markers)
        show_tell_ratio = show_count / (show_count + tell_count + 1)

        # 检测章节结尾模式
        chapter_end = self.all_text[-500:] if len(self.all_text) > 500 else self.all_text
        end_pattern = "悬念" if "？" in chapter_end or "！" in chapter_end or "..." in chapter_end else "平铺"

        return {
            "narrative_pov_style": pov_style,
            "narrative_pov_switch_freq": 0.0,  # 需要多章节对比
            "narrative_inner_monologue_ratio": round(inner_ratio, 2),
            "narrative_show_tell_ratio": round(show_tell_ratio, 2),
            "narrative_dialogue_ratio": round(dialogue_ratio, 2),
            "narrative_fight_ratio": round(fight_ratio, 2),
            "narrative_chapter_end_pattern": end_pattern,
        }

    def _analyze_emotion(self) -> dict:
        """分析情绪特征"""
        text_sample = self.all_text[:min(len(self.all_text), 100000)]

        # 情绪词统计
        emotion_words = {
            "燃": ["热血", "激情", "斗志", "燃烧", "昂扬"],
            "爽": ["痛快", "舒爽", "过瘾", "爽感", "愉悦"],
            "紧张": ["紧张", "心跳", "屏息", "捏汗", "危机"],
            "压抑": ["压抑", "沉闷", "阴郁", "沮丧", "绝望"],
            "感动": ["感动", "流泪", "心酸", "温暖", "温情"],
            "愤怒": ["愤怒", "暴怒", "气愤", "恼火", "火大"],
        }

        emotion_counts = {}
        for emotion, words in emotion_words.items():
            count = sum(text_sample.count(w) for w in words)
            emotion_counts[emotion] = count

        # 找出主要情绪类型
        sorted_emotions = sorted(emotion_counts.items(), key=lambda x: x[1], reverse=True)
        primary_emotions = [e[0] for e in sorted_emotions[:3] if e[1] > 0]

        # 爽点间隔（基于"爽"类词汇出现频率估算）
        satisfaction_count = emotion_counts.get("爽", 0) + emotion_counts.get("燃", 0)
        if satisfaction_count > 0:
            estimated_interval = len(text_sample) / satisfaction_count
        else:
            estimated_interval = 4000

        return {
            "emotion_primary_types": primary_emotions if primary_emotions else ["燃", "爽"],
            "emotion_satisfaction_interval": min(int(estimated_interval), 10000),
            "emotion_tension_wave_period": 2000,  # 估算值
        }

    def _analyze_imagery(self) -> dict:
        """分析意象特征"""
        text_sample = self.all_text[:min(len(self.all_text), 100000)]

        # 色彩词统计
        color_words = {
            "血红": ["血红", "殷红", "赤红"],
            "金黄": ["金黄", "金色", "金光"],
            "墨黑": ["墨黑", "漆黑", "黑暗"],
            "银白": ["银白", "银光", "雪白"],
            "湛蓝": ["湛蓝", "蔚蓝", "天蓝"],
        }

        detected_colors = []
        for color, words in color_words.items():
            if any(w in text_sample for w in words):
                detected_colors.append(color)

        # 力量视觉化风格
        power_keywords = {
            "光效": ["光芒", "金光", "光晕", "光辉", "闪光"],
            "气息": ["气息", "气场", "气势", "威压"],
            "意象": ["大道", "法则", "法则之力"],
            "物理": ["爆炸", "冲击波", "碎裂", "崩碎"],
        }

        power_style = "光效"  # 默认
        max_count = 0
        for style, keywords in power_keywords.items():
            count = sum(text_sample.count(k) for k in keywords)
            if count > max_count:
                max_count = count
                power_style = style

        # 感官侧重
        sensory_keywords = {
            "视觉": ["看见", "看到", "视线", "目光", "眼睛"],
            "听觉": ["听到", "听见", "声音", "声响", "轰鸣"],
            "触觉": ["感到", "感觉", "触感", "灼热", "冰凉"],
            "嗅觉": ["闻到", "气味", "芬芳", "腥臭"],
        }

        sensory_emphasis = []
        for sense, keywords in sensory_keywords.items():
            if sum(text_sample.count(k) for k in keywords) > 5:
                sensory_emphasis.append(sense)

        return {
            "imagery_color_palette": detected_colors,
            "imagery_power_visualization": power_style,
            "imagery_sensory_emphasis": sensory_emphasis if sensory_emphasis else ["视觉", "听觉"],
        }

    def _analyze_rhythm(self) -> dict:
        """分析节奏特征"""
        # 段落分析
        paragraphs = [p.strip() for p in self.all_text.split('\n\n') if p.strip()]
        paragraph_lengths = [len(re.findall(r'[\u4e00-\u9fa5]', p)) for p in paragraphs]

        if paragraph_lengths:
            avg_paragraph = statistics.mean(paragraph_lengths)
            var_paragraph = statistics.stdev(paragraph_lengths) if len(paragraph_lengths) > 1 else 50.0
        else:
            avg_paragraph = 150.0
            var_paragraph = 50.0

        # 检测节奏类型
        short_para_ratio = sum(1 for l in paragraph_lengths if l < 50) / len(paragraph_lengths) if paragraph_lengths else 0.2

        if short_para_ratio > 0.3:
            action_pace = "快"
            description_pace = "慢"
        else:
            action_pace = "中"
            description_pace = "中"

        return {
            "rhythm_paragraph_avg": round(avg_paragraph, 1),
            "rhythm_paragraph_variance": round(var_paragraph, 1),
            "rhythm_action_pace": action_pace,
            "rhythm_description_pace": description_pace,
        }

    def _default_sentence_features(self) -> dict:
        return {
            "sentence_avg_length": 18.0,
            "sentence_length_variance": 5.0,
            "sentence_fragment_ratio": 0.1,
            "sentence_comma_density": 50.0,
            "sentence_exclamation_density": 3.0,
            "sentence_ellipsis_density": 1.0,
            "sentence_signature_patterns": [],
        }

    def _default_lexicon_features(self) -> dict:
        return {
            "lexicon_richness": 0.6,
            "lexicon_idiom_density": 5.0,
            "lexicon_colloquial_ratio": 0.2,
            "lexicon_adverb_density": 3.0,
            "lexicon_specialized_terms": [],
            "lexicon_forbidden_words": self.FORBIDDEN_WORDS,
        }


# ============================================================================
# 主程序
# ============================================================================

def load_novel_json(file_path: str) -> tuple:
    """加载小说JSON文件"""
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data


def extract_fingerprint(analyzer: StyleAnalyzer, novel_info: dict) -> StyleFingerprint:
    """提取风格指纹"""
    fingerprint = analyzer.analyze()
    fingerprint.name = novel_info.get('title', 'unknown')
    fingerprint.source_file = novel_info.get('source', '')
    fingerprint.extraction_date = "2026-05-27"
    fingerprint.reference_works = [novel_info.get('title', '')]
    return fingerprint


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 风格指纹提取")
    parser.add_argument("--input", "-i", required=True, help="输入文件或目录")
    parser.add_argument("--output", "-o", required=True, help="输出文件或目录")
    parser.add_argument("--batch", "-b", action="store_true", help="批量处理目录")
    parser.add_argument("--min-chars", "-m", type=int, default=50000, help="最小分析字符数")
    args = parser.parse_args()

    output_path = Path(args.output)

    if args.batch:
        # 批量处理
        input_dir = Path(args.input)
        output_dir = output_path if output_path.is_dir() else output_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        json_files = list(input_dir.glob("*.json"))
        print(f"批量处理: {len(json_files)} 个文件")

        results = []
        for json_file in json_files:
            try:
                print(f"\n处理: {json_file.name}")
                novel_data = load_novel_json(str(json_file))

                # 合并所有章节文本
                all_text = "\n".join(ch.get('text', '') for ch in novel_data.get('chapters', []))

                analyzer = StyleAnalyzer(all_text, min_analysis_chars=args.min_chars)
                fingerprint = extract_fingerprint(analyzer, {
                    'title': novel_data.get('title', json_file.stem),
                    'author': novel_data.get('author', 'Unknown'),
                    'source': str(json_file)
                })

                # 保存指纹
                output_file = output_dir / f"{json_file.stem}.json"
                with open(output_file, 'w', encoding='utf-8') as f:
                    json.dump(fingerprint.to_dict(), f, ensure_ascii=False, indent=2)

                print(f"  -> 已保存: {output_file}")
                results.append({'file': str(json_file), 'status': 'success'})

            except Exception as e:
                print(f"  -> 错误: {e}")
                results.append({'file': str(json_file), 'status': 'error', 'error': str(e)})

        print(f"\n处理完成: {len([r for r in results if r['status'] == 'success'])}/{len(results)} 成功")

    else:
        # 单文件处理
        novel_data = load_novel_json(args.input)
        all_text = "\n".join(ch.get('text', '') for ch in novel_data.get('chapters', []))

        analyzer = StyleAnalyzer(all_text, min_analysis_chars=args.min_chars)
        fingerprint = extract_fingerprint(analyzer, {
            'title': novel_data.get('title', Path(args.input).stem),
            'author': novel_data.get('author', 'Unknown'),
            'source': args.input
        })

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(fingerprint.to_dict(), f, ensure_ascii=False, indent=2)

        print(f"\n风格指纹已保存到: {output_path}")
        print(f"主要特征: {fingerprint.emotion_primary_types}")
        print(f"POV风格: {fingerprint.narrative_pov_style}")


if __name__ == "__main__":
    main()
