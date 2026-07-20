"""
PiNovelStudio — Layer 2: 场景模式库提取脚本

从网文作品中提取12类核心场景的模式：
1. 突破升级
2. 装逼打脸
3. 战斗描写
4. 感情升温
5. 伏笔揭示
6. 设定解说
7. 日常过渡
8. 势力交锋
9. 悲情牺牲
10. 豪赌博弈
11. 团队集结
12. 章末悬念

用法：
    python extract-scenes.py --input corpus/clean/盘龙.json --output data/scenes/
    python extract-scenes.py --input corpus/clean/ --output data/scenes/ --batch
"""

import argparse
import json
import re
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional, Literal
from collections import defaultdict


# ============================================================================
# 场景类型定义
# ============================================================================

SCENE_TYPES = {
    "breakthrough": {
        "name": "突破升级",
        "keywords": [
            "突破", "晋升", "升级", "进阶", "提升", "蜕变",
            "功法", "境界", "修为", "实力", "力量", "觉醒",
            "冲击", "跨越", "顿悟", "领悟"
        ],
        "sub_keywords": {
            "阶段结构": ["初期", "中期", "后期", "圆满", "巅峰"],
            "情绪曲线": ["期待", "紧张", "压抑", "爆发", "爽感"],
            "技法偏好": ["光效描写", "数字量化", "旁观者反应"]
        }
    },
    "face_slapping": {
        "name": "装逼打脸",
        "keywords": [
            "打脸", "碾压", "不屑", "冷笑", "轻视", "嘲讽",
            "震惊", "目瞪口呆", "难以置信", "后悔", "惶恐",
            "啪啪打脸", "脸疼", "啪啪啪", "当场"
        ],
        "sub_keywords": {
            "反转节奏": ["轻视", "展示1", "不服", "展示2", "碾压"],
            "碾压方式": ["实力碾压", "技巧碾压", "身份碾压", "认知碾压"],
            "旁观者写法": ["倒吸冷气", "目瞪口呆", "议论纷纷"]
        }
    },
    "combat": {
        "name": "战斗描写",
        "keywords": [
            "战斗", "对决", "交手", "厮杀", "搏杀", "激战",
            "出手", "攻击", "防御", "闪避", "反击", "爆发",
            "轰", "斩", "杀", "战", "斗"
        ],
        "sub_keywords": {
            "编排风格": ["快节奏", "慢镜头", "策略型", "力量型"],
            "环境互动": ["尘土飞扬", "空间碎裂", "光芒大作"],
            "节奏控制": ["起承转合", "一波三折", "高潮迭起"]
        }
    },
    "romance": {
        "name": "感情升温",
        "keywords": [
            "心动", "暧昧", "脸红", "害羞", "眼神", "对视",
            "靠近", "牵手", "拥抱", "表白", "告白", "情愫",
            "喜欢", "爱慕", "心仪", "倾心", "情意"
        ],
        "sub_keywords": {
            "推进方式": ["日常相处", "危机共处", "英雄救美", "相互扶持"],
            "对话模式": ["欲言又止", "口是心非", "欲拒还迎"],
            "互动设计": ["小动作", "微表情", "心理描写"]
        }
    },
    "foreshadow_reveal": {
        "name": "伏笔揭示",
        "keywords": [
            "原来", "真相", "秘密", "揭露", "揭示", "揭开",
            "恍然", "恍然大悟", "明白了", "一切都说得通了",
            "谜底", "谜团", "阴谋", "真相大白"
        ],
        "sub_keywords": {
            "揭示节奏": ["渐进式", "突发式", "连环式"],
            "信息密度": ["单点揭示", "多点揭示", "全面揭示"],
            "多线回收": ["明线暗线", "首尾呼应", "伏笔呼应"]
        }
    },
    "world_setting": {
        "name": "设定解说",
        "keywords": [
            "这个世界", "所谓", "原来如此", "规则", "法则",
            "修炼", "功法", "宗门", "势力", "历史", "起源",
            "设定", "背景", "世界观", "体系"
        ],
        "sub_keywords": {
            "释放策略": ["自然融入", "对话透露", "回忆穿插", "旁白说明"],
            "趣味性": ["悬念式", "案例式", "对比式"],
            "与剧情融合": ["推动剧情", "解释冲突", "深化主题"]
        }
    },
    "daily_life": {
        "name": "日常过渡",
        "keywords": [
            "第二天", "清晨", "早上", "午后", "傍晚", "夜晚",
            "吃饭", "休息", "聊天", "散步", "日常",
            "回到", "离开", "准备", "收拾", "结束"
        ],
        "sub_keywords": {
            "松弛节奏": ["慢节奏", "轻松", "温馨", "日常"],
            "日常技法": ["对话", "心理", "动作", "细节"],
            "信息穿插": ["背景", "回忆", "伏笔", "设定"]
        }
    },
    "faction_conflict": {
        "name": "势力交锋",
        "keywords": [
            "宗门", "家族", "势力", "门派", "联盟", "公会",
            "高层", "长老", "掌门", "会面", "谈判", "博弈",
            "利益", "冲突", "争夺", "竞争", "对抗"
        ],
        "sub_keywords": {
            "多线编排": ["明线", "暗线", "伏线"],
            "势力态度": ["敌对", "中立", "友好", "复杂"],
            "博弈深度": ["利益博弈", "实力博弈", "智慧博弈"]
        }
    },
    "sacrifice": {
        "name": "悲情牺牲",
        "keywords": [
            "牺牲", "献祭", "倒下", "死亡", "离去", "诀别",
            "保护", "守护", "最后", "诀别", "悲壮",
            "伤痛", "泪水", "悲鸣", "怒吼"
        ],
        "sub_keywords": {
            "情感铺垫": ["回忆", "羁绊", "使命", "无奈"],
            "牺牲方式": ["自我牺牲", "被动牺牲", "救赎式"],
            "余波处理": ["悲痛", "愤怒", "崛起", "继承"]
        }
    },
    "gamble": {
        "name": "豪赌博弈",
        "keywords": [
            "赌", "博弈", "风险", "筹码", "压上", "赌注",
            "生死", "成败", "在此一举", "孤注一掷",
            "胜利", "失败", "翻盘", "逆转"
        ],
        "sub_keywords": {
            "风险评估": ["高风险", "低风险", "对赌"],
            "决策逻辑": ["理性", "感性", "无奈", "信念"],
            "结果冲击": ["大胜", "惨胜", "惜败", "逆转胜"]
        }
    },
    "team_gathering": {
        "name": "团队集结",
        "keywords": [
            "集结", "召集", "组队", "团队", "伙伴", "同伴",
            "战友", "兄弟", "姐妹", "联手", "合作",
            "汇聚", "聚集", "一起", "共同"
        ],
        "sub_keywords": {
            "角色调度": ["主角", "配角", "反派", "辅助"],
            "战前气氛": ["紧张", "期待", "热血", "温馨"],
            "能力互补": ["攻击型", "防御型", "辅助型", "智慧型"]
        }
    },
    "cliffhanger": {
        "name": "章末悬念",
        "keywords": [
            "未完待续", "待续", "悬念", "危机", "危险",
            "突然", "就在此时", "就在这一刻", "就在这时",
            "谁", "是否", "能否", "即将", "即将发生"
        ],
        "sub_keywords": {
            "悬念类型": ["生死悬念", "情感悬念", "命运悬念", "谜团悬念"],
            "信息控制": ["欲言又止", "半遮半掩", "完全隐藏"],
            "翻页钩子": ["疑问句", "感叹句", "短句"]
        }
    }
}


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class SceneExcerpt:
    """场景片段"""
    scene_type: str
    subtype: str
    text: str
    word_count: int
    start_pos: int
    end_pos: int
    quality_score: float = 0.0
    tags: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScenePattern:
    """场景模式"""
    scene_type: str
    scene_type_name: str
    source_work: str
    source_author: str
    excerpts: list = field(default_factory=list)
    pattern_analysis: dict = field(default_factory=dict)
    extraction_date: str = "2026-05-27"

    def to_dict(self) -> dict:
        return asdict(self)


