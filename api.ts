/**
 * 小说创作功能 API 客户端（plan §7 公共 API 契约）
 *
 * 所有调用经 Sub2API 后端，不经浏览器直连 Novel Runtime。
 * 错误响应拦截器已将 { code: 0, data } 解包；非零 code 抛出结构化错误。
 */
import { apiClient } from '@/api/client'
import type { BasePaginationResponse } from '@/types'
import type {
  CreateCharacterRequest,
  CreateChapterSeedRequest,
  CreateGenerationRequest,
  CreateNovelProjectRequest,
  CreateOutlineNodeRequest,
  GenerationEstimate,
  MigrationResult,
  MoveOutlineNodeRequest,
  NovelChapter,
  NovelChapterSeed,
  NovelCharacter,
  NovelDocument,
  NovelOutlineNode,
  NovelProject,
  PlanOutlineRequest,
  PlanOutlineResponse,
  PutNovelDocumentRequest,
  ReorderCharactersRequest,
  ReorderOutlineNodesRequest,
  SaveChapterRequest,
  NovelFeedbackRequest,
  NovelGenerationJob,
  UpdateCharacterRequest,
  UpdateChapterSeedRequest,
  UpdateNovelProjectRequest,
  UpdateOutlineNodeRequest,
  // B4 账单查询
  GenerationListFilter,
  GenerationListResponse,
  BillingSummary,
  BillingLedgerFilter,
  BillingLedgerResponse,
  // SUB2API-NOVEL-CREATION-UX-1 §3/§4 工作流 + PI 助手
  ConfirmOutlineRequest,
  OutlineConfirmationResult,
  RevokeConfirmationResponse,
  WorkflowStateDTO,
  AssistantEstimateResponse,
  AssistantMessageResponse,
  NovelAssistantMessage,
  SendAssistantMessageRequest,
} from './types'

const BASE = '/novel'

// ==================== 项目 ====================

export async function listProjects(
  page: number = 1,
  pageSize: number = 20,
  options?: { signal?: AbortSignal },
): Promise<BasePaginationResponse<NovelProject>> {
  const { data } = await apiClient.get<BasePaginationResponse<NovelProject>>(`${BASE}/projects`, {
    params: { page, page_size: pageSize },
    signal: options?.signal,
  })
  return data
}

export async function getProject(id: string): Promise<NovelProject> {
  const { data } = await apiClient.get<NovelProject>(`${BASE}/projects/${id}`)
  return data
}

export async function createProject(req: CreateNovelProjectRequest): Promise<NovelProject> {
  const { data } = await apiClient.post<NovelProject>(`${BASE}/projects`, req)
  return data
}

export async function updateProject(
  id: string,
  req: UpdateNovelProjectRequest,
): Promise<NovelProject> {
  const { data } = await apiClient.put<NovelProject>(`${BASE}/projects/${id}`, req)
  return data
}

// ==================== 文档 ====================

export async function getDocument(
  projectId: string,
  type: string,
): Promise<NovelDocument> {
  const { data } = await apiClient.get<NovelDocument>(
    `${BASE}/projects/${projectId}/documents/${type}`,
  )
  return data
}

export async function putDocument(
  projectId: string,
  type: string,
  req: PutNovelDocumentRequest,
): Promise<NovelDocument> {
  const { data } = await apiClient.put<NovelDocument>(
    `${BASE}/projects/${projectId}/documents/${type}`,
    req,
  )
  return data
}

export async function planOutline(
  projectId: string,
  req: PlanOutlineRequest,
): Promise<PlanOutlineResponse> {
  const { data } = await apiClient.post<PlanOutlineResponse>(
    `${BASE}/projects/${projectId}/outline/plan`,
    req,
  )
  return data
}

// ==================== 章节 ====================

export async function listChapters(
  projectId: string,
  page: number = 1,
  pageSize: number = 50,
): Promise<NovelChapter[]> {
  // 后端 ListChapters 返回 { code, message, data: [...] }，
  // axios 拦截器 unwrap 后 data 即为章节数组（与 listCharacters/listOutlineNodes 同构）。
  // page/pageSize 参数仅为预留，后端当前不消费。
  const { data } = await apiClient.get<NovelChapter[]>(
    `${BASE}/projects/${projectId}/chapters`,
    { params: { page, page_size: pageSize } },
  )
  return data
}

export async function getChapter(projectId: string, chapterNumber: number): Promise<NovelChapter> {
  const { data } = await apiClient.get<NovelChapter>(
    `${BASE}/projects/${projectId}/chapters/${chapterNumber}`,
  )
  return data
}

