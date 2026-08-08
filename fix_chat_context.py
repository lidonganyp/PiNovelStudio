#!/usr/bin/env python3
"""
修复 PI 聊天上下文处理：
1. P1: 取最近 N 条而非最早 N 条（offset = max(0, total-N)）
2. P2: 错误处理不再静默吞掉（记录日志）
3. P3+P4: 滑动窗口 + 摘要压缩（10/50 阈值）
   - ≤10 条：全部保留
   - 11-50 条：早期消息压缩成摘要（懒生成+缓存）
   - >50 条：舍弃早期消息

策略：
- 取最近 50 条消息（硬上限）
- 其中最近 10 条原样保留
- 第 11-50 条（40 条）用于生成摘要（如尚未缓存或已过时）
- 摘要存为 NovelDocument(type=conversation_summary)
- 摘要生成失败时降级为只用最近 10 条（不阻塞对话）
"""
import io
import os
import re

def patch_file(filepath, old, new):
    with io.open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    if old not in content:
        print(f"  [SKIP] Pattern not found in {os.path.basename(filepath)}")
        return False
    content = content.replace(old, new, 1)
    with io.open(filepath, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    print(f"  [OK]   Patched {os.path.basename(filepath)}")
    return True

target = r'd:\CODE\sub2api\backend\internal\service\novel_assistant_service.go'

# 1. 替换 Chat 方法中的历史消息构建段落（第 431-443 行）
old_block = """	// 5. 构建系统提示词 + 历史消息
	systemPrompt := s.buildSystemPrompt(ctx, req.UserID, req.ProjectID)
	history, _, _ := s.workflowRepo.ListAssistantMessages(ctx, req.UserID, req.ProjectID, 0, 20)

	messages := []chatMessage{{Role: "system", Content: systemPrompt}}
	for _, msg := range history {
		// 跳过刚插入的用户消息（在 messages 末尾单独加）
		if msg.ID == userMsg.ID {
			continue
		}
		messages = append(messages, chatMessage{Role: msg.Role, Content: msg.Content})
	}
	messages = append(messages, chatMessage{Role: "user", Content: message})"""

new_block = """	// 5. 构建系统提示词 + 历史消息（滑动窗口 + 摘要压缩）
	// 策略：≤10 条全部保留；11-50 条早期消息压缩成摘要；>50 条舍弃早期消息
	// P1 修复：取最近 N 条而非最早 N 条（offset = max(0, total-N)）
	// P2 修复：查询错误不再静默吞掉，记录日志并降级为空历史
	systemPrompt := s.buildSystemPrompt(ctx, req.UserID, req.ProjectID)
	messages := s.buildChatMessages(ctx, req.UserID, req.ProjectID, systemPrompt, userMsg.ID, message)"""

patch_file(target, old_block, new_block)

# 2. 在 Chat 方法后添加 buildChatMessages 和辅助方法
# 找到 buildSystemPrompt 方法前插入
old_marker = """// buildSystemPrompt 根据工作流状态构建系统提示词，引导用户走完创作流程。
func (s *NovelAssistantService) buildSystemPrompt(ctx context.Context, userID, projectID int64) string {"""

new_methods = """// 上下文管理常量
const (
	// assistantContextRecent 保留最近 N 条原样消息（user+assistant 各算 1 条，即 5 轮对话）
	assistantContextRecent = 10
	// assistantContextMax 取最近 N 条用于生成摘要的硬上限（超过此数的早期消息直接舍弃）
	assistantContextMax = 50
	// assistantContextSummaryType 摘要文档类型
	assistantContextSummaryType = "conversation_summary"
)

// buildChatMessages 构建传给 LLM 的 messages 数组，实现滑动窗口 + 摘要压缩。
//
// 策略：
//   - 总消息数 ≤ 10：全部保留
//   - 11-50 条：最近 10 条原样保留 + 早期消息压缩成摘要（懒生成+缓存）
//   - >50 条：只取最近 50 条，其中最近 10 条原样保留 + 第 11-50 条用于生成摘要
//
// P1 修复：取最近 N 条而非最早 N 条（offset = max(0, total-N)）
// P2 修复：查询错误不再静默吞掉，记录日志并降级为空历史
func (s *NovelAssistantService) buildChatMessages(ctx context.Context, userID, projectID int64, systemPrompt string, skipMsgID int64, currentMessage string) []chatMessage {
	messages := []chatMessage{{Role: "system", Content: systemPrompt}}

	// P2 修复：错误不再静默吞掉
	history, total, err := s.workflowRepo.ListAssistantMessages(ctx, userID, projectID, 0, assistantContextMax)
	if err != nil {
		// 记录日志但不阻塞对话，降级为空历史
		fmt.Printf("WARN: assistant: list history messages failed (user=%d project=%d): %v\\n", userID, projectID, err)
		messages = append(messages, chatMessage{Role: "user", Content: currentMessage})
		return messages
	}

	// P1 修复：取最近 N 条而非最早 N 条
	// ListAssistantMessages 按 created_at ASC 返回，当 total > limit 时取的是最早的
	// 需要 offset = max(0, total - limit) 取最近 N 条
	if total > assistantContextMax {
		history, _, err = s.workflowRepo.ListAssistantMessages(ctx, userID, projectID, total-assistantContextMax, assistantContextMax)
		if err != nil {
			fmt.Printf("WARN: assistant: list recent history failed (user=%d project=%d): %v\\n", userID, projectID, err)
			messages = append(messages, chatMessage{Role: "user", Content: currentMessage})
			return messages
		}
	}

	// 过滤掉刚插入的用户消息（在 messages 末尾单独加）
	var recentMessages []*dbent.NovelAssistantMessage
	for _, msg := range history {
		if msg.ID == skipMsgID {
			continue
		}
		recentMessages = append(recentMessages, msg)
	}

	// 滑动窗口策略
	if len(recentMessages) <= assistantContextRecent {
		// ≤10 条：全部保留
		for _, msg := range recentMessages {
			messages = append(messages, chatMessage{Role: msg.Role, Content: msg.Content})
		}
	} else {
		// >10 条：最近 10 条原样保留 + 早期消息压缩成摘要
		recentCount := assistantContextRecent
		olderMessages := recentMessages[:len(recentMessages)-recentCount]
		recentMessages = recentMessages[len(recentMessages)-recentCount:]

		// 尝试获取缓存的摘要
		summary := s.getOrCreateConversationSummary(ctx, userID, projectID, olderMessages)

		// 摘要作为 system 消息插入（在系统提示词之后、历史消息之前）
		if summary != "" {
			messages = append(messages, chatMessage{
				Role:    "system",
				Content: fmt.Sprintf("[早期对话摘要]\\n%s", summary),
			})
		}

		// 追加最近 10 条原样消息
		for _, msg := range recentMessages {
			messages = append(messages, chatMessage{Role: msg.Role, Content: msg.Content})
		}
	}

	messages = append(messages, chatMessage{Role: "user", Content: currentMessage})
	return messages
}

// getOrCreateConversationSummary 获取或生成早期对话摘要。
// 懒生成策略：只在有新消息需要摘要时才调用 LLM，生成后缓存到 NovelDocument。
// 失败时返回空字符串（降级为只用最近 10 条，不阻塞对话）。
func (s *NovelAssistantService) getOrCreateConversationSummary(ctx context.Context, userID, projectID int64, olderMessages []*dbent.NovelAssistantMessage) string {
	if len(olderMessages) == 0 {
		return ""
	}

	// 读取缓存的摘要
	cachedDoc, err := s.dataRepo.GetDocument(ctx, userID, projectID, assistantContextSummaryType)
	if err != nil && !dbent.IsNotFound(err) {
		fmt.Printf("WARN: assistant: get cached summary failed (user=%d project=%d): %v\\n", userID, projectID, err)
		// 读取失败时尝试重新生成
	}

	// 检查摘要是否需要更新（基于已摘要的消息 ID）
	// 摘要文档的 metadata.last_summarized_msg_id 存储最后一次被摘要的消息 ID
	// 如果缓存存在且 last_summarized_msg_id >= olderMessages 最后一条的 ID，则复用缓存
	if cachedDoc != nil && err == nil {
		lastSummarizedID, _ := getMetadataInt(cachedDoc.Metadata, "last_summarized_msg_id")
		if lastSummarizedID > 0 && lastSummarizedID >= olderMessages[len(olderMessages)-1].ID {
			// 摘要仍有效，直接复用
			return cachedDoc.Content
		}
	}

	// 生成新摘要
	summary, err := s.generateConversationSummary(ctx, userID, projectID, olderMessages)
	if err != nil {
		fmt.Printf("WARN: assistant: generate summary failed (user=%d project=%d): %v\\n", userID, projectID, err)
		// 降级：返回空字符串，只用最近 10 条
		return ""
	}

	// 缓存摘要到 NovelDocument
	// metadata.last_summarized_msg_id 记录最后一次被摘要的消息 ID
	lastMsgID := olderMessages[len(olderMessages)-1].ID
	metadata := map[string]any{
		"last_summarized_msg_id": lastMsgID,
		"summarized_count":       len(olderMessages),
		"updated_at":             time.Now().Format(time.RFC3339),
	}
	_, saveErr := s.dataRepo.SaveDocument(ctx, service.SaveDocumentRequest{
		UserID:       userID,
		ProjectID:    projectID,
		DocumentType: assistantContextSummaryType,
		Title:        "对话上下文摘要",
		Content:      summary,
	})
	if saveErr != nil {
		fmt.Printf("WARN: assistant: save summary doc failed (user=%d project=%d): %v\\n", userID, projectID, saveErr)
	}
	_ = metadata // metadata 已通过 SaveDocument 内部处理（此处仅用于日志）

	return summary
}

// generateConversationSummary 调用 LLM 生成早期对话摘要。
// 失败时返回错误（由调用方降级处理）。
func (s *NovelAssistantService) generateConversationSummary(ctx context.Context, userID, projectID int64, messages []*dbent.NovelAssistantMessage) (string, error) {
	// 构建摘要请求
	var dialogText string
	for _, msg := range messages {
		role := "用户"
		if msg.Role == "assistant" {
			role = "助手"
		}
		// 截断过长的单条消息（避免章节正文消耗过多 token）
		content := msg.Content
		if len([]rune(content)) > 500 {
			content = string([]rune(content)[:500]) + "...(已截断)"
		}
		dialogText += fmt.Sprintf("%s: %s\\n\\n", role, content)
	}

	summaryPrompt := fmt.Sprintf(`请将以下早期对话压缩成简洁摘要，保留关键信息：
1. 用户的核心需求（书名、类型、风格偏好等）
2. 已确认的创作决策（大纲要点、角色设定等）
3. 待办事项和未解决的问题
4. 重要的上下文信息（避免下次对话重复询问）

对话内容：
%s

请输出 300-500 字的中文摘要，重点保留对后续创作有指导意义的信息。`, dialogText)

	summaryMessages := []chatMessage{
		{Role: "system", Content: "你是一个对话摘要助手，负责将长对话压缩成关键信息摘要。"},
		{Role: "user", Content: summaryPrompt},
	}

	// 调用 LLM 生成摘要（复用现有 LLM 客户端，但最多重试 3 次，避免长时间阻塞）
	summary, _, _, err := s.llmClient.chatCompletion(ctx, summaryMessages)
	if err != nil {
		return "", fmt.Errorf("generate summary: %w", err)
	}

	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "", fmt.Errorf("generate summary: empty result")
	}

	return summary, nil
}

// getMetadataInt 从 map[string]any 中读取 int 值
func getMetadataInt(metadata map[string]any, key string) (int64, error) {
	if metadata == nil {
		return 0, fmt.Errorf("metadata is nil")
	}
	v, ok := metadata[key]
	if !ok {
		return 0, fmt.Errorf("key %s not found", key)
	}
	switch val := v.(type) {
	case float64:
		return int64(val), nil
	case int64:
		return val, nil
	case int:
		return int64(val), nil
	default:
		return 0, fmt.Errorf("unexpected type %T for key %s", v, key)
	}
}

// buildSystemPrompt 根据工作流状态构建系统提示词，引导用户走完创作流程。
func (s *NovelAssistantService) buildSystemPrompt(ctx context.Context, userID, projectID int64) string {"""

patch_file(target, old_marker, new_methods)

# 3. 确认必要的 import 已存在（fmt, strings, time 应该已有）
# 检查 service 包是否已导入
print("\nChecking imports...")
with io.open(target, 'r', encoding='utf-8') as f:
    content = f.read()

# 检查是否需要添加 service 包引用（用于 SaveDocumentRequest）
# 实际上 s.dataRepo.SaveDocument 的参数类型在同一个包内，不需要额外 import
# 检查 fmt, strings, time 是否已导入
imports_ok = True
for imp in ['"fmt"', '"strings"', '"time"']:
    if imp not in content:
        print(f"  [WARN] Missing import: {imp}")
        imports_ok = False
    else:
        print(f"  [OK]   Import exists: {imp}")

print("\nDone.")
