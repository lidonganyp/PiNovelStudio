"""
PiNovelStudio — 数据处理管线执行脚本

一键执行所有数据处理步骤，构建五层数据壁垒。

用法：
    python run-pipeline.py --all                    # 执行全部步骤
    python run-pipeline.py --step 1               # 只执行第1步
    python run-pipeline.py --input D:/corpus       # 指定语料库路径
"""

import argparse
import subprocess
import sys
import os
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent


STEPS = {
    1: {
        "name": "文本预处理",
        "description": "清洗原始文本，切分章节",
        "command": ["python", "scripts/preprocess.py", "--input", "corpus/raw/", "--output", "corpus/clean/"],
        "required": True
    },
    2: {
        "name": "风格指纹提取",
        "description": "从作品中提取风格指纹",
        "command": ["python", "scripts/extract-style.py", "--input", "corpus/clean/", "--output", "data/styles/", "--batch"],
        "required": True
    },
    3: {
        "name": "场景分类提取",
        "description": "提取12类场景模式",
        "command": ["python", "scripts/extract-scenes.py", "--input", "corpus/clean/", "--output", "data/scenes/", "--batch"],
        "required": True
    },
    4: {
        "name": "技法挖掘",
        "description": "从语料中挖掘写作技法",
        "command": ["python", "scripts/mine-techniques.py", "--input", "corpus/clean/", "--output", "data/techniques/", "--batch"],
        "required": False
    },
    5: {
        "name": "Few-Shot库构建",
        "description": "构建黄金示例库",
        "command": ["python", "scripts/build-fewshots.py", "--scenes", "data/scenes/", "--styles", "data/styles/", "--output", "data/fewshots/"],
        "required": True
    },
    6: {
        "name": "对比蒸馏",
        "description": "生成对比蒸馏知识",
        "command": ["python", "scripts/contrastive-distill.py", "--generate-samples", "--output", "data/contrastive/"],
        "required": False
    }
}


def run_command(cmd: list, step_name: str) -> bool:
    """执行命令"""
    print(f"\n{'='*60}")
    print(f"执行: {step_name}")
    print(f"命令: {' '.join(cmd)}")
    print('='*60)

    try:
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True
        )

        if result.stdout:
            print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)

        if result.returncode == 0:
            print(f"✅ {step_name} 完成")
            return True
        else:
            print(f"❌ {step_name} 失败 (退出码: {result.returncode})")
            return False

    except Exception as e:
        print(f"❌ {step_name} 执行异常: {e}")
        return False


def check_corpus() -> bool:
    """检查语料库"""
    raw_corpus = PROJECT_ROOT / "corpus" / "raw"

    if not raw_corpus.exists():
        print(f"⚠️  语料库目录不存在: {raw_corpus}")
        print("请将原始小说文件(.txt)放入此目录")
        return False

    files = list(raw_corpus.glob("*.txt")) + list(raw_corpus.glob("*.json"))
    if not files:
        print(f"⚠️  语料库为空: {raw_corpus}")
        print("请放入原始小说文件")
        return False

    print(f"📚 找到 {len(files)} 个语料文件")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 数据处理管线")
    parser.add_argument("--all", action="store_true", help="执行所有步骤")
    parser.add_argument("--step", "-s", type=int, help="执行指定步骤 (1-6)")
    parser.add_argument("--input", "-i", help="原始语料库路径")
    parser.add_argument("--skip-check", action="store_true", help="跳过语料库检查")
    args = parser.parse_args()

    print("="*60)
    print("PiNovelStudio 数据处理管线")
    print("="*60)

    # 检查语料库
    if not args.skip_check:
        if not check_corpus():
            if not args.all and args.step:
                print("继续执行（--skip-check）...")
            else:
                return

    # 确定要执行的步骤
    if args.step:
        steps_to_run = [args.step]
    elif args.all:
        steps_to_run = list(STEPS.keys())
    else:
        # 默认执行必需步骤
        steps_to_run = [s for s, info in STEPS.items() if info["required"]]

    print(f"\n将执行以下步骤: {steps_to_run}")

    # 执行步骤
    results = {}
    for step_num in steps_to_run:
        if step_num not in STEPS:
            print(f"❌ 未知步骤: {step_num}")
            continue

        step_info = STEPS[step_num]

        # 替换输入路径
        cmd = step_info["command"]
        if args.input and "corpus/raw/" in str(cmd):
            cmd = [arg.replace("corpus/raw/", args.input) if "corpus/raw/" in arg else arg for arg in cmd]

        success = run_command(cmd, step_info["name"])
        results[step_num] = success

        # 如果失败且是必需步骤，询问是否继续
        if not success and step_info["required"]:
            response = input("\n此步骤失败，是否继续？(y/n): ")
            if response.lower() != 'y':
                print("管线执行中止")
                break

    # 总结
    print("\n" + "="*60)
    print("管线执行完成")
    print("="*60)

    success_count = sum(1 for v in results.values() if v)
    total_count = len(results)

    print(f"成功: {success_count}/{total_count}")
    print("\n数据壁垒状态:")

    for layer, path in [
        ("Layer1 风格指纹", "data/styles/"),
        ("Layer2 场景模式", "data/scenes/"),
        ("Layer3 技法原子", "data/techniques/"),
        ("Layer4 Few-Shot", "data/fewshots/"),
        ("Layer5 对比蒸馏", "data/contrastive/"),
    ]:
        layer_path = PROJECT_ROOT / path
        if layer_path.exists():
            files = list(layer_path.glob("*.json"))
            print(f"  ✅ {layer}: {len(files)} 个文件")
        else:
            print(f"  ❌ {layer}: 未构建")


if __name__ == "__main__":
    main()
