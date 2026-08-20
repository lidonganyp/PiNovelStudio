/**
 * 工作台资源 API：角色 / 文档 / 大纲。
 * 契约对齐 platform-api Characters/Documents/Outline Controller。
 */
import { http } from './http';

/** 角色视图。 */
export interface NovelCharacter {
  id: number;
  name: string;
  roleType: string;
  aliases: string[];
  identity: string;
  goals: string;
  version: number;
  sortOrder: number;
}

/** 文档视图。 */
export interface NovelDocument {
  id: number;
  documentType: string;
  title: string;
  content: string;
  currentVersion: number;
}

/** 大纲节点视图（树形）。 */
export interface OutlineNode {
  id: number;
  parentId: number | null;
  nodeType: string;
  title: string;
  summary: string;
  sortOrder: number;
  version: number;
  children?: OutlineNode[];
}

/** 文档类型（后端 runtime workspace 消费的五类 + 自由扩展）。 */
export const DOCUMENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'creative_constitution', label: '创作宪法' },
  { value: 'worldbuilding', label: '世界观设定' },
  { value: 'story_outline', label: '故事大纲' },
  { value: 'style_profile', label: '风格档案' },
  { value: 'narrative_state', label: '叙事状态' },
];

/** 角色类型选项。 */
export const ROLE_TYPES: Array<{ value: string; label: string }> = [
  { value: 'protagonist', label: '主角' },
  { value: 'antagonist', label: '反派' },
  { value: 'supporting', label: '配角' },
  { value: 'other', label: '其他' },
];

// ---- 角色 ----

export function listCharacters(projectId: number): Promise<NovelCharacter[]> {
  return http.get(`/projects/${projectId}/characters`).then((r) => r.data);
}

export function createCharacter(
  projectId: number,
  input: {
    name: string;
    roleType?: string;
    aliases?: string[];
    identity?: string;
    goals?: string;
  },
): Promise<NovelCharacter> {
  return http
    .post(`/projects/${projectId}/characters`, input)
    .then((r) => r.data);
}

export function updateCharacter(
  projectId: number,
  characterId: number,
  input: Record<string, unknown>,
): Promise<NovelCharacter> {
  return http
    .patch(`/projects/${projectId}/characters/${characterId}`, input)
    .then((r) => r.data);
}

export function removeCharacter(
  projectId: number,
  characterId: number,
): Promise<{ ok: true }> {
  return http
    .delete(`/projects/${projectId}/characters/${characterId}`)
    .then((r) => r.data);
}

// ---- 文档 ----

export function listDocuments(projectId: number): Promise<NovelDocument[]> {
  return http.get(`/projects/${projectId}/documents`).then((r) => r.data);
}

export function createDocument(
  projectId: number,
  input: { documentType: string; title: string; content?: string },
): Promise<NovelDocument> {
  return http
    .post(`/projects/${projectId}/documents`, input)
    .then((r) => r.data);
}

export function updateDocument(
  projectId: number,
  documentId: number,
  input: { title?: string; content?: string },
): Promise<NovelDocument> {
  return http
    .patch(`/projects/${projectId}/documents/${documentId}`, input)
    .then((r) => r.data);
}

export function removeDocument(
  projectId: number,
  documentId: number,
): Promise<{ ok: true }> {
  return http
    .delete(`/projects/${projectId}/documents/${documentId}`)
    .then((r) => r.data);
}

// ---- 大纲 ----

export function listOutline(projectId: number): Promise<OutlineNode[]> {
  return http.get(`/projects/${projectId}/outline`).then((r) => r.data);
}

export function createOutlineNode(
  projectId: number,
  input: {
    parentId?: number | null;
    nodeType?: string;
    title: string;
    summary?: string;
  },
): Promise<OutlineNode> {
  return http
    .post(`/projects/${projectId}/outline`, input)
    .then((r) => r.data);
}

export function updateOutlineNode(
  projectId: number,
  nodeId: number,
  input: Record<string, unknown>,
): Promise<OutlineNode> {
  return http
    .patch(`/projects/${projectId}/outline/${nodeId}`, input)
    .then((r) => r.data);
}

export function removeOutlineNode(
  projectId: number,
  nodeId: number,
): Promise<{ ok: true }> {
  return http
    .delete(`/projects/${projectId}/outline/${nodeId}`)
    .then((r) => r.data);
}
