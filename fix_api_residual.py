#!/usr/bin/env python3
"""Fix residual version-history code in api.ts."""
import re

path = r'd:\CODE\sub2api\frontend\src\features\novel-studio\api.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove residual function bodies (lines 158-173 area)
# Pattern: lines starting with "= await apiClient" through closing "}"
residual_patterns = [
    # ChapterVersion GET
    r'\n= await apiClient\.get<ChapterVersion\[\]>?\([^)]*\)\s*\n\s*return data\s*\n}\s*\n',
    # restoreChapterVersion POST
    r'\n= await apiClient\.post<NovelChapter>?\([^)]*\)\s*\n\s*req \?\? \{\},\s*\n\s*\)\s*\n\s*return data\s*\n}\s*\n',
    # DocumentVersion GET
    r'\n= await apiClient\.get<DocumentVersion\[\]>?\([^)]*\)\s*\n\s*return data\s*\n}\s*\n',
    # restoreDocumentVersion POST (similar to chapter)
    r'\n= await apiClient\.post<NovelDocument>?\([^)]*\)\s*\n\s*req \?\? \{\},\s*\n\s*\)\s*\n\s*return data\s*\n}\s*\n',
]

for pat in residual_patterns:
    content = re.sub(pat, '\n', content, flags=re.DOTALL)

# Remove residual import lines
content = re.sub(r'\s*listChapterVersions,\s*\n', '\n', content)
content = re.sub(r'\s*restore\n\s*ChapterVersion,?\s*\n', '\n', content)
content = re.sub(r'\s*listDocumentVersions,\s*\n', '\n', content)
content = re.sub(r'\s*restore\n\s*DocumentVersion,?\s*\n', '\n', content)
# Also remove broken "restore" lines
content = re.sub(r'\s*restore\s*\n', '\n', content)

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()

has_refs = bool(re.search(r'VersionHistoryPanel|showVersions|版本历史|listChapterVersions|restoreChapterVersion|listDocumentVersions|restoreDocumentVersion|ChapterVersion|DocumentVersion', verify))
print(f"api.ts: version history refs present = {has_refs}")

if has_refs:
    matches = re.findall(r'.*(?:VersionHistoryPanel|showVersions|版本历史|listChapterVersions|restoreChapterVersion|listDocumentVersions|restoreDocumentVersion|ChapterVersion|DocumentVersion).*', verify)
    for m in matches:
        print(f" 残留: {m.strip()}")
