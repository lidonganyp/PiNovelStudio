// Package service - 小说数据服务（PINOVEL-SUB2API-INTEGRATION-1 §4 T4-2/T4-3）
//
// 本文件定义小说项目、文档和章节的 CRUD 服务接口与实现。
// 所有操作强制附加 userId 实现租户隔离（T4-3），禁止跨用户访问。
//
// 文档保存自动创建版本记录（NovelDocumentVersion），支持版本回溯。
// 章节保存为原子操作，generation_job_id 为字符串软引用。
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/domain"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	dbnovelchapter "github.com/Wei-Shaw/sub2api/ent/novelchapter"
	dbnoveldocument "github.com/Wei-Shaw/sub2api/ent/noveldocument"
	dbnoveldocumentversion "github.com/Wei-Shaw/sub2api/ent/noveldocumentversion"
	dbnovelproject "github.com/Wei-Shaw/sub2api/ent/novelproject"
)

// ---------------------------------------------------------------------------
// 请求/响应类型
// ---------------------------------------------------------------------------

// CreateProjectRequest 创建小说项目请求。
type CreateProjectRequest struct {
	UserID        int64
	Title         string
	Description   string
	Genre         string
	SubGenres     []string
	WorldKeyTerms []string
}

// UpdateProjectRequest 更新小说项目请求。
type UpdateProjectRequest struct {
	UserID      int64
	ProjectID   int64
	Title       *string
	Description *string
	Genre       *string
	SubGenres   []string
	Status      *string
}

// SaveDocumentRequest 保存文档请求（自动创建版本）。
//
// ExpectedVersion 用于乐观锁：非 nil 时须与当前 CurrentVersion 一致，否则 409 VERSION_CONFLICT。
type SaveDocumentRequest struct {
	UserID          int64
	ProjectID       int64
	DocumentType    string
	Title           string
	Content         string
	ExpectedVersion *int
}

// SaveChapterRequest 保存章节请求。
//
// ExpectedVersion 用于乐观锁：非 nil 时须与当前 version 一致，否则 409 VERSION_CONFLICT。
// Source 显式指定版本来源（如 "restore"）；为 nil 时按 GenerationJobID 推断（ai_generated / manual_save）。
type SaveChapterRequest struct {
	UserID           int64
	ProjectID        int64
	ChapterNumber    int
	Title            string
	Content          string
	WordCount        int
	Status           string
	GenerationJobID  *string
	ExpectedVersion  *int
	Source           *string
}

// CreateFeedbackRequest 创建反馈请求。
type CreateFeedbackRequest struct {
	UserID       int64
	ProjectID    int64
	ChapterID    *int64
	FeedbackType string
	Rating       int
	Content      string
}

