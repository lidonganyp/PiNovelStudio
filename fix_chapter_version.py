#!/usr/bin/env python3
"""Remove remaining version creation blocks from SaveChapter in novel_data_service.go."""
import re

path = r'd:\CODE\sub2api\backend\internal\service\novel_data_service.go'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove "source :=" variable inference block
content = re.sub(
    r'\n\t// 推断版本来源\n\tsource := "manual_save"\n\tif req\.Source != nil \{\n\t\tsource = \*req\.Source\n\t\} else if req\.GenerationJobID != nil \{\n\t\tsource = "ai_generated"\n\t\}\n',
    '\n',
    content
)

# 2. Remove version snapshot creation block (new chapter)
# Pattern: from "// 写入版本快照（version_number=1）" to the closing "}"
content = re.sub(
    r'\n\t\t// 写入版本快照（version_number=1）\n\t\tversionCreate := txClient\.NovelChapterVersion\.Create\(\)\.[^}]*?SetCreatedBy\(req\.UserID\)\n\t\tif req\.GenerationJobID != nil \{\n\t\t\tversionCreate\.SetGenerationJobID\(\*req\.GenerationJobID\)\n\t\t\}\n\t\tif _, vErr := versionCreate\.Save\(ctx\); vErr != nil \{\n\t\t\treturn nil, fmt\.Errorf\("novel data: create chapter version: %w", vErr\)\n\t\t\}\n',
    '\n',
    content,
    flags=re.DOTALL
)

# 3. Remove version snapshot creation block (update chapter)
content = re.sub(
    r'\n\t// 写入版本快照\n\tversionCreate := txClient\.NovelChapterVersion\.Create\(\)\.[^}]*?SetCreatedBy\(req\.UserID\)\n\tif req\.GenerationJobID != nil \{\n\t\tversionCreate\.SetGenerationJobID\(\*req\.GenerationJobID\)\n\t\}\n\tif _, vErr := versionCreate\.Save\(ctx\); vErr != nil \{\n\t\treturn nil, fmt\.Errorf\("novel data: create chapter version: %w", vErr\)\n\t\}\n',
    '\n',
    content,
    flags=re.DOTALL
)

# 4. Update SaveChapter comment
content = content.replace(
    '// SaveChapter 保存章节（创建或更新），在同一事务内写入不可变版本快照。\n//\n// 乐观锁：req.ExpectedVersion 非 nil 时须与当前 version 一致，否则 409 VERSION_CONFLICT。\n// 版本来源：req.Source 显式指定（如 "restore"）；否则按 GenerationJobID 推断（ai_generated / manual_save）。',
    '// SaveChapter 保存章节（创建或更新），不再写入版本快照（版本表已弃用）。\n//\n// 乐观锁：req.ExpectedVersion 非 nil 时须与当前 version 一致，否则 409 VERSION_CONFLICT。'
)

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()

has_version = bool(re.search(r'NovelChapterVersion\.Create|NovelDocumentVersion\.Create|dbnoveldocumentversion|versionCreate', verify))
print(f"novel_data_service.go: version creation refs present = {has_version}")

if has_version:
    matches = re.findall(r'.*(?:NovelChapterVersion|NovelDocumentVersion|dbnoveldocumentversion|versionCreate).*', verify)
    for m in matches:
        print(f"  残留: {m.strip()}")