// ==================== 章节手工保存与版本历史 ====================

export async function saveChapter(
  projectId: string,
  chapterNumber: number,
  req: SaveChapterRequest,
): Promise<NovelChapter> {
  const { data } = await apiClient.put<NovelChapter>(
    `${BASE}/projects/${projectId}/chapters/${chapterNumber}`,
    req,
  )
  return data
}





// ==================== 生成任务 ====================

export async function estimateGeneration(
  projectId: string,
  chapterNumber: number,
): Promise<GenerationEstimate> {
  const { data } = await apiClient.post<GenerationEstimate>(`${BASE}/generations/estimate`, {
    project_id: projectId,
    chapter_number: chapterNumber,
  })
  return data
}

export async function createGeneration(
  req: CreateGenerationRequest,
): Promise<NovelGenerationJob> {
  const { data } = await apiClient.post<NovelGenerationJob>(`${BASE}/generations`, req)
  return data
}

export async function getGeneration(jobId: string): Promise<NovelGenerationJob> {
  const { data } = await apiClient.get<NovelGenerationJob>(`${BASE}/generations/${jobId}`)
  return data
}

export async function cancelGeneration(jobId: string): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>(
    `${BASE}/generations/${jobId}/cancel`,
  )
  return data
}

/**
 * 订阅生成任务 SSE 事件流（plan §5 T5-3）。
 *
 * 返回一个取消函数——调用方在组件卸载或用户取消时调用以关闭连接。
 * 浏览器原生 EventSource 不支持自定义 Header（auth token），因此使用 fetch + ReadableStream。
 */
export interface GenerationEventSubscription {
  /** 取消订阅 */
  close: () => void
}

