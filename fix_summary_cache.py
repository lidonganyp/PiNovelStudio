#!/usr/bin/env python3
"""
优化摘要缓存机制：
- SaveDocumentRequest 没有 Metadata 字段
- 改为在 content 开头嵌入 last_summarized_msg_id 标记
  格式: <!-- last_msg_id:12345 -->\n摘要内容
- 读取时解析这个标记
"""
import io

target = r'd:\CODE\sub2api\backend\internal\service\novel_assistant_service.go'
with io.open(target, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 修改缓存读取逻辑：从 content 中解析 last_summarized_msg_id
old_read = """	// 读取缓存的摘要
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
	}"""

new_read = """	// 读取缓存的摘要
	cachedDoc, err := s.dataRepo.GetDocument(ctx, userID, projectID, assistantContextSummaryType)
	if err != nil && !dbent.IsNotFound(err) {
		fmt.Printf("WARN: assistant: get cached summary failed (user=%d project=%d): %v\\n", userID, projectID, err)
		// 读取失败时尝试重新生成
	}

	// 检查摘要是否需要更新
	// 摘要 content 开头嵌入标记: <!-- last_msg_id:12345 -->
	// 如果缓存的 last_msg_id >= olderMessages 最后一条的 ID，则复用缓存
	if cachedDoc != nil && err == nil {
		cachedLastID := parseLastMsgIDFromSummary(cachedDoc.Content)
		needSummaryLastID := olderMessages[len(olderMessages)-1].ID
		if cachedLastID > 0 && cachedLastID >= needSummaryLastID {
			// 摘要仍有效，去掉标记行后返回
			return stripSummaryMarker(cachedDoc.Content)
		}
	}"""

content = content.replace(old_read, new_read)

# 2. 修改缓存写入逻辑：在 content 开头嵌入 last_msg_id 标记
old_write = """	// 缓存摘要到 NovelDocument
	// metadata.last_summarized_msg_id 记录最后一次被摘要的消息 ID
	lastMsgID := olderMessages[len(olderMessages)-1].ID
	metadata := map[string]any{
		"last_summarized_msg_id": lastMsgID,
		"summarized_count":       len(olderMessages),
		"updated_at":             time.Now().Format(time.RFC3339),
	}
	_, saveErr := s.dataRepo.SaveDocument(ctx, SaveDocumentRequest{
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

	return summary"""

new_write = """	// 缓存摘要到 NovelDocument
	// 在 content 开头嵌入 last_msg_id 标记: <!-- last_msg_id:12345 -->
	// 用于下次判断摘要是否需要更新
	lastMsgID := olderMessages[len(olderMessages)-1].ID
	contentWithMarker := fmt.Sprintf("<!-- last_msg_id:%d -->\\n%s", lastMsgID, summary)
	_, saveErr := s.dataRepo.SaveDocument(ctx, SaveDocumentRequest{
		UserID:       userID,
		ProjectID:    projectID,
		DocumentType: assistantContextSummaryType,
		Title:        "对话上下文摘要",
		Content:      contentWithMarker,
	})
	if saveErr != nil {
		fmt.Printf("WARN: assistant: save summary doc failed (user=%d project=%d): %v\\n", userID, projectID, saveErr)
	}

	return summary"""

content = content.replace(old_write, new_write)

# 3. 替换 getMetadataInt 函数为 parseLastMsgIDFromSummary 和 stripSummaryMarker
old_helper = """// getMetadataInt 从 map[string]any 中读取 int 值
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
}"""

new_helper = """// parseLastMsgIDFromSummary 从摘要 content 开头解析 last_msg_id 标记
// 格式: <!-- last_msg_id:12345 -->
func parseLastMsgIDFromSummary(content string) int64 {
	// 只检查前 100 字符，避免扫描整个内容
	prefix := content
	if len(prefix) > 100 {
		prefix = prefix[:100]
	}
	idx := strings.Index(prefix, "<!-- last_msg_id:")
	if idx < 0 {
		return 0
	}
	start := idx + len("<!-- last_msg_id:")
	end := strings.Index(prefix[start:], " -->")
	if end < 0 {
		return 0
	}
	idStr := strings.TrimSpace(prefix[start : start+end])
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		return 0
	}
	return id
}

// stripSummaryMarker 去掉摘要 content 开头的 last_msg_id 标记行
func stripSummaryMarker(content string) string {
	if !strings.HasPrefix(content, "<!-- last_msg_id:") {
		return content
	}
	idx := strings.Index(content, " -->")
	if idx < 0 {
		return content
	}
	// 去掉标记行和随后的换行符
	rest := content[idx+len(" -->"):]
	return strings.TrimLeft(rest, "\\n\\r ")
}"""

content = content.replace(old_helper, new_helper)

with io.open(target, 'w', encoding='utf-8', newline='') as f:
    f.write(content)
print("[OK] Optimized summary cache mechanism")
