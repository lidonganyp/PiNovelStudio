<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, type ComputedRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ConversationHeader from './ConversationHeader.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import StreamStatus from './StreamStatus.vue';
import GenerationRequestCard from './GenerationRequestCard.vue';
import {
  type AssistantRequest,
  type StewardView,
} from '../../../api/assistant';
import { useAssistantChat, type ChatMessage } from '../../../composables/useAssistantChat';

const props = defineProps<{ projectId: number; projectTitle?: string }>();
const expanded = ref(false);
const listElement = ref<HTMLElement | null>(null);
const editingProposal = ref<{ message: ChatMessage; values: Record<string, string> } | null>(null);
const trackJob = inject<(jobId: string) => void>('trackJob');
const reloadMaterials = inject<(opts?: { tab?: string; chapterNumber?: number }) => Promise<void>>('reloadMaterials');
const activeChapterNumber = inject<ComputedRef<number | null> | null>('activeChapterNumber', null);
const chat = useAssistantChat({ projectId: props.projectId, trackJob, reloadMaterials });

function getListElement(): HTMLElement | null {
  return listElement.value ?? document.querySelector('.message-list');
}

function send(): void { void chat.send(false, undefined, getListElement()); }
function retry(message: ChatMessage): void {
  // 优先用该消息对应的原始请求；历史消息（无 request）回退用户消息原文
  const request = message.request ?? chat.lastPayload.value;
  if (request) void chat.send(true, request, getListElement());
  else if (message.content) void chat.send(false, { content: message.content }, getListElement());
}
function continueGeneration(message: ChatMessage): void {
  void chat.continueFromFailure(message, getListElement());
}

/** 重新发送用户消息：以相同内容再发起一次请求（作为新的对话轮次）。 */
function resend(message: ChatMessage): void {
  if (!message.content) return;
  void chat.send(false, { content: message.content }, getListElement());
}

async function refreshMaterials(): Promise<void> {
  await reloadMaterials?.();
  ElMessage.success('项目资料已刷新');
}

async function copy(message: ChatMessage): Promise<void> {
  try { await navigator.clipboard.writeText(message.content); ElMessage.success('已复制'); } catch { ElMessage.warning('复制失败，请手动选择文本'); }
}

async function remove(message: ChatMessage): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后这条消息不会再进入项目上下文，确定删除吗？', '删除消息', { type: 'warning' });
    await chat.remove(message);
    ElMessage.success('已删除');
  } catch { /* 用户取消或请求失败 */ }
}

async function newConversation(): Promise<void> {
  try {
    await ElMessageBox.confirm('清空当前对话历史并从零开始，确定新建对话吗？', '新建对话', { type: 'warning' });
    await chat.clear();
    ElMessage.success('已新建对话');
  } catch { /* 用户取消或请求失败 */ }
}

function startRevise(message: ChatMessage): void {
  const steward = message.steward;
  if (!steward) return;
  editingProposal.value = { message, values: Object.fromEntries(steward.proposals.filter((row) => row.requiresConfirmation).map((row) => [row.field, row.value])) };
}

async function submitRevision(): Promise<void> {
  const editing = editingProposal.value;
  const steward: StewardView | undefined = editing?.message.steward;
  if (!editing || !steward) return;
  const request: AssistantRequest = {
    content: '修改方案',
    stewardAction: 'revise',
    proposalId: steward.proposalId,
    sourceVersion: steward.sourceVersion,
    continuationMode: steward.continuationMode,
    proposalEdits: Object.entries(editing.values).map(([field, value]) => ({ field, value })),
  };
  editingProposal.value = null;
  await chat.send(true, request, getListElement());
}

const latestManifest = computed(() => [...chat.messages.value].reverse().find((message) => message.contextManifest)?.contextManifest);

onMounted(() => { void chat.load(); void nextTick(() => { listElement.value = document.querySelector('.message-list'); }); });
</script>

<template>
  <section class="assistant-workspace" :class="{ expanded }" aria-label="小说助手聊天">
    <ConversationHeader :project-title="projectTitle" :chapter-number="activeChapterNumber" :expanded="expanded" @new-conversation="newConversation" @toggle-expand="expanded = !expanded" />
    <div class="chat-body">
      <MessageList
        :messages="chat.messages.value"
        :pending-steward="chat.pendingSteward"
        :history-error="chat.historyError.value"
        :sending="chat.sending.value"
        @scroll="chat.updateBottomState"
        @copy="copy"
        @retry="retry"
        @continue-generation="continueGeneration"
        @remove="remove"
        @resend="resend"
        @refresh="refreshMaterials"
        @steward="(message, action) => chat.sendSteward(message, action, getListElement())"
        @revise="startRevise"
        @open-tab="(tab, chapterNumber) => reloadMaterials?.({ tab, chapterNumber })"
        @open-seed="(chapterNumber) => reloadMaterials?.({ tab: 'seed', chapterNumber })"
      />
    </div>
    <StreamStatus :sending="chat.sending.value" :manifest="latestManifest" @stop="chat.stop" />
    <div v-if="chat.panelError.value" class="panel-error">
      <strong>{{ chat.panelError.value.reason }}</strong>
      <button v-if="chat.panelError.value.recoverable" type="button" @click="chat.send(true, undefined, getListElement())">重试</button>
    </div>
    <GenerationRequestCard
      v-if="chat.jobSubmitted.value"
      class="panel-job"
      :job-id="chat.jobSubmitted.value.jobId"
      :chapter-number="chat.jobSubmitted.value.chapterNumber"
      @open="reloadMaterials?.({ tab: 'chapter', chapterNumber: chat.jobSubmitted.value?.chapterNumber })"
    />
    <Composer v-model="chat.input.value" :sending="chat.sending.value" @send="send" @stop="chat.stop" />

    <el-dialog v-model="editingProposal" title="修改方案" width="420px" append-to-body>
      <div v-if="editingProposal" class="proposal-editor">
        <label v-for="(value, field) in editingProposal.values" :key="field">
          {{ field }}
          <el-input v-model="editingProposal.values[field]" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }" />
        </label>
      </div>
      <template #footer><el-button @click="editingProposal = null">取消</el-button><el-button type="primary" @click="submitRevision">提交修改</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.assistant-workspace { display: flex; flex: 1; min-height: 0; flex-direction: column; background: var(--el-bg-color); }
.assistant-workspace.expanded { position: fixed; z-index: 20; inset: 0; width: 100vw; height: 100vh; }
.chat-body { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; }
.panel-error { display: flex; justify-content: space-between; gap: 8px; margin: 0 12px 6px; padding: 7px 9px; border-radius: 5px; font-size: 12px; background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.panel-error button { border: 0; background: transparent; color: inherit; cursor: pointer; }
.panel-job { margin: 0 12px 6px; }
.panel-job :deep(.generation-card) { margin-top: 0; }
.proposal-editor { display: grid; gap: 12px; }
.proposal-editor label { display: grid; gap: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 720px) {
  .assistant-workspace:not(.expanded) { position: fixed; z-index: 10; inset: auto 0 0; height: min(82vh, 680px); border-top: 1px solid var(--el-border-color); box-shadow: 0 -4px 20px rgba(0, 0, 0, .12); }
}
</style>
