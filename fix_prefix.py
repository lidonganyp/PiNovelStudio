#!/usr/bin/env python3
"""修复 service 前缀"""
import io

target = r'd:\CODE\sub2api\backend\internal\service\novel_assistant_service.go'
with io.open(target, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace(
    's.dataRepo.SaveDocument(ctx, service.SaveDocumentRequest{',
    's.dataRepo.SaveDocument(ctx, SaveDocumentRequest{'
)

with io.open(target, 'w', encoding='utf-8', newline='') as f:
    f.write(content)
print("[OK] Fixed service prefix")