// ProjectDTO 面向用户的小说项目 DTO（脱敏，不含内部字段）。
// P0-5（第二轮 P0 修复）：json tag 对齐前端 snake_case 契约；新增 chapter_count。
type ProjectDTO struct {
	ID            int64      `json:"id"`
	Title         string     `json:"title"`
	Description   string     `json:"description"`
	Genre         string     `json:"genre"`
	SubGenres     []string   `json:"sub_genres"`
	WorldKeyTerms []string   `json:"world_key_terms,omitempty"`
	Status        string     `json:"status"`
	ChapterCount  int        `json:"chapter_count"`
	CoverURL      string     `json:"cover_url,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	LastActiveAt  *time.Time `json:"last_active_at,omitempty"`
}

// DocumentDTO 面向用户的文档 DTO。
// P0-5：json tag 对齐前端 snake_case 契约。
type DocumentDTO struct {
	ID             int64     `json:"id"`
	ProjectID      int64     `json:"project_id"`
	DocumentType   string    `json:"type"`
	Title          string    `json:"title"`
	Content        string    `json:"content"`
	CurrentVersion int       `json:"version"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// ChapterDTO 面向用户的章节 DTO（metadata 字段不暴露给用户）。
// P0-5：json tag 对齐前端 snake_case 契约。
type ChapterDTO struct {
	ID            int64     `json:"id"`
	ProjectID     int64     `json:"project_id"`
	ChapterNumber int       `json:"chapter_number"`
	Title         string    `json:"title"`
	Content       string    `json:"content"`
	WordCount     int       `json:"word_count"`
	Status        string    `json:"status"`
	Version       int       `json:"version"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// ChapterListItemDTO 章节列表项（不含正文内容，减少传输量）。
// P0-5：json tag 对齐前端 snake_case 契约。
type ChapterListItemDTO struct {
	ID            int64     `json:"id"`
	ChapterNumber int       `json:"chapter_number"`
	Title         string    `json:"title"`
	WordCount     int       `json:"word_count"`
	Status        string    `json:"status"`
	Version       int       `json:"version"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// FeedbackDTO 面向用户的反馈 DTO。
// P0-5：json tag 对齐前端契约（feedbackType→type，content→comment）。
type FeedbackDTO struct {
	ID               int64      `json:"id"`
	ProjectID        int64      `json:"project_id"`
	ChapterID       *int64     `json:"chapter_id,omitempty"`
	FeedbackType     string     `json:"type"`
	Rating           int        `json:"rating"`
	Content          string     `json:"comment"`
	AdminResponse    string     `json:"admin_response,omitempty"`
	AdminRespondedAt *time.Time `json:"admin_responded_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

// ---------------------------------------------------------------------------
// 仓储接口
// ---------------------------------------------------------------------------

// NovelDataRepository 小说数据访问接口。
type NovelDataRepository interface {
	// 项目 CRUD
	CreateProject(ctx context.Context, req CreateProjectRequest) (*dbent.NovelProject, error)
	GetProject(ctx context.Context, userID, projectID int64) (*dbent.NovelProject, error)
	ListProjects(ctx context.Context, userID int64, offset, limit int) ([]*dbent.NovelProject, int, error)
	UpdateProject(ctx context.Context, req UpdateProjectRequest) (*dbent.NovelProject, error)
	DeleteProject(ctx context.Context, userID, projectID int64) error

	// 文档 CRUD（带版本控制）
	GetDocument(ctx context.Context, userID, projectID int64, docType string) (*dbent.NovelDocument, error)
	ListDocuments(ctx context.Context, userID, projectID int64) ([]*dbent.NovelDocument, error)
	SaveDocument(ctx context.Context, req SaveDocumentRequest) (*dbent.NovelDocument, error)
	GetDocumentVersions(ctx context.Context, userID, documentID int64) ([]*dbent.NovelDocumentVersion, error)
	GetDocumentVersion(ctx context.Context, userID, documentID int64, versionNumber int) (*dbent.NovelDocumentVersion, error)

	// 章节 CRUD
	GetChapter(ctx context.Context, userID, projectID int64, chapterNumber int) (*dbent.NovelChapter, error)
	ListChapters(ctx context.Context, userID, projectID int64) ([]*dbent.NovelChapter, error)
	SaveChapter(ctx context.Context, req SaveChapterRequest) (*dbent.NovelChapter, error)
	// 章节版本历史（B1）
	ListChapterVersions(ctx context.Context, userID, chapterID int64) ([]*dbent.NovelChapterVersion, error)
	GetChapterVersion(ctx context.Context, userID, chapterID int64, versionNumber int) (*dbent.NovelChapterVersion, error)
	// P0-5：项目章节计数（填充 ProjectDTO.ChapterCount）
	CountChapters(ctx context.Context, userID, projectID int64) (int, error)

	// 反馈
	CreateFeedback(ctx context.Context, req CreateFeedbackRequest) (*dbent.NovelFeedback, error)

	// 角色 CRUD（B2 T2）
	CreateCharacter(ctx context.Context, req CreateCharacterRequest) (*dbent.NovelCharacter, error)
	ListCharacters(ctx context.Context, userID, projectID int64) ([]*dbent.NovelCharacter, error)
	GetCharacter(ctx context.Context, userID, projectID, characterID int64) (*dbent.NovelCharacter, error)
	UpdateCharacter(ctx context.Context, req UpdateCharacterRequest) (*dbent.NovelCharacter, error)
	DeleteCharacter(ctx context.Context, userID, projectID, characterID int64) error
	ReorderCharacters(ctx context.Context, req ReorderCharactersRequest) error
	CountCharacters(ctx context.Context, userID, projectID int64) (int, error)

	// 大纲节点 CRUD（B2 T2）
	CreateOutlineNode(ctx context.Context, req CreateOutlineNodeRequest) (*dbent.NovelOutlineNode, error)
	ListOutlineNodes(ctx context.Context, userID, projectID int64) ([]*dbent.NovelOutlineNode, error)
	GetOutlineNode(ctx context.Context, userID, projectID, nodeID int64) (*dbent.NovelOutlineNode, error)
	UpdateOutlineNode(ctx context.Context, req UpdateOutlineNodeRequest) (*dbent.NovelOutlineNode, error)
	DeleteOutlineNode(ctx context.Context, userID, projectID, nodeID int64) error
	MoveOutlineNode(ctx context.Context, req MoveOutlineNodeRequest) (*dbent.NovelOutlineNode, error)
	ReorderOutlineNodes(ctx context.Context, req ReorderOutlineNodesRequest) error
	CountOutlineNodes(ctx context.Context, userID, projectID int64) (int, error)

	// 章节种子 CRUD（B2 T2）
	GetChapterSeed(ctx context.Context, userID, projectID int64, chapterNumber int) (*dbent.NovelChapterSeed, error)
	CreateChapterSeed(ctx context.Context, req CreateChapterSeedRequest) (*dbent.NovelChapterSeed, error)
	UpdateChapterSeed(ctx context.Context, req UpdateChapterSeedRequest) (*dbent.NovelChapterSeed, error)
	DeleteChapterSeed(ctx context.Context, userID, projectID int64, chapterNumber int) error
	CountChapterSeeds(ctx context.Context, userID, projectID int64) (int, error)
}

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

// NovelDataService 小说数据服务。
// 封装项目、文档、章节和反馈的业务逻辑，强制租户隔离。
type NovelDataService struct {
	repo NovelDataRepository
}

// NewNovelDataService 构造小说数据服务。
func NewNovelDataService(repo NovelDataRepository) *NovelDataService {
	return &NovelDataService{repo: repo}
}

// CreateProject 创建小说项目。
func (s *NovelDataService) CreateProject(ctx context.Context, req CreateProjectRequest) (*ProjectDTO, error) {
	if req.UserID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_USER", "user_id is required")
	}
	if req.Title == "" {
		return nil, infraerrors.BadRequest("INVALID_TITLE", "title is required")
	}

	project, err := s.repo.CreateProject(ctx, req)
	if err != nil {
		return nil, err
	}
	return projectToDTO(project), nil
}

// GetProject 获取小说项目（强制租户隔离）。
func (s *NovelDataService) GetProject(ctx context.Context, userID, projectID int64) (*ProjectDTO, error) {
	if userID <= 0 || projectID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_ID", "user_id and project_id are required")
	}
	project, err := s.repo.GetProject(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	dto := projectToDTO(project)
	// P0-5：填充 chapter_count（best-effort，查询失败不阻断）
	if count, cerr := s.repo.CountChapters(ctx, userID, projectID); cerr == nil {
		dto.ChapterCount = count
	}
	return dto, nil
}

// ListProjects 列出用户的小说项目。
func (s *NovelDataService) ListProjects(ctx context.Context, userID int64, page, pageSize int) ([]*ProjectDTO, int, error) {
	if userID <= 0 {
		return nil, 0, infraerrors.BadRequest("INVALID_USER", "user_id is required")
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	projects, total, err := s.repo.ListProjects(ctx, userID, offset, pageSize)
	if err != nil {
		return nil, 0, err
	}

	dtos := make([]*ProjectDTO, len(projects))
	for i, p := range projects {
		dto := projectToDTO(p)
		// P0-5：填充 chapter_count（best-effort）
		if count, cerr := s.repo.CountChapters(ctx, userID, p.ID); cerr == nil {
			dto.ChapterCount = count
		}
		dtos[i] = dto
	}
	return dtos, total, nil
}

// UpdateProject 更新小说项目。
func (s *NovelDataService) UpdateProject(ctx context.Context, req UpdateProjectRequest) (*ProjectDTO, error) {
	if req.UserID <= 0 || req.ProjectID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_ID", "user_id and project_id are required")
	}
	if req.Status != nil && *req.Status != domain.NovelProjectStatusActive && *req.Status != domain.NovelProjectStatusArchived {
		return nil, infraerrors.BadRequest("INVALID_STATUS", "status must be active or archived")
	}

	project, err := s.repo.UpdateProject(ctx, req)
	if err != nil {
		return nil, err
	}
	dto := projectToDTO(project)
	// P0-5：填充 chapter_count（best-effort）
	if count, cerr := s.repo.CountChapters(ctx, req.UserID, req.ProjectID); cerr == nil {
		dto.ChapterCount = count
	}
	return dto, nil
}

// DeleteProject 软删除小说项目。
func (s *NovelDataService) DeleteProject(ctx context.Context, userID, projectID int64) error {
	if userID <= 0 || projectID <= 0 {
		return infraerrors.BadRequest("INVALID_ID", "user_id and project_id are required")
	}
	return s.repo.DeleteProject(ctx, userID, projectID)
}

// GetDocument 获取文档（强制租户隔离）。
func (s *NovelDataService) GetDocument(ctx context.Context, userID, projectID int64, docType string) (*DocumentDTO, error) {
	if !domain.IsValidNovelDocumentType(docType) {
		return nil, infraerrors.BadRequest("INVALID_DOC_TYPE", "invalid document type")
	}
	doc, err := s.repo.GetDocument(ctx, userID, projectID, docType)
	if err != nil {
		return nil, err
	}
	return documentToDTO(doc), nil
}

// ListDocuments 列出项目的所有文档。
func (s *NovelDataService) ListDocuments(ctx context.Context, userID, projectID int64) ([]*DocumentDTO, error) {
	docs, err := s.repo.ListDocuments(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	dtos := make([]*DocumentDTO, len(docs))
	for i, d := range docs {
		dtos[i] = documentToDTO(d)
	}
	return dtos, nil
}

// SaveDocument 保存文档（自动创建版本记录）。
func (s *NovelDataService) SaveDocument(ctx context.Context, req SaveDocumentRequest) (*DocumentDTO, error) {
	if req.UserID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_USER", "user_id is required")
	}
	if req.ProjectID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_PROJECT", "project_id is required")
	}
	if !domain.IsValidNovelDocumentType(req.DocumentType) {
		return nil, infraerrors.BadRequest("INVALID_DOC_TYPE", "invalid document type")
	}
	if req.Title == "" {
		return nil, infraerrors.BadRequest("INVALID_TITLE", "title is required")
	}

	doc, err := s.repo.SaveDocument(ctx, req)
	if err != nil {
		return nil, err
	}
	return documentToDTO(doc), nil
}

// GetDocumentVersions 获取文档版本历史。
func (s *NovelDataService) GetDocumentVersions(ctx context.Context, userID, documentID int64) ([]*dbent.NovelDocumentVersion, error) {
	return s.repo.GetDocumentVersions(ctx, userID, documentID)
}

// GetChapter 获取章节（强制租户隔离）。
func (s *NovelDataService) GetChapter(ctx context.Context, userID, projectID int64, chapterNumber int) (*ChapterDTO, error) {
	if userID <= 0 || projectID <= 0 || chapterNumber < 1 {
		return nil, infraerrors.BadRequest("INVALID_REQUEST", "invalid parameters")
	}
	chapter, err := s.repo.GetChapter(ctx, userID, projectID, chapterNumber)
	if err != nil {
		return nil, err
	}
	return chapterToDTO(chapter), nil
}

// ListChapters 列出项目的所有章节（不含正文内容）。
func (s *NovelDataService) ListChapters(ctx context.Context, userID, projectID int64) ([]*ChapterListItemDTO, error) {
	chapters, err := s.repo.ListChapters(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	dtos := make([]*ChapterListItemDTO, len(chapters))
	for i, c := range chapters {
		dtos[i] = &ChapterListItemDTO{
			ID:            c.ID,
			ChapterNumber: c.ChapterNumber,
			Title:         c.Title,
			WordCount:     c.WordCount,
			Status:        c.Status,
			Version:       c.Version,
			UpdatedAt:     c.UpdatedAt,
		}
	}
	return dtos, nil
}

// SaveChapter 保存章节。
func (s *NovelDataService) SaveChapter(ctx context.Context, req SaveChapterRequest) (*ChapterDTO, error) {
	if req.UserID <= 0 || req.ProjectID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_REQUEST", "user_id and project_id are required")
	}
	if req.ChapterNumber < 1 {
		return nil, infraerrors.BadRequest("INVALID_CHAPTER", "chapter_number must be >= 1")
	}
	if req.Status == "" {
		req.Status = domain.NovelChapterStatusDraft
	}

	chapter, err := s.repo.SaveChapter(ctx, req)
	if err != nil {
		return nil, err
	}
	return chapterToDTO(chapter), nil
}

// CreateFeedback 创建用户反馈。
func (s *NovelDataService) CreateFeedback(ctx context.Context, req CreateFeedbackRequest) (*FeedbackDTO, error) {
	if req.UserID <= 0 || req.ProjectID <= 0 {
		return nil, infraerrors.BadRequest("INVALID_REQUEST", "user_id and project_id are required")
	}
	if !domain.IsValidNovelFeedbackType(req.FeedbackType) {
		return nil, infraerrors.BadRequest("INVALID_FEEDBACK_TYPE", "invalid feedback type")
	}
	if req.Rating < 0 || req.Rating > 5 {
		return nil, infraerrors.BadRequest("INVALID_RATING", "rating must be 0-5")
	}

	fb, err := s.repo.CreateFeedback(ctx, req)
	if err != nil {
		return nil, err
	}
	return feedbackToDTO(fb), nil
}

// ---------------------------------------------------------------------------
// 仓储实现
// ---------------------------------------------------------------------------

// novelDataRepository 小说数据仓储实现。
type novelDataRepository struct {
	client *dbent.Client
}

// NewNovelDataRepository 构造小说数据仓储。
func NewNovelDataRepository(client *dbent.Client) NovelDataRepository {
	return &novelDataRepository{client: client}
}

// CreateProject 创建小说项目。
func (r *novelDataRepository) CreateProject(ctx context.Context, req CreateProjectRequest) (*dbent.NovelProject, error) {
	now := time.Now()
	project, err := r.client.NovelProject.Create().
		SetUserID(req.UserID).
		SetTitle(req.Title).
		SetDescription(req.Description).
		SetGenre(req.Genre).
		SetSubGenres(req.SubGenres).
		SetWorldKeyTerms(req.WorldKeyTerms).
		SetStatus(domain.NovelProjectStatusActive).
		SetLastActiveAt(now).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: create project: %w", err)
	}
	return project, nil
}

// GetProject 获取小说项目（强制租户隔离）。
func (r *novelDataRepository) GetProject(ctx context.Context, userID, projectID int64) (*dbent.NovelProject, error) {
	project, err := r.client.NovelProject.Query().
		Where(
			dbnovelproject.IDEQ(projectID),
			dbnovelproject.UserIDEQ(userID),
			dbnovelproject.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, infraerrors.NotFound("NOVEL_PROJECT_NOT_FOUND", "project not found")
		}
		return nil, fmt.Errorf("novel data: get project: %w", err)
	}
	return project, nil
}

// ListProjects 列出用户的小说项目。
func (r *novelDataRepository) ListProjects(ctx context.Context, userID int64, offset, limit int) ([]*dbent.NovelProject, int, error) {
	query := r.client.NovelProject.Query().
		Where(
			dbnovelproject.UserIDEQ(userID),
			dbnovelproject.DeletedAtIsNil(),
		)

	total, err := query.Clone().Count(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("novel data: count projects: %w", err)
	}

	projects, err := query.
		Order(dbent.Desc(dbnovelproject.FieldLastActiveAt)).
		Offset(offset).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("novel data: list projects: %w", err)
	}
	return projects, total, nil
}

// UpdateProject 更新小说项目。
func (r *novelDataRepository) UpdateProject(ctx context.Context, req UpdateProjectRequest) (*dbent.NovelProject, error) {
	// 先验证项目归属
	existing, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	update := r.client.NovelProject.UpdateOne(existing).
		SetLastActiveAt(time.Now())

	if req.Title != nil {
		update.SetTitle(*req.Title)
	}
	if req.Description != nil {
		update.SetDescription(*req.Description)
	}
	if req.Genre != nil {
		update.SetGenre(*req.Genre)
	}
	if req.SubGenres != nil {
		update.SetSubGenres(req.SubGenres)
	}
	if req.Status != nil {
		update.SetStatus(*req.Status)
	}

	project, err := update.Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: update project: %w", err)
	}
	return project, nil
}

// DeleteProject 软删除小说项目。
func (r *novelDataRepository) DeleteProject(ctx context.Context, userID, projectID int64) error {
	// 先验证项目归属
	_, err := r.GetProject(ctx, userID, projectID)
	if err != nil {
		return err
	}

	n, err := r.client.NovelProject.Delete().
		Where(
			dbnovelproject.IDEQ(projectID),
			dbnovelproject.UserIDEQ(userID),
		).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("novel data: delete project: %w", err)
	}
	if n == 0 {
		return infraerrors.NotFound("NOVEL_PROJECT_NOT_FOUND", "project not found")
	}
	return nil
}

// GetDocument 获取文档（强制租户隔离）。
func (r *novelDataRepository) GetDocument(ctx context.Context, userID, projectID int64, docType string) (*dbent.NovelDocument, error) {
	doc, err := r.client.NovelDocument.Query().
		Where(
			dbnoveldocument.ProjectIDEQ(projectID),
			dbnoveldocument.UserIDEQ(userID),
			dbnoveldocument.DocumentTypeEQ(docType),
			dbnoveldocument.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, infraerrors.NotFound("NOVEL_DOCUMENT_NOT_FOUND", "document not found")
		}
		return nil, fmt.Errorf("novel data: get document: %w", err)
	}
	return doc, nil
}

// ListDocuments 列出项目的所有文档。
func (r *novelDataRepository) ListDocuments(ctx context.Context, userID, projectID int64) ([]*dbent.NovelDocument, error) {
	docs, err := r.client.NovelDocument.Query().
		Where(
			dbnoveldocument.ProjectIDEQ(projectID),
			dbnoveldocument.UserIDEQ(userID),
			dbnoveldocument.DeletedAtIsNil(),
		).
		Order(dbent.Asc(dbnoveldocument.FieldDocumentType)).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: list documents: %w", err)
	}
	return docs, nil
}

// SaveDocument 保存文档（不再写入版本历史，版本表已弃用）。
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
}

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

// GetChapter 获取章节（强制租户隔离）。
func (r *novelDataRepository) GetChapter(ctx context.Context, userID, projectID int64, chapterNumber int) (*dbent.NovelChapter, error) {
	chapter, err := r.client.NovelChapter.Query().
		Where(
			dbnovelchapter.ProjectIDEQ(projectID),
			dbnovelchapter.UserIDEQ(userID),
			dbnovelchapter.ChapterNumberEQ(chapterNumber),
			dbnovelchapter.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, infraerrors.NotFound("NOVEL_CHAPTER_NOT_FOUND", "chapter not found")
		}
		return nil, fmt.Errorf("novel data: get chapter: %w", err)
	}
	return chapter, nil
}

// ListChapters 列出项目的所有章节（不含正文内容）。
func (r *novelDataRepository) ListChapters(ctx context.Context, userID, projectID int64) ([]*dbent.NovelChapter, error) {
	chapters, err := r.client.NovelChapter.Query().
		Where(
			dbnovelchapter.ProjectIDEQ(projectID),
			dbnovelchapter.UserIDEQ(userID),
			dbnovelchapter.DeletedAtIsNil(),
		).
		Order(dbent.Asc(dbnovelchapter.FieldChapterNumber)).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: list chapters: %w", err)
	}
	return chapters, nil
}

// CountChapters 统计项目的章节数（强制租户隔离，P0-5 填充 ProjectDTO.ChapterCount）。
func (r *novelDataRepository) CountChapters(ctx context.Context, userID, projectID int64) (int, error) {
	count, err := r.client.NovelChapter.Query().
		Where(
			dbnovelchapter.ProjectIDEQ(projectID),
			dbnovelchapter.UserIDEQ(userID),
			dbnovelchapter.DeletedAtIsNil(),
		).
		Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("novel data: count chapters: %w", err)
	}
	return count, nil
}

// SaveChapter 保存章节（创建或更新），不再写入版本快照（版本表已弃用）。
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
		).Only(ctx)

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
}

// CreateFeedback 创建用户反馈。
func (r *novelDataRepository) CreateFeedback(ctx context.Context, req CreateFeedbackRequest) (*dbent.NovelFeedback, error) {
	// 先验证项目归属
	_, err := r.GetProject(ctx, req.UserID, req.ProjectID)
	if err != nil {
		return nil, err
	}

	create := r.client.NovelFeedback.Create().
		SetProjectID(req.ProjectID).
		SetUserID(req.UserID).
		SetFeedbackType(req.FeedbackType).
		SetRating(req.Rating).
		SetContent(req.Content)
	if req.ChapterID != nil {
		create.SetChapterID(*req.ChapterID)
	}

	fb, err := create.Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("novel data: create feedback: %w", err)
	}
	return fb, nil
}

// ---------------------------------------------------------------------------
// DTO 转换辅助函数
// ---------------------------------------------------------------------------

func projectToDTO(p *dbent.NovelProject) *ProjectDTO {
	dto := &ProjectDTO{
		ID:          p.ID,
		Title:       p.Title,
		Description: p.Description,
		Genre:       p.Genre,
		Status:      p.Status,
		CoverURL:    p.CoverURL,
		CreatedAt:   p.CreatedAt,
		UpdatedAt:   p.UpdatedAt,
	}
	if p.SubGenres != nil {
		dto.SubGenres = p.SubGenres
	}
	if p.WorldKeyTerms != nil {
		dto.WorldKeyTerms = p.WorldKeyTerms
	}
	if p.LastActiveAt != nil {
		dto.LastActiveAt = p.LastActiveAt
	}
	return dto
}

func documentToDTO(d *dbent.NovelDocument) *DocumentDTO {
	return &DocumentDTO{
		ID:             d.ID,
		ProjectID:      d.ProjectID,
		DocumentType:   d.DocumentType,
		Title:          d.Title,
		Content:        d.Content,
		CurrentVersion: d.CurrentVersion,
		CreatedAt:      d.CreatedAt,
		UpdatedAt:      d.UpdatedAt,
	}
}

func chapterToDTO(c *dbent.NovelChapter) *ChapterDTO {
	return &ChapterDTO{
		ID:            c.ID,
		ProjectID:     c.ProjectID,
		ChapterNumber: c.ChapterNumber,
		Title:         c.Title,
		Content:       c.Content,
		WordCount:     c.WordCount,
		Status:        c.Status,
		Version:       c.Version,
		CreatedAt:     c.CreatedAt,
		UpdatedAt:     c.UpdatedAt,
	}
}

func feedbackToDTO(f *dbent.NovelFeedback) *FeedbackDTO {
	dto := &FeedbackDTO{
		ID:           f.ID,
		ProjectID:    f.ProjectID,
		FeedbackType: f.FeedbackType,
		Rating:       f.Rating,
		Content:      f.Content,
		AdminResponse: f.AdminResponse,
		CreatedAt:    f.CreatedAt,
	}
	if f.ChapterID != nil {
		dto.ChapterID = f.ChapterID
	}
	if f.AdminRespondedAt != nil {
		dto.AdminRespondedAt = f.AdminRespondedAt
	}
	return dto
}

