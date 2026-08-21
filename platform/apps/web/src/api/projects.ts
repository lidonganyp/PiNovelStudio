/**
 * 项目 API：列表（分页+搜索）/ 创建 / 详情 / 更新 / 软删除。
 * 契约对齐 platform-api ProjectsController。
 */
import { http } from './http';

/** 项目视图（后端 toView 形状）。 */
export interface Project {
  id: number;
  userId: number;
  title: string;
  description: string;
  genre: string;
  subGenres: string[];
  worldKeyTerms: string[];
  status: string;
  workflowState: string;
  version: number;
  chapterCount?: number;
  wordCount?: number;
  lastActiveAt?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ProjectListResult {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  genre?: string;
  subGenres?: string[];
  worldKeyTerms?: string[];
}

export function listProjects(params: {
  page?: number;
  pageSize?: number;
  q?: string;
}): Promise<ProjectListResult> {
  return http.get('/projects', { params }).then((r) => r.data);
}

export function getProject(id: number): Promise<Project> {
  return http.get(`/projects/${id}`).then((r) => r.data);
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return http.post('/projects', input).then((r) => r.data);
}

export function updateProject(
  id: number,
  input: Partial<CreateProjectInput> & { status?: string; expectedVersion: number },
): Promise<Project> {
  return http.patch(`/projects/${id}`, input).then((r) => r.data);
}

export function removeProject(id: number): Promise<{ ok: true }> {
  return http.delete(`/projects/${id}`).then((r) => r.data);
}

export function listTrashedProjects(params: {
  page?: number;
  pageSize?: number;
}): Promise<ProjectListResult> {
  return http.get('/projects/trash', { params }).then((r) => r.data);
}

export function restoreProject(id: number): Promise<Project> {
  return http.post(`/projects/${id}/restore`).then((r) => r.data);
}

export function exportProjectBook(
  id: number,
): Promise<{ filename: string; content: string }> {
  return http.get(`/projects/${id}/export`).then((r) => r.data);
}
