#!/usr/bin/env python3
"""Remove version history write logic from novel_data_service.go and routes from novel.go."""
import re

# ========== novel_data_service.go ==========
path = r'd:\CODE\sub2api\backend\internal\service\novel_data_service.go'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove dbnoveldocumentversion import
content = content.replace(
    '\tdbnoveldocumentversion "github.com/Wei-Shaw/sub2api/ent/noveldocumentversion"\n',
    ''
)

# 2. Update file header comment
content = content.replace(
    '// 文档保存自动创建版本记录（NovelDocumentVersion），支持版本回溯。',
    '// 版本历史功能已弃用，文档和章节保存不再创建版本快照。'
)

# 3. Update SaveDocumentRequest comment
content = content.replace(
    '// SaveDocumentRequest 保存文档请求（自动创建版本）。',
    '// SaveDocumentRequest 保存文档请求。'
)

# 4. Update SaveChapterRequest comment - remove version source line
content = re.sub(
    r'// Source 显式指定版本来源（如 "restore"）；为 nil 时按 GenerationJobID 推断（ai_generated / manual_save）。\n',
    '',
    content
)

# 5. Update interface - remove version methods
content = content.replace(
    '\t// 文档 CRUD（带版本控制）\n',
    '\t// 文档 CRUD\n'
)
content = re.sub(
    r'\tGetDocumentVersions\(ctx context\.Context, userID, documentID int64\) \(\[\]\*dbent\.NovelDocumentVersion, error\)\n',
    '',
    content
)
content = re.sub(
    r'\tGetDocumentVersion\(ctx context\.Context, userID, documentID int64, versionNumber int\) \(\*dbent\.NovelDocumentVersion, error\)\n',
    '',
    content
)
content = re.sub(
    r'\t// 章节版本历史（B1）\n\tListChapterVersions\(ctx context\.Context, userID, chapterID int64\) \(\[\]\*dbent\.NovelChapterVersion, error\)\n\tGetChapterVersion\(ctx context\.Context, userID, chapterID int64, versionNumber int\) \(\*dbent\.NovelChapterVersion, error\)\n',
    '',
    content
)

# 6. Replace SaveDocument method - remove version creation
old_save_doc = '''// SaveDocument 保存文档（自动创建版本记录）。
// 如果文档不存在则创建，存在则更新内容并创建新版本。
func (r *novelDataRepository) SaveDocument(ctx context.Context, req SaveDocumentRequest) (*dbent.NovelDocument, error) {
	// 先验证项目归属
	_, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// 查找现有文档
	// 注意：查询错误必须用独立变量保存，否则下方 Tx() 的 err 会覆盖 NotFound，
	// 导致 existing==nil 时跳过创建分支，直接访问 existing.CurrentVersion 触发 nil panic。
	existing, queryErr := r.client.NovelDocument.Query().
		Where(
			dbnoveldocument.ProjectIDEQ(req.ProjectID),
			dbnoveldocument.UserIDEQ(req.UserID),
			dbnoveldocument.DocumentTypeEQ(req.DocumentType),
			dbnoveldocument.DeletedAtIsNil(),
		).
		Only(ctx)
	if queryErr != nil && !dbent.IsNotFound(queryErr) {
		return nil, fmt.Errorf("novel data: query existing document: %w", queryErr)
	}

	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: begin tx for document: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	txClient := tx.Client()

	if dbent.IsNotFound(queryErr) {
		// 创建新文档
		doc, err := txClient.NovelDocument.Create().
			SetProjectID(req.ProjectID).
			SetUserID(req.UserID).
			SetDocumentType(req.DocumentType).
			SetTitle(req.Title).
			SetContent(req.Content).
			SetCurrentVersion(1).
			Save(ctx)
		if err != nil {
			return nil, fmt.Errorf("novel data: create document: %w", err)
		}

		// 创建版本 1
		_, err = txClient.NovelDocumentVersion.Create().
			SetDocumentID(doc.ID).
			SetCreatedBy(req.UserID).
			SetVersionNumber(1).
			SetContent(req.Content).
			Save(ctx)
		if err != nil {
			return nil, fmt.Errorf("novel data: create document version: %w", err)
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("novel data: commit document: %w", err)
		}
		return doc, nil
	}
	if err != nil {
		return nil, fmt.Errorf("novel data: query existing document: %w", err)
	}

	// 乐观锁检查（ExpectedVersion 非 nil 时须与当前 CurrentVersion 一致）
	if req.ExpectedVersion != nil && *req.ExpectedVersion != existing.CurrentVersion {
		return nil, infraerrors.Conflict("VERSION_CONFLICT", "文档已被他人修改，请重载服务端版本后再保存")
	}

	// 更新现有文档
	newVersion := existing.CurrentVersion + 1
	doc, err := txClient.NovelDocument.UpdateOne(existing).
		SetTitle(req.Title).
		SetContent(req.Content).
		SetCurrentVersion(newVersion).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: update document: %w", err)
	}

	// 创建新版本
	_, err = txClient.NovelDocumentVersion.Create().
		SetDocumentID(doc.ID).
		SetCreatedBy(req.UserID).
		SetVersionNumber(newVersion).
		SetContent(req.Content).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: create new document version: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("novel data: commit document update: %w", err)
	}
	return doc, nil
}'''

