#!/usr/bin/env python3
"""Remove version history UI and API from frontend/backend source files."""
import re
import os
import sys

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)

# 1. ChapterEditor.vue - remove version history button, panel, import, ref
path = r'd:\CODE\sub2api\frontend\src\components\novel\ChapterEditor.vue'
content = read_file(path)

# Remove version history button
content = re.sub(r'\s*<button class="btn btn-ghost btn-sm" @click="showVersions = true">版本历史</button>\s*\n', '\n', content)

# Remove VersionHistoryPanel component block
content = re.sub(r'\s*<!-- 版本历史抽屉 -->\s*\n\s*<VersionHistoryPanel[^/]*?/>\s*\n', '\n', content, flags=re.DOTALL)

# Remove import
content = content.replace("import VersionHistoryPanel from './VersionHistoryPanel.vue'\n", '')

# Remove showVersions ref
content = re.sub(r'const showVersions = ref\(false\)\s*\n\s*\n', '', content)

write_file(path, content)
print("ChapterEditor.vue: done")

# 2. DocumentEditor.vue - same treatment
path = r'd:\CODE\sub2api\frontend\src\components\novel\DocumentEditor.vue'
content = read_file(path)

content = re.sub(r'\s*<button class="btn btn-ghost btn-sm" @click="showVersions = true">版本历史</button>\s*\n', '\n', content)
content = re.sub(r'\s*<!-- 版本历史抽屉 -->\s*\n\s*<VersionHistoryPanel[^/]*?/>\s*\n', '\n', content, flags=re.DOTALL)
content = content.replace("import VersionHistoryPanel from './VersionHistoryPanel.vue'\n", '')
content = re.sub(r'const showVersions = ref\(false\)\s*\n\s*\n', '', content)

write_file(path, content)
print("DocumentEditor.vue: done")

# 3. api.ts - remove version history API functions
path = r'd:\CODE\sub2api\frontend\src\features\novel-studio\api.ts'
content = read_file(path)

# Remove version-related functions
funcs_to_remove = [
    'listChapterVersions',
    'restoreChapterVersion',
    'listDocumentVersions',
    'restoreDocumentVersion',
]

for func_name in funcs_to_remove:
    # Match: export async function func_name(...) { ... }
    pattern = rf'\n*export async function {func_name}\([^)]*\)[^}}]*{{[^}}]*}}\s*\n*'
    content = re.sub(pattern, '\n', content, flags=re.DOTALL)

# Remove version-related imports from types
content = re.sub(r'\s*ChapterVersion,\s*\n', '\n', content)
content = re.sub(r'\s*DocumentVersion,\s*\n', '\n', content)

# Clean up section header
content = content.replace(
    '// ==================== 章节手工保存与版本历史 ====================',
    '// ==================== 章节手工保存 ===================='
)

write_file(path, content)
print("api.ts: done")

# Verify
for name, p in [('ChapterEditor.vue', r'd:\CODE\sub2api\frontend\src\components\novel\ChapterEditor.vue'),
                ('DocumentEditor.vue', r'd:\CODE\sub2api\frontend\src\components\novel\DocumentEditor.vue'),
                ('api.ts', r'd:\CODE\sub2api\frontend\src\features\novel-studio\api.ts')]:
    c = read_file(p)
    has_vh = bool(re.search(r'VersionHistoryPanel|showVersions|版本历史|listChapterVersions|restoreChapterVersion|listDocumentVersions|restoreDocumentVersion', c))
    print(f"  {name}: version history refs present = {has_vh}")

print("\nAll frontend files modified.")
