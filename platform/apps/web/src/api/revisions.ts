/** Once-confirmed sequential rewrite API. Monetary limits are integer fen. */
import { http } from './http';
export interface Revision {
  id: string; version: number; status: string; projectId: number;
  startChapter: number; endChapter: number; completedChapters: number; totalChapters: number;
  chapters: Array<{ chapterId: number; chapterNumber: number; version: number; manual: boolean; completed?: boolean; jobId?: string }>;
  reasons: string[]; perChapterFen: number; totalFen: number; pauseCode: string | null; pauseReason: string | null;
}
export function listRevisions(projectId: number): Promise<Revision[]> {
  return http.get(`/projects/${projectId}/revisions`).then((r) => r.data);
}
export function proposeRevision(projectId: number, range: { startChapter: number; endChapter: number }): Promise<Revision> {
  return http.post(`/projects/${projectId}/revisions`, range).then((r) => r.data);
}
export function revisionAction(projectId: number, id: string, action: 'confirm' | 'resume' | 'approve-manual' | 'stop', body?: object): Promise<Revision> {
  return http.post(`/projects/${projectId}/revisions/${id}/${action}`, body).then((r) => r.data);
}