new_save_doc = '''// SaveDocument 保存文档（不再写入版本历史，版本表已弃用）。
func (r *novelDataRepository) SaveDocument(ctx context.Context, req SaveDocumentRequest) (*dbent.NovelDocument, error) {
	// 先验证项目归属
	_, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// 查找现有文档
	existing, queryErr := r.client.NovelDocument.Query().
		Where(
			dbnoveldocument.ProjectIDEQ(req.ProjectID),
			dbnoveldocument.UserIDEQ(req.UserID),
			dbnoveldocument.DocumentTypeEQ(req.DocumentType),
			dbnoveldocument.DeletedAtIsNil(),
		).
		Only(ctx)
	if queryErr != nil && !dbent.IsNotFound(queryErr) {
		return nil, fmt.Errorf("novel data: query existing document: %w", queryErr)
	}

	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: begin tx for document: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	txClient := tx.Client()

	if dbent.IsNotFound(queryErr) {
		// 创建新文档
		doc, err := txClient.NovelDocument.Create().
			SetProjectID(req.ProjectID).
			SetUserID(req.UserID).
			SetDocumentType(req.DocumentType).
			SetTitle(req.Title).
			SetContent(req.Content).
			SetCurrentVersion(1).
			Save(ctx)
		if err != nil {
			return nil, fmt.Errorf("novel data: create document: %w", err)
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("novel data: commit document: %w", err)
		}
		return doc, nil
	}
	if err != nil {
		return nil, fmt.Errorf("novel data: query existing document: %w", err)
	}

	// 乐观锁检查（ExpectedVersion 非 nil 时须与当前 CurrentVersion 一致）
	if req.ExpectedVersion != nil && *req.ExpectedVersion != existing.CurrentVersion {
		return nil, infraerrors.Conflict("VERSION_CONFLICT", "文档已被他人修改，请重载服务端版本后再保存")
	}

	// 更新现有文档
	newVersion := existing.CurrentVersion + 1
	doc, err := txClient.NovelDocument.UpdateOne(existing).
		SetTitle(req.Title).
		SetContent(req.Content).
		SetCurrentVersion(newVersion).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: update document: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("novel data: commit document update: %w", err)
	}
	return doc, nil
}'''

if old_save_doc in content:
    content = content.replace(old_save_doc, new_save_doc)
    print("SaveDocument: replaced")
else:
    print("WARNING: SaveDocument old block not found")

# 7. Remove GetDocumentVersions method
old_get_versions = '''// GetDocumentVersions 获取文档版本历史。
func (r *novelDataRepository) GetDocumentVersions(ctx context.Context, userID, documentID int64) ([]*dbent.NovelDocumentVersion, error) {
	// 先验证文档归属
	doc, err := r.client.NovelDocument.Query().
		Where(
			dbnoveldocument.IDEQ(documentID),
			dbnoveldocument.UserIDEQ(userID),
			dbnoveldocument.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, infraerrors.NotFound("NOVEL_DOCUMENT_NOT_FOUND", "document not found")
		}
		return nil, fmt.Errorf("novel data: verify document: %w", err)
	}

	versions, err := doc.QueryVersions().
		Order(dbent.Desc(dbnoveldocumentversion.FieldVersionNumber)).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: get document versions: %w", err)
	}
	return versions, nil
}
'''

if old_get_versions in content:
    content = content.replace(old_get_versions, '')
    print("GetDocumentVersions: removed")
