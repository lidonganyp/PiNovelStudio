// Package routes - 小说功能路由注册（PINOVEL-SUB2API-INTEGRATION-1 §2/§7）
//
// 注册小说任务令牌签发路由与项目/文档/章节/反馈 CRUD 路由。
// 所有小说路由都需要 JWT 认证（jwtAuth）与审计日志（auditLog）。
// 用户身份由 jwtAuth 中间件注入 AuthSubject，handler 通过 GetAuthSubjectFromContext 读取。
//
// 路由前缀：/api/v1/novel
package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// RegisterNovelRoutes 注册小说相关路由。
//
// Phase 2: 任务令牌签发（POST /novel/tasks/token）
// Phase 4/7: 项目 CRUD、文档保存/读取、章节列表/详情、用户反馈
// P0-1: 生成编排 API（estimate/create/get/cancel/SSE）+ 内部结算回调
func RegisterNovelRoutes(
	v1 *gin.RouterGroup,
	h *handler.NovelHandler,
	jwtAuth middleware.JWTAuthMiddleware,
	auditLog middleware.AuditLogMiddleware,
) {
	authenticated := v1.Group("")
	authenticated.Use(gin.HandlerFunc(jwtAuth))
	authenticated.Use(gin.HandlerFunc(auditLog))

	novel := authenticated.Group("/novel")
	{
		// 签发短期任务令牌（供 Novel Runtime 验证）
		novel.POST("/tasks/token", h.IssueTaskToken)
	}

	projects := novel.Group("/projects")
	{
		// 项目 CRUD
		projects.POST("", h.CreateProject)
		projects.GET("", h.ListProjects)
		projects.GET("/:id", h.GetProject)
		projects.PUT("/:id", h.UpdateProject)
		projects.DELETE("/:id", h.DeleteProject)

		// 文档（按类型存取：creative_constitution / worldbuilding / character_profile /
		// story_outline / style_profile / chapter_seed / narrative_state）
		projects.PUT("/:id/documents/:type", h.SaveDocument)
		projects.GET("/:id/documents/:type", h.GetDocument)
		projects.GET("/:id/documents", h.ListDocuments)

		// 章节
		projects.GET("/:id/chapters", h.ListChapters)
		projects.GET("/:id/chapters/:number", h.GetChapter)
		// 章节手工保存
		projects.PUT("/:id/chapters/:number", h.SaveChapter)

		// 用户反馈
		projects.POST("/:id/feedback", h.CreateFeedback)
		projects.POST("/:id/outline/plan", h.PlanOutline)

		// §3 工作流状态机：获取状态 / 确认大纲 / 撤销确认
		projects.GET("/:id/workflow", h.GetWorkflow)
		projects.POST("/:id/outline/confirm", h.ConfirmOutline)
		projects.DELETE("/:id/outline/confirmation", h.RevokeConfirmation)

		// §4 PI 创作助手：对话 / 估价 / 历史
		projects.GET("/:id/assistant/messages", h.ListAssistantMessages)
		projects.GET("/:id/assistant/estimate", h.EstimateAssistant)
		projects.POST("/:id/assistant/messages", h.SendAssistantMessage)

		// 角色 CRUD + 排序（B2 T2）
		projects.POST("/:id/characters", h.CreateCharacter)
		projects.GET("/:id/characters", h.ListCharacters)
		projects.GET("/:id/characters/:characterId", h.GetCharacter)
		projects.PUT("/:id/characters/:characterId", h.UpdateCharacter)
		projects.DELETE("/:id/characters/:characterId", h.DeleteCharacter)
		projects.PUT("/:id/characters/_reorder", h.ReorderCharacters)

		// 大纲节点 CRUD + 移动 + 排序（B2 T2）
		projects.POST("/:id/outline-nodes", h.CreateOutlineNode)
		projects.GET("/:id/outline-nodes", h.ListOutlineNodes)
		projects.PUT("/:id/outline-nodes/:nodeId", h.UpdateOutlineNode)
		projects.DELETE("/:id/outline-nodes/:nodeId", h.DeleteOutlineNode)
		projects.PATCH("/:id/outline-nodes/:nodeId/move", h.MoveOutlineNode)
		projects.PUT("/:id/outline-nodes/_reorder", h.ReorderOutlineNodes)

		// ChapterSeed 按章节 CRUD（B2 T2）
		projects.GET("/:id/chapter-seeds/:chapterNumber", h.GetChapterSeed)
		projects.POST("/:id/chapter-seeds/:chapterNumber", h.CreateChapterSeed)
		projects.PUT("/:id/chapter-seeds/:chapterNumber", h.UpdateChapterSeed)
		projects.DELETE("/:id/chapter-seeds/:chapterNumber", h.DeleteChapterSeed)

		// 结构化数据迁移（B2 T2）
		projects.POST("/:id/structured-data/migrate", h.MigrateStructuredData)
	}

	// P0-1: 生成编排 API（plan §7）——JWT 保护，用户只能操作自己的任务
	generations := novel.Group("/generations")
	{
		generations.GET("", h.ListGenerations) // B4 T6: 生成任务列表
			generations.POST("/estimate", h.EstimateGeneration)
		generations.POST("", h.CreateGeneration)
		generations.GET("/:jobId", h.GetGeneration)
		generations.POST("/:jobId/cancel", h.CancelGeneration)
		generations.GET("/:jobId/events", h.SubscribeGenerationEvents)
	}

	// B4 T6: 消费记录——脱敏聚合账单
	billing := novel.Group("/billing")
	{
		billing.GET("/summary", h.GetBillingSummary)
		billing.GET("/ledger", h.ListBillingLedger)
	}

	// P0-1: 内部结算回调——Novel Runtime 上报逐次计费（plan §3 T3-3）
	// 不走 JWT；handler 内部用 SUB2API_INTERNAL_LLM_API_KEY 共享密钥校验
	internal := v1.Group("/internal/novel")
	{
		internal.POST("/billing/settle", h.SettleBilling)
	}
}
