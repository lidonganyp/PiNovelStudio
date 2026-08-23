/**
 * 章节 / 种子 / 版本 / 生成入口 API。
 * 契约对齐 platform-api ChaptersController（挂在 /projects/:id 下）。
 */
import { http } from './http';

/** 种子视图（写前章纲六要素）。 */
export interface ChapterSeed {
  id: number;
  intent: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
  endingGoal: string;
  status: string;
  version: number;
}

/** 章节视图（含内嵌 seed）。 */
export interface Chapter {
  id: number;
  projectId: number;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
  status: string;
  version: number;
  generationJobId: string | null;
  seed: ChapterSeed | null;
}

/** 章节历史版本视图。 */
export interface ChapterVersion {
  id: number;
  versionNumber: number;
  title: string;
  content: string;
  wordCount: number;
  source: string;
  createdAt: string;
}

export interface UpsertSeedInput {
  expectedVersion: number;
  intent?: string;
  mustInclude?: string;
  forbiddenFacts?: string;
  characterMotives?: string;
  promises?: string;
  endingGoal?: string;
}

export function listChapters(projectId: number): Promise<Chapter[]> {
  return http.get(`/projects/${projectId}/chapters`).then((r) => r.data);
}

export function getChapter(
  projectId: number,
  chapterId: number,
): Promise<Chapter> {
  return http
    .get(`/projects/${projectId}/chapters/${chapterId}`)
    .then((r) => r.data);
}

export function createChapter(
  projectId: number,
  input: { chapterNumber: number; title?: string },
): Promise<Chapter> {
  return http
    .post(`/projects/${projectId}/chapters`, input)
    .then((r) => r.data);
}

/** 保存正文：乐观锁（expectedVersion 冲突时后端返回 409）。 */
export function updateChapter(
  projectId: number,
  chapterId: number,
  input: {
    chapterNumber?: number;
    title?: string;
    content?: string;
    expectedVersion: number;
  },
): Promise<Chapter> {
  return http
    .put(`/projects/${projectId}/chapters/${chapterId}`, input)
    .then((r) => r.data);
}

export function removeChapter(
  projectId: number,
  chapterId: number,
): Promise<{ ok: true }> {
  return http
    .delete(`/projects/${projectId}/chapters/${chapterId}`)
    .then((r) => r.data);
}

export function getSeed(
  projectId: number,
  chapterId: number,
): Promise<ChapterSeed> {
  return http
    .get(`/projects/${projectId}/chapters/${chapterId}/seed`)
    .then((r) => r.data);
}

export function upsertSeed(
  projectId: number,
  chapterId: number,
  input: UpsertSeedInput,
): Promise<ChapterSeed> {
  return http
    .post(`/projects/${projectId}/chapters/${chapterId}/seed`, input)
    .then((r) => r.data);
}

export function listVersions(
  projectId: number,
  chapterId: number,
): Promise<ChapterVersion[]> {
  return http
    .get(`/projects/${projectId}/chapters/${chapterId}/versions`)
    .then((r) => r.data);
}

export function restoreVersion(
  projectId: number,
  chapterId: number,
  versionNumber: number,
): Promise<Chapter> {
  return http
    .post(`/projects/${projectId}/chapters/${chapterId}/versions/restore`, {
      versionNumber,
    })
    .then((r) => r.data);
}

/** 提交生成任务，返回初始 job 视图（含 jobId）。 */
export function submitGeneration(
  projectId: number,
  chapterId: number,
): Promise<import('./jobs').NovelJob> {
  return http
    .post(`/projects/${projectId}/chapters/${chapterId}/generate`)
    .then((r) => r.data);
}
