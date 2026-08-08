#!/usr/bin/env python3
"""Restore version method declarations in NovelDataRepository interface to avoid compile errors."""

path = r'd:\CODE\sub2api\backend\internal\service\novel_data_service.go'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the interface block and add version methods back
# The interface has "GetDocument(ctx ...)" method, add version methods after it
old_iface = '''	GetDocument(ctx context.Context, userID, projectID int64, docType string) (*dbent.NovelDocument, error)
	ListDocuments(ctx context.Context, userID, projectID int64) ([]*dbent.NovelDocument, error)
	SaveDocument(ctx context.Context, req SaveDocumentRequest) (*dbent.NovelDocument, error)'''

new_iface = '''	GetDocument(ctx context.Context, userID, projectID int64, docType string) (*dbent.NovelDocument, error)
	ListDocuments(ctx context.Context, userID, projectID int64) ([]*dbent.NovelDocument, error)
	SaveDocument(ctx context.Context, req SaveDocumentRequest) (*dbent.NovelDocument, error)
	GetDocumentVersions(ctx context.Context, userID, documentID int64) ([]*dbent.NovelDocumentVersion, error)
	GetDocumentVersion(ctx context.Context, userID, documentID int64, versionNumber int) (*dbent.NovelDocumentVersion, error)'''

if old_iface in content:
    content = content.replace(old_iface, new_iface)
    print("Interface: document version methods restored")
else:
    print("WARNING: interface block not found")

# Add chapter version methods after ListChapters
old_chapter_iface = '''	ListChapters(ctx context.Context, userID, projectID int64) ([]*dbent.NovelChapter, error)'''

new_chapter_iface = '''	ListChapters(ctx context.Context, userID, projectID int64) ([]*dbent.NovelChapter, error)
	ListChapterVersions(ctx context.Context, userID, chapterID int64) ([]*dbent.NovelChapterVersion, error)
	GetChapterVersion(ctx context.Context, userID, chapterID int64, versionNumber int) (*dbent.NovelChapterVersion, error)'''

if old_chapter_iface in content:
    content = content.replace(old_chapter_iface, new_chapter_iface, 1)
    print("Interface: chapter version methods restored")
else:
    print("WARNING: chapter interface block not found")

# Restore dbnoveldocumentversion import (needed by GetDocumentVersions in novel_chapter_version_service.go)
if 'dbnoveldocumentversion' not in content:
    content = content.replace(
        '\tdbnoveldocument "github.com/Wei-Shaw/sub2api/ent/noveldocument"\n',
        '\tdbnoveldocument "github.com/Wei-Shaw/sub2api/ent/noveldocument"\n\tdbnoveldocumentversion "github.com/Wei-Shaw/sub2api/ent/noveldocumentversion"\n'
    )
    print("Import: dbnoveldocumentversion restored")

# Restore GetDocumentVersions repository implementation
# (was removed earlier; novel_chapter_version_service.go's NovelDataService.GetDocumentVersions calls s.repo.GetDocumentVersions)
get_doc_versions_impl = '''
// GetDocumentVersions 获取文档版本历史。
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

# Check if already exists
if 'func (r *novelDataRepository) GetDocumentVersions' not in content:
    # Add before GetChapter method
    content = content.replace(
        '// GetChapter 获取章节（强制租户隔离）。',
        get_doc_versions_impl + '\n// GetChapter 获取章节（强制租户隔离）。',
        1
    )
    print("GetDocumentVersions: implementation restored")
else:
    print("GetDocumentVersions: already exists")

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()

has_iface = 'GetDocumentVersions(ctx context.Context, userID, documentID int64) ([]*dbent.NovelDocumentVersion, error)' in verify
has_impl = 'func (r *novelDataRepository) GetDocumentVersions' in verify
has_import = 'dbnoveldocumentversion' in verify
print(f"Interface has GetDocumentVersions: {has_iface}")
print(f"Implementation exists: {has_impl}")
print(f"Import exists: {has_import}")