export function subscribeGenerationEvents(
  jobId: string,
  handlers: {
    onEvent: (event: import('./types').NovelGenerationEvent) => void
    onError?: (err: Error) => void
    onClose?: () => void
  },
): GenerationEventSubscription {
  const controller = new AbortController()
  const token = localStorage.getItem('auth_token') ?? ''

  // EventSource 不支持自定义 Header；用 fetch 流式读取 text/event-stream
  const url = `/api/v1${BASE}/generations/${jobId}/events`
  let closed = false

  ;(async () => {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connect failed: ${resp.status}`)
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 事件以空行分隔
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const event = parseSseEvent(raw)
          if (event) handlers.onEvent(event)
        }
      }
    } catch (err) {
      if (!closed) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      if (!closed) {
        closed = true
        handlers.onClose?.()
      }
    }
  })()

  return {
    close() {
      closed = true
      controller.abort()
    },
  }
}

function parseSseEvent(raw: string): import('./types').NovelGenerationEvent | null {
  // SSE 格式：每行 `field: value`，data 字段是 JSON
  const lines = raw.split('\n')
  let dataStr = ''
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataStr += line.slice(5).trim()
    }
  }
  if (!dataStr) return null
  try {
    return JSON.parse(dataStr) as import('./types').NovelGenerationEvent
  } catch {
    return null
  }
}


// ==================== 角色卡 ====================

export async function listCharacters(projectId: string): Promise<NovelCharacter[]> {
  const { data } = await apiClient.get<NovelCharacter[]>(
    `${BASE}/projects/${projectId}/characters`,
  )
  return data
}

export async function getCharacter(projectId: string, characterId: string): Promise<NovelCharacter> {
  const { data } = await apiClient.get<NovelCharacter>(
    `${BASE}/projects/${projectId}/characters/${characterId}`,
  )
  return data
}

export async function createCharacter(
  projectId: string,
  req: CreateCharacterRequest,
): Promise<NovelCharacter> {
  const { data } = await apiClient.post<NovelCharacter>(
    `${BASE}/projects/${projectId}/characters`,
    req,
  )
  return data
}

export async function updateCharacter(
  projectId: string,
  characterId: string,
  req: UpdateCharacterRequest,
): Promise<NovelCharacter> {
  const { data } = await apiClient.put<NovelCharacter>(
    `${BASE}/projects/${projectId}/characters/${characterId}`,
    req,
  )
  return data
}

export async function deleteCharacter(projectId: string, characterId: string): Promise<void> {
  await apiClient.delete(`${BASE}/projects/${projectId}/characters/${characterId}`)
}

export async function reorderCharacters(
  projectId: string,
  req: ReorderCharactersRequest,
): Promise<void> {
  await apiClient.put(`${BASE}/projects/${projectId}/characters/_reorder`, req)
}

// ==================== 大纲节点 ====================

export async function listOutlineNodes(projectId: string): Promise<NovelOutlineNode[]> {
  const { data } = await apiClient.get<NovelOutlineNode[]>(
    `${BASE}/projects/${projectId}/outline-nodes`,
  )
  return data
}

export async function createOutlineNode(
  projectId: string,
  req: CreateOutlineNodeRequest,
): Promise<NovelOutlineNode> {
  const { data } = await apiClient.post<NovelOutlineNode>(
    `${BASE}/projects/${projectId}/outline-nodes`,
    req,
  )
  return data
}

export async function updateOutlineNode(
  projectId: string,
  nodeId: string,
  req: UpdateOutlineNodeRequest,
): Promise<NovelOutlineNode> {
  const { data } = await apiClient.put<NovelOutlineNode>(
    `${BASE}/projects/${projectId}/outline-nodes/${nodeId}`,
    req,
  )
  return data
}

export async function deleteOutlineNode(projectId: string, nodeId: string): Promise<void> {
  await apiClient.delete(`${BASE}/projects/${projectId}/outline-nodes/${nodeId}`)
}

export async function moveOutlineNode(
  projectId: string,
  nodeId: string,
  req: MoveOutlineNodeRequest,
): Promise<NovelOutlineNode> {
  const { data } = await apiClient.patch<NovelOutlineNode>(
    `${BASE}/projects/${projectId}/outline-nodes/${nodeId}/move`,
    req,
  )
  return data
}

export async function reorderOutlineNodes(
  projectId: string,
  req: ReorderOutlineNodesRequest,
): Promise<void> {
  await apiClient.put(`${BASE}/projects/${projectId}/outline-nodes/_reorder`, req)
}

// ==================== 章节种子 ====================

export async function getChapterSeed(
  projectId: string,
  chapterNumber: number,
): Promise<NovelChapterSeed | null> {
  const { data } = await apiClient.get<NovelChapterSeed | null>(
    `${BASE}/projects/${projectId}/chapter-seeds/${chapterNumber}`,
  )
  return data
}

export async function createChapterSeed(
  projectId: string,
  chapterNumber: number,
  req: CreateChapterSeedRequest,
): Promise<NovelChapterSeed> {
  const { data } = await apiClient.post<NovelChapterSeed>(
    `${BASE}/projects/${projectId}/chapter-seeds/${chapterNumber}`,
    req,
  )
  return data
}

export async function updateChapterSeed(
  projectId: string,
  chapterNumber: number,
  req: UpdateChapterSeedRequest,
): Promise<NovelChapterSeed> {
  const { data } = await apiClient.put<NovelChapterSeed>(
    `${BASE}/projects/${projectId}/chapter-seeds/${chapterNumber}`,
    req,
  )
  return data
}

export async function deleteChapterSeed(projectId: string, chapterNumber: number): Promise<void> {
  await apiClient.delete(`${BASE}/projects/${projectId}/chapter-seeds/${chapterNumber}`)
}

// ==================== 结构化数据迁移 ====================

export async function migrateStructuredData(projectId: string): Promise<MigrationResult> {
  const { data } = await apiClient.post<MigrationResult>(
    `${BASE}/projects/${projectId}/structured-data/migrate`,
  )
  return data
}

// ==================== B4：账单查询 ====================

export async function listGenerations(
  filter: GenerationListFilter = {},
): Promise<GenerationListResponse> {
  const { data } = await apiClient.get<GenerationListResponse>(`${BASE}/generations`, {
    params: {
      page: filter.page ?? 1,
      page_size: filter.page_size ?? 20,
      project_id: filter.project_id,
      status: filter.status,
    },
  })
  return data
}

export async function getBillingSummary(): Promise<BillingSummary> {
  const { data } = await apiClient.get<BillingSummary>(`${BASE}/billing/summary`)
  return data
}

export async function listBillingLedger(
  filter: BillingLedgerFilter = {},
): Promise<BillingLedgerResponse> {
  const { data } = await apiClient.get<BillingLedgerResponse>(`${BASE}/billing/ledger`, {
    params: {
      page: filter.page ?? 1,
      page_size: filter.page_size ?? 20,
      project_id: filter.project_id,
      type: filter.type,
      from: filter.from,
      to: filter.to,
    },
  })
  return data
}

// ==================== 反馈 ====================

export async function submitFeedback(
  req: NovelFeedbackRequest,
): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>(
    `${BASE}/projects/${req.project_id}/feedback`,
    req,
  )
  return data
}

// ==================== 工作流状态机（SUB2API-NOVEL-CREATION-UX-1 §3） ====================

/**
 * 获取项目工作流状态。PI 创作助手初次进入时调用，决定展示什么内容。
 * 后端派生权威状态（不依赖前端缓存）。
 */
export async function getWorkflow(projectId: string): Promise<WorkflowStateDTO> {
  const { data } = await apiClient.get<WorkflowStateDTO>(
    `${BASE}/projects/${projectId}/workflow`,
  )
  return data
}

/**
 * 确认当前大纲版本（乐观锁）。
 * expected_version 必须与当前 story_outline.current_version 一致，
 * 否则返回 409 OUTLINE_VERSION_MISMATCH。
 */
export async function confirmOutline(
  projectId: string,
  req: ConfirmOutlineRequest,
): Promise<OutlineConfirmationResult> {
  const { data } = await apiClient.post<OutlineConfirmationResult>(
    `${BASE}/projects/${projectId}/outline/confirm`,
    req,
  )
  return data
}

/**
 * 撤销 active 大纲确认（用户主动撤销）。
 * 撤销后状态回到 outline_draft。幂等——无 active 确认时返回 404。
 */
export async function revokeOutlineConfirmation(
  projectId: string,
): Promise<RevokeConfirmationResponse> {
  const { data } = await apiClient.delete<RevokeConfirmationResponse>(
    `${BASE}/projects/${projectId}/outline/confirmation`,
  )
  return data
}

// ==================== PI 创作助手（SUB2API-NOVEL-CREATION-UX-1 §4） ====================

/**
 * 查询历史对话消息（按时间正序）。刷新页面后对话不丢失。
 * 后端返回分页结构 { items, total, page, page_size, pages }。
 */
export async function listAssistantMessages(
  projectId: string,
  page: number = 1,
  pageSize: number = 50,
): Promise<BasePaginationResponse<NovelAssistantMessage>> {
  const { data } = await apiClient.get<BasePaginationResponse<NovelAssistantMessage>>(
    `${BASE}/projects/${projectId}/assistant/messages`,
    { params: { page, page_size: pageSize } },
  )
  return data
}

/** 估价 PI 对话费用。前端展示估价后由用户确认消费，再调用 sendMessage。 */
export async function estimateAssistant(projectId: string): Promise<AssistantEstimateResponse> {
  const { data } = await apiClient.get<AssistantEstimateResponse>(
    `${BASE}/projects/${projectId}/assistant/estimate`,
  )
  return data
}

/**
 * 发送用户消息并获取 AI 回复。
 * 流程：持久化 → 构建 prompt → 服务端调用 LLM → 检测生成标记 → （可能）创建章节 job → 持久化回复 → 计费。
 *
 * 超时说明（SSE/异步任务方案改造后）：
 *   - 后端异步化改造后，sendAssistantMessage 只等 LLM 回复（~30 秒）即返回。
 *   - 章节生成（若触发）在后台 goroutine 异步进行，前端通过 SSE 实时监听进度。
 *   - 前端超时设为 2 分钟（120000ms），覆盖 LLM 回复 + 余量；不再需要 36 分钟长连接。
 *   - 不修改全局 timeout，避免影响其他接口。
 */
export async function sendAssistantMessage(
  projectId: string,
  req: SendAssistantMessageRequest,
): Promise<AssistantMessageResponse> {
  const { data } = await apiClient.post<AssistantMessageResponse>(
    `${BASE}/projects/${projectId}/assistant/messages`,
    req,
    { timeout: 120000 }, // 2 分钟：只等 LLM 回复，章节生成异步进行（SSE 监听）
  )
  return data
}

// ==================== 聚合导出 ====================

export const novelApi = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  getDocument,
  putDocument,
  planOutline,
  listChapters,
  getChapter,
  saveChapter,
  estimateGeneration,
  createGeneration,
  getGeneration,
  cancelGeneration,
  subscribeGenerationEvents,
  submitFeedback,
  // B4 账单查询
  listGenerations,
  getBillingSummary,
  listBillingLedger,
  // B2 T2
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  reorderCharacters,
  listOutlineNodes,
  createOutlineNode,
  updateOutlineNode,
  deleteOutlineNode,
  moveOutlineNode,
  reorderOutlineNodes,
  getChapterSeed,
  createChapterSeed,
  updateChapterSeed,
  deleteChapterSeed,
  migrateStructuredData,
  // SUB2API-NOVEL-CREATION-UX-1 §3/§4 工作流 + PI 助手
  getWorkflow,
  confirmOutline,
  revokeOutlineConfirmation,
  listAssistantMessages,
  estimateAssistant,
  sendAssistantMessage,
}

export default novelApi