# ============================================================================
# 场景分析引擎
# ============================================================================

class SceneAnalyzer:
    """场景分析引擎"""

    def __init__(self, text: str, min_scene_length: int = 200) -> None:
        self.text = text
        self.min_scene_length = min_scene_length

    def detect_scene_type(self, segment: str) -> tuple[Optional[str], float]:
        """
        检测文本片段的场景类型
        返回: (scene_type, confidence_score)
        """
        segment_lower = segment

        best_type = None
        best_score = 0.0

        for scene_type, config in SCENE_TYPES.items():
            score = 0.0
            keyword_count = 0

            for keyword in config["keywords"]:
                if keyword in segment_lower:
                    score += 1.0
                    keyword_count += 1

            # 归一化分数
            if keyword_count > 0:
                score = score / len(config["keywords"]) * 100
                if score > best_score:
                    best_score = score
                    best_type = scene_type

        # 设置阈值
        if best_score < 3.0:
            return None, 0.0

        return best_type, best_score

    def extract_scenes(self) -> list[SceneExcerpt]:
        """提取所有场景片段"""
        excerpts = []

        # 按段落分割
        paragraphs = self.text.split('\n\n')
        current_segment = []
        current_type = None
        segment_start = 0

        for i, para in enumerate(paragraphs):
            para = para.strip()
            if not para:
                continue

            scene_type, confidence = self.detect_scene_type(para)

            # 如果检测到场景类型
            if scene_type:
                # 保存之前的片段
                if current_type and current_segment:
                    full_text = '\n\n'.join(current_segment)
                    if len(full_text) >= self.min_scene_length:
                        excerpts.append(SceneExcerpt(
                            scene_type=current_type,
                            subtype=self._detect_subtype(full_text, current_type),
                            text=full_text[:3000],  # 限制长度
                            word_count=len(re.findall(r'[\u4e00-\u9fa5]', full_text)),
                            start_pos=segment_start,
                            end_pos=segment_start + len(full_text),
                            quality_score=self._assess_quality(full_text),
                            tags=self._extract_tags(full_text)
                        ))

                # 开始新片段
                current_segment = [para]
                current_type = scene_type
                segment_start = sum(len(p) + 2 for p in paragraphs[:i])
            else:
                # 继续当前片段
                if current_type:
                    current_segment.append(para)

        # 保存最后一片段
        if current_type and current_segment:
            full_text = '\n\n'.join(current_segment)
            if len(full_text) >= self.min_scene_length:
                excerpts.append(SceneExcerpt(
                    scene_type=current_type,
                    subtype=self._detect_subtype(full_text, current_type),
                    text=full_text[:3000],
                    word_count=len(re.findall(r'[\u4e00-\u9fa5]', full_text)),
                    start_pos=segment_start,
                    end_pos=segment_start + len(full_text),
                    quality_score=self._assess_quality(full_text),
                    tags=self._extract_tags(full_text)
                ))

        return excerpts

    def _detect_subtype(self, text: str, scene_type: str) -> str:
        """检测场景子类型"""
        config = SCENE_TYPES.get(scene_type, {})
        sub_keywords = config.get("sub_keywords", {})

        best_subtype = "通用"
        max_score = 0

        for subtype, keywords in sub_keywords.items():
            score = sum(1 for kw in keywords if kw in text)
            if score > max_score:
                max_score = score
                best_subtype = subtype

        return best_subtype

    def _assess_quality(self, text: str) -> float:
        """评估片段质量 (0-1)"""
        score = 0.5  # 基础分

        # 长度加分
        word_count = len(re.findall(r'[\u4e00-\u9fa5]', text))
        if word_count > 500:
            score += 0.1
        if word_count > 1000:
            score += 0.1

        # 对话加分
        if '"' in text or '"' in text or '"' in text:
            score += 0.1

        # 描写加分
        descriptive_markers = ['看着', '听着', '感受', '只见', '只见得']
        if any(m in text for m in descriptive_markers):
            score += 0.1

        # 扣分项：AI腔特征
        ai_patterns = ['首先', '其次', '最后', '总之', '这意味着']
        ai_count = sum(text.count(p) for p in ai_patterns)
        if ai_count > 3:
            score -= 0.2

        return min(max(score, 0.0), 1.0)

    def _extract_tags(self, text: str) -> list:
        """提取标签"""
        tags = []

        # 角色相关
        if any(w in text for w in ['主角', '男主', '女主']):
            tags.append('主角视角')

        # 情感相关
        if any(w in text for w in ['感动', '流泪', '悲伤']):
            tags.append('情感向')
        if any(w in text for w in ['热血', '燃', '激情']):
            tags.append('热血向')

        # 描写相关
        if any(w in text for w in ['环境', '场景', '天空', '大地']):
            tags.append('环境描写')
        if any(w in text for w in ['动作', '出手', '攻击']):
            tags.append('动作描写')
        if any(w in text for w in ['对话', '说道', '问道']):
            tags.append('对话丰富')

        return tags[:5]  # 最多5个标签


