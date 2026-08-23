/**
 * 项目/章节反馈 API。
 */
import { http } from './http';

export interface FeedbackItem {
  id: number;
  projectId: number;
  userId: number;
  chapterId: number | null;
  type: string;
  content: string;
  status: 'pending' | 'replied';
  replyContent: string | null;
  repliedAt: string | null;
  adminNickname?: string | null;
  createdAt: string;
}

export function listFeedback(projectId: number): Promise<FeedbackItem[]> {
  return http.get(`/projects/${projectId}/feedback`).then((r) => r.data);
}

export function createFeedback(
  projectId: number,
  payload: { type: string; content: string; chapterId?: number },
): Promise<FeedbackItem> {
  return http.post(`/projects/${projectId}/feedback`, payload).then((r) => r.data);
}
