"""
PiNovelStudio — 文本预处理脚本

用法：python preprocess.py --input <目录> --output <输出目录>
"""

import argparse
import json
import re
import os
from pathlib import Path
from dataclasses import dataclass, asdict


@dataclass
class Chapter:
    chapter_num: int
    title: str
    text: str
    word_count: int

    def to_dict(self):
        return asdict(self)


@dataclass
class Novel:
    title: str
    author: str
    genre: str
    sub_genres: list
    chapters: list

    def to_dict(self):
        return {
            "title": self.title,
            "author": self.author,
            "genre": self.genre,
            "sub_genres": self.sub_genres,
            "chapters": [c.to_dict() for c in self.chapters],
        }


class TextPreprocessor:
    def __init__(self) -> None:
        self.ad_patterns = [
            r"请访问.*?\.com", r"www\.\w+\.com",
            r"小说网.*?首发", r"广告.*?小说",
        ]
        self.tag_patterns = [r"<[^>]+>", r"\[.*?\]", r"\{.*?\}"]

    def preprocess(self, text: str) -> str:
        text = re.sub(r"\ufffd|\x00|\ufeff", "", text)
        for pattern in self.tag_patterns:
            text = re.sub(pattern, "", text)
        for pattern in self.ad_patterns:
            text = re.sub(pattern, "", text, flags=re.IGNORECASE)
        text = re.sub(r"\r\n", "\n", text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


class ChapterSplitter:
    CHAPTER_PATTERNS = [
        r"第([零一二三四五六七八九十百千万\d]+)章[：:\s]*(.*)",
        r"^Chapter\s+(\d+)\s*[:\.\-]?\s*(.*)$",
    ]

    def split(self, text: str) -> list[Chapter]:
        chapters = []
        lines = text.split("\n")
        current_lines = []
        chapter_num = 0

        for line in lines:
            match = self._try_match_chapter(line, chapter_num + 1)
            if match:
                if current_lines and chapter_num > 0:
                    chapters.append(Chapter(
                        chapter_num=chapter_num,
                        title=f"第{chapter_num}章",
                        text="\n".join(current_lines),
                        word_count=self._count_words("\n".join(current_lines))
                    ))
                chapter_num = match
                current_lines = []
            current_lines.append(line)

        if current_lines and chapter_num > 0:
            chapters.append(Chapter(
                chapter_num=chapter_num,
                title=f"第{chapter_num}章",
                text="\n".join(current_lines),
                word_count=self._count_words("\n".join(current_lines))
            ))

        if not chapters:
            chapters = self._split_by_length(text)

        return chapters

    def _try_match_chapter(self, line: str, default_num: int) -> int | None:
        line = line.strip()
        for pattern in self.CHAPTER_PATTERNS:
            match = re.match(pattern, line, re.IGNORECASE)
            if match:
                num_str = match.group(1)
                try:
                    if num_str.isdigit():
                        return int(num_str)
                    return default_num
                except:
                    return default_num
        return None

    def _split_by_length(self, text: str, chunk_size: int = 3000) -> list[Chapter]:
        chapters = []
        chars = list(text)
        chapter_num = 1
        while chars:
            chunk = chars[:chunk_size]
            chars = chars[chunk_size:]
            chapters.append(Chapter(
                chapter_num=chapter_num,
                title=f"第{chapter_num}章",
                text="".join(chunk),
                word_count=self._count_words("".join(chunk))
            ))
            chapter_num += 1
        return chapters

    def _count_words(self, text: str) -> int:
        return len(re.findall(r"[\u4e00-\u9fa5]", text))


def read_text_with_encoding(file_path: str) -> str:
    encodings = ["utf-8", "gb18030", "gbk", "gb2312", "big5", "utf-16"]
    for enc in encodings:
        try:
            with open(file_path, "r", encoding=enc) as f:
                text = f.read()
            if len(re.findall(r"[\u4e00-\u9fa5]", text)) > len(text) * 0.05:
                return text
        except (UnicodeDecodeError, UnicodeError):
            continue
    for enc in encodings:
        try:
            with open(file_path, "r", encoding=enc, errors="replace") as f:
                text = f.read()
            if len(re.findall(r"[\u4e00-\u9fa5]", text)) > len(text) * 0.05:
                return text
        except Exception:
            continue
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def process_novel(input_path: str, output_dir: str, genre: str = "unknown") -> dict:
    print(f"Processing: {input_path}")
    text = read_text_with_encoding(input_path)

    preprocessor = TextPreprocessor()
    text = preprocessor.preprocess(text)

    splitter = ChapterSplitter()
    chapters = splitter.split(text)

    title = Path(input_path).stem
    novel = Novel(title=title, author="Unknown", genre=genre, sub_genres=[], chapters=chapters)

    output_file = Path(output_dir) / f"{title}.json"
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(novel.to_dict(), f, ensure_ascii=False, indent=2)

    print(f"  -> {len(chapters)} chapters, saved to {output_file}")
    return {"title": title, "chapters": len(chapters), "total_words": sum(c.word_count for c in chapters)}


def main() -> None:
    parser = argparse.ArgumentParser(description="PiNovelStudio 文本预处理")
    parser.add_argument("--input", "-i", required=True)
    parser.add_argument("--output", "-o", required=True)
    parser.add_argument("--genre", "-g", default="unknown")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    files = [input_path] if input_path.is_file() else list(input_path.glob("*.txt"))
    print(f"Found {len(files)} files")

    results = []
    for file in files:
        try:
            result = process_novel(str(file), str(output_dir), args.genre)
            results.append(result)
        except Exception as e:
            print(f"Error: {file} - {e}")

    print(f"\nProcessed {len(results)} novels")


if __name__ == "__main__":
    main()