class ScenePatternBuilder:
    """场景模式构建器"""

    def __init__(self):
        self.scenes_by_type = defaultdict(list)

    def add_excerpts(self, excerpts: list, work_info: dict):
        """添加片段并按类型分组"""
        for excerpt in excerpts:
            self.scenes_by_type[excerpt.scene_type].append({
                'excerpt': excerpt.to_dict(),
                'work': work_info.get('title', 'unknown'),
                'author': work_info.get('author', 'unknown')
            })

    def build_patterns(self) -> dict:
        """构建场景模式"""
        patterns = {}

        for scene_type, items in self.scenes_by_type.items():
            if not items:
                continue

            scene_config = SCENE_TYPES.get(scene_type, {})
            pattern = ScenePattern(
                scene_type=scene_type,
                scene_type_name=scene_config.get("name", scene_type),
                source_work=items[0]['work'] if items else '',
                source_author=items[0]['author'] if items else '',
                excerpts=[item['excerpt'] for item in items],
                pattern_analysis=self._analyze_pattern(items)
            )
            patterns[scene_type] = pattern

        return patterns

    def _analyze_pattern(self, items: list) -> dict:
        """分析场景模式特征"""
        if not items:
            return {}

        excerpts = [item['excerpt'] for item in items]
        total_words = sum(e['word_count'] for e in excerpts)
        avg_words = total_words / len(excerpts) if excerpts else 0
        avg_quality = sum(e['quality_score'] for e in excerpts) / len(excerpts)

        # 统计子类型分布
        subtypes = defaultdict(int)
        for e in excerpts:
            subtypes[e['subtype']] += 1

        # 统计标签
        all_tags = []
        for e in excerpts:
            all_tags.extend(e.get('tags', []))
        tag_counts = defaultdict(int)
        for tag in all_tags:
            tag_counts[tag] += 1
        top_tags = sorted(tag_counts.items(), key=lambda x: x[1], reverse=True)[:5]

        return {
            'excerpt_count': len(excerpts),
            'total_words': total_words,
            'avg_words_per_excerpt': round(avg_words, 0),
            'avg_quality_score': round(avg_quality, 2),
            'subtype_distribution': dict(subtypes),
            'common_tags': [t[0] for t in top_tags]
        }