else:
    print("WARNING: GetDocumentVersions not found")

# 8. Replace SaveChapter method - remove version creation
old_save_chapter = '''// SaveChapter 保存章节（创建或更新），在同一事务内写入不可变版本快照。
//
// 乐观锁：req.ExpectedVersion 非 nil 时须与当前 version 一致，否则 409 VERSION_CONFLICT。
// 版本来源：req.Source 显式指定（如 "restore"）；否则按 GenerationJobID 推断（ai_generated / manual_save）。
func (r *novelDataRepository) SaveChapter(ctx context.Context, req SaveChapterRequest) (*dbent.NovelChapter, error) {
	// 先验证项目归属
	_, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// 查找现有章节
	existing, err := r.client.NovelChapter.Query().
		Where(
			dbnovelchapter.ProjectIDEQ(req.ProjectID),
			dbnovelchapter.UserIDEQ(req.UserID),
			dbnovelchapter.ChapterNumberEQ(req.ChapterNumber),
			dbnovelchapter.DeletedAtIsNil(),
		).
		Only(ctx)

	// 推断版本来源
	source := "manual_save"
	if req.Source != nil {
		source = *req.Source
	} else if req.GenerationJobID != nil {
		source = "ai_generated"
	}

	tx, txErr := r.client.Tx(ctx)
	if txErr != nil {
		return nil, fmt.Errorf("novel data: begin tx for chapter: %w", txErr)
	}
	defer func() { _ = tx.Rollback() }()
	txClient := tx.Client()

	if dbent.IsNotFound(err) {
		// 创建新章节（version=1）
		create := txClient.NovelChapter.Create().
			SetProjectID(req.ProjectID).
			SetUserID(req.UserID).
			SetChapterNumber(req.ChapterNumber).
			SetTitle(req.Title).
			SetContent(req.Content).
			SetWordCount(req.WordCount).
			SetStatus(req.Status).
			SetVersion(1)
		if req.GenerationJobID != nil {
			create.SetGenerationJobID(*req.GenerationJobID)
		}
		chapter, err := create.Save(ctx)
		if err != nil {
			return nil, fmt.Errorf("novel data: create chapter: %w", err)
		}

		// 写入版本快照（version_number=1）
		versionCreate := txClient.NovelChapterVersion.Create().
			SetChapterID(chapter.ID).
			SetProjectID(req.ProjectID).
			SetUserID(req.UserID).
			SetVersionNumber(1).
			SetTitle(req.Title).
			SetContent(req.Content).
			SetWordCount(req.WordCount).
			SetSource(source).
			SetCreatedBy(req.UserID)
		if req.GenerationJobID != nil {
			versionCreate.SetGenerationJobID(*req.GenerationJobID)
		}
		if _, vErr := versionCreate.Save(ctx); vErr != nil {
			return nil, fmt.Errorf("novel data: create chapter version: %w", vErr)
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("novel data: commit chapter: %w", err)
		}
		return chapter, nil
	}
	if err != nil {
		return nil, fmt.Errorf("novel data: query existing chapter: %w", err)
	}

	// 乐观锁检查
	if req.ExpectedVersion != nil && *req.ExpectedVersion != existing.Version {
		return nil, infraerrors.Conflict("VERSION_CONFLICT", "章节已被他人修改，请重载服务端版本后再保存")
	}

	// 更新现有章节（version+1）
	newVersion := existing.Version + 1
	update := txClient.NovelChapter.UpdateOne(existing).
		SetTitle(req.Title).
		SetContent(req.Content).
		SetWordCount(req.WordCount).
		SetStatus(req.Status).
		SetVersion(newVersion)
	if req.GenerationJobID != nil {
		update.SetGenerationJobID(*req.GenerationJobID)
	}
	chapter, err := update.Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: update chapter: %w", err)
	}

	// 写入版本快照
	versionCreate := txClient.NovelChapterVersion.Create().
		SetChapterID(chapter.ID).
		SetProjectID(req.ProjectID).
		SetUserID(req.UserID).
		SetVersionNumber(newVersion).
		SetTitle(req.Title).
		SetContent(req.Content).
		SetWordCount(req.WordCount).
		SetSource(source).
		SetCreatedBy(req.UserID)
	if req.GenerationJobID != nil {
		versionCreate.SetGenerationJobID(*req.GenerationJobID)
	}
	if _, vErr := versionCreate.Save(ctx); vErr != nil {
		return nil, fmt.Errorf("novel data: create chapter version: %w", vErr)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("novel data: commit chapter update: %w", err)
	}
	return chapter, nil
}'''