# ============================================================================
# 主程序
# ============================================================================

def load_novel_json(file_path: str) -> dict:
    """加载小说JSON"""
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def extract_scenes_from_novel(novel_data: dict, max_chapters: int = 500) -> dict:
    """从小说中提取场景"""
    work_info = {
        'title': novel_data.get('title', ''),
        'author': novel_data.get('author', 'Unknown'),
        'genre': novel_data.get('genre', 'unknown')
    }

    chapters = novel_data.get('chapters', [])
    if len(chapters) > max_chapters:
        step = len(chapters) // max_chapters
        sampled = [chapters[i] for i in range(0, len(chapters), step)][:max_chapters]
        chapters = sampled

    all_text = '\n\n'.join(ch.get('text', '') for ch in chapters)

    analyzer = SceneAnalyzer(all_text)
    excerpts = analyzer.extract_scenes()

    builder = ScenePatternBuilder()
    builder.add_excerpts(excerpts, work_info)
    patterns = builder.build_patterns()

    return patterns


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 场景模式提取")
    parser.add_argument("--input", "-i", required=True, help="输入文件或目录")
    parser.add_argument("--output", "-o", required=True, help="输出目录")
    parser.add_argument("--batch", "-b", action="store_true", help="批量处理")
    parser.add_argument("--min-length", "-l", type=int, default=200, help="最小场景长度")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.batch:
        # 批量处理
        input_dir = Path(args.input)
        json_files = list(input_dir.glob("*.json"))
        print(f"批量处理: {len(json_files)} 个文件")

        all_patterns = defaultdict(list)
        work_count = 0

        for json_file in json_files:
            try:
                print(f"\n处理: {json_file.name}")
                novel_data = load_novel_json(str(json_file))

                patterns = extract_scenes_from_novel(novel_data)
                for scene_type, pattern in patterns.items():
                    all_patterns[scene_type].append({
                        'source': json_file.stem,
                        'pattern': pattern.to_dict()
                    })

                excerpt_count = sum(len(p.excerpts) for p in patterns.values())
                print(f"  -> 提取 {excerpt_count} 个场景片段")
                work_count += 1

            except Exception as e:
                print(f"  -> 错误: {e}")

        # 保存按场景类型分类的结果
        for scene_type, items in all_patterns.items():
            output_file = output_dir / f"{scene_type}.json"
            scene_config = SCENE_TYPES.get(scene_type, {})
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump({
                    'scene_type': scene_type,
                    'scene_name': scene_config.get('name', scene_type),
                    'sources': list(set(item['source'] for item in items)),
                    'patterns': [item['pattern'] for item in items]
                }, f, ensure_ascii=False, indent=2)

        print(f"\n处理完成: {work_count} 部作品")
        print(f"场景类型: {list(all_patterns.keys())}")

    else:
        # 单文件处理
        print(f"处理: {args.input}")
        novel_data = load_novel_json(args.input)

        patterns = extract_scenes_from_novel(novel_data)

        # 保存所有场景类型
        for scene_type, pattern in patterns.items():
            output_file = output_dir / f"{scene_type}.json"
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(pattern.to_dict(), f, ensure_ascii=False, indent=2)

        print(f"\n提取完成:")
        for scene_type, pattern in patterns.items():
            print(f"  {SCENE_TYPES[scene_type]['name']}: {len(pattern.excerpts)} 个片段")


if __name__ == "__main__":
    main()