new_save_chapter = '''// SaveChapter 保存章节（创建或更新），不再写入版本快照（版本表已弃用）。
//
// 乐观锁：req.ExpectedVersion 非 nil 时须与当前 version 一致，否则 409 VERSION_CONFLICT。
func (r *novelDataRepository) SaveChapter(ctx context.Context, req SaveChapterRequest) (*dbent.NovelChapter, error) {
	// 先验证项目归属
	_, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// 查找现有章节
	existing, err := r.client.NovelChapter.Query().
		Where(
			dbnovelchapter.ProjectIDEQ(req.ProjectID),
			dbnovelchapter.UserIDEQ(req.UserID),
			dbnovelchapter.ChapterNumberEQ(req.ChapterNumber),
			dbnovelchapter.DeletedAtIsNil(),
		).
		Only(ctx)

	tx, txErr := r.client.Tx(ctx)
	if txErr != nil {
		return nil, fmt.Errorf("novel data: begin tx for chapter: %w", txErr)
	}
	defer func() { _ = tx.Rollback() }()
	txClient := tx.Client()

	if dbent.IsNotFound(err) {
		// 创建新章节（version=1）
		create := txClient.NovelChapter.Create().
			SetProjectID(req.ProjectID).
			SetUserID(req.UserID).
			SetChapterNumber(req.ChapterNumber).
			SetTitle(req.Title).
			SetContent(req.Content).
			SetWordCount(req.WordCount).
			SetStatus(req.Status).
			SetVersion(1)
		if req.GenerationJobID != nil {
			create.SetGenerationJobID(*req.GenerationJobID)
		}
		chapter, err := create.Save(ctx)
		if err != nil {
			return nil, fmt.Errorf("novel data: create chapter: %w", err)
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("novel data: commit chapter: %w", err)
		}
		return chapter, nil
	}
	if err != nil {
		return nil, fmt.Errorf("novel data: query existing chapter: %w", err)
	}

	// 乐观锁检查
	if req.ExpectedVersion != nil && *req.ExpectedVersion != existing.Version {
		return nil, infraerrors.Conflict("VERSION_CONFLICT", "章节已被他人修改，请重载服务端版本后再保存")
	}

	// 更新现有章节（version+1）
	newVersion := existing.Version + 1
	update := txClient.NovelChapter.UpdateOne(existing).
		SetTitle(req.Title).
		SetContent(req.Content).
		SetWordCount(req.WordCount).
		SetStatus(req.Status).
		SetVersion(newVersion)
	if req.GenerationJobID != nil {
		update.SetGenerationJobID(*req.GenerationJobID)
	}
	chapter, err := update.Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: update chapter: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("novel data: commit chapter update: %w", err)
	}
	return chapter, nil
}'''

if old_save_chapter in content:
    content = content.replace(old_save_chapter, new_save_chapter)
    print("SaveChapter: replaced")
else:
    print("WARNING: SaveChapter old block not found")

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()
has_version = bool(re.search(r'NovelDocumentVersion\.Create|NovelChapterVersion\.Create|dbnoveldocumentversion', verify))
print(f"novel_data_service.go: version creation refs present = {has_version}")

# ========== novel.go ==========
path = r'd:\CODE\sub2api\backend\internal\server\routes\novel.go'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove version routes
content = re.sub(r'\s*projects\.GET\("/:id/documents/:type/versions", h\.ListDocumentVersions\)\n', '\n', content)
content = re.sub(r'\s*projects\.POST\("/:id/documents/:type/versions/:version/restore", h\.RestoreDocumentVersion\)\n', '\n', content)
content = re.sub(r'\s*projects\.GET\("/:id/chapters/:number/versions", h\.ListChapterVersions\)\n', '\n', content)
content = re.sub(r'\s*projects\.POST\("/:id/chapters/:number/versions/:version/restore", h\.RestoreChapterVersion\)\n', '\n', content)

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()
has_routes = bool(re.search(r'versions', verify, re.IGNORECASE))
print(f"novel.go: version routes present = {has_routes}")

print("\nAll backend files modified.")
