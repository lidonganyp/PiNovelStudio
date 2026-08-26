<script setup lang="ts">
/**
 * StewardProposalCard：生成前资料方案卡片。
 * 待确认时展示方案明细（字段/值/来源/缺口）与四操作；
 * 已处理时展示结论（已采用/已取消/草案已保存）。
 */
import { materialProposalLabel, type StewardView } from '../../../api/assistant';

const props = defineProps<{ steward: StewardView; pending?: boolean }>();
const emit = defineEmits<{
  steward: [action: 'apply_and_generate' | 'save_draft' | 'cancel'];
  revise: [];
}>();

function statusText(steward: StewardView): string {
  if (steward.proposalStatus === 'applied' || steward.generationJobId) return '已采用并提交生成';
  if (steward.proposalStatus === 'cancelled') return '已取消';
  if (steward.proposalStatus === 'draft_saved') return '草案已保存';
  if (steward.status === 'hard_blocked') return '资料不足，暂时无法提交生成';
  if (steward.status === 'auto_fill') return '可自动补齐，建议确认后生成';
  return '生成前需要确认资料';
}
</script>

<template>
  <section class="steward-card" :class="{ pending }" aria-label="生成资料方案">
    <header class="steward-head">
      <strong>生成方案 · 第 {{ steward.chapterNumber }} 章</strong>
      <span class="steward-status">{{ statusText(steward) }}</span>
    </header>
    <div v-if="steward.generationJobId" class="steward-job">任务编号：{{ steward.generationJobId }}</div>
    <div v-if="steward.proposals.length" class="proposal-list">
      <details v-for="row in steward.proposals" :key="row.field" class="proposal-row">
        <summary>
          <span class="field">{{ materialProposalLabel(row.field) }}</span>
          <span v-if="row.requiresConfirmation" class="confirm-mark">需确认</span>
          <span class="source">{{ row.source.length ? `来源：${row.source.join('、')}` : '待补' }}</span>
        </summary>
        <pre class="proposal-value">{{ row.value || '（空，需补充）' }}</pre>
      </details>
    </div>
    <div v-if="steward.missing?.length" class="missing">仍缺：{{ steward.missing.join('、') }}</div>
    <div v-if="pending" class="steward-actions">
      <button type="button" class="primary" @click="emit('steward', 'apply_and_generate')">采用并生成</button>
      <button type="button" @click="emit('revise')">修改方案</button>
      <button type="button" @click="emit('steward', 'save_draft')">仅保存草案</button>
      <button type="button" class="danger" @click="emit('steward', 'cancel')">取消</button>
    </div>
  </section>
</template>

<style scoped>
.steward-card { display: grid; gap: 7px; margin-top: 9px; padding: 9px 10px; border: 1px solid var(--el-color-warning-light-5); border-radius: 6px; background: var(--el-color-warning-light-9); color: var(--el-text-color-primary); font-size: 12px; }
.steward-card:not(.pending) { opacity: .82; }
.steward-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.steward-status { color: var(--el-text-color-secondary); }
.steward-job { color: var(--el-text-color-secondary); }
.proposal-list { display: grid; gap: 4px; }
.proposal-row summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; }
.proposal-row summary::-webkit-details-marker { display: none; }
.proposal-row summary::before { content: '▸'; color: var(--el-text-color-secondary); }
.proposal-row[open] summary::before { content: '▾'; }
.field { font-weight: 600; }
.confirm-mark { padding: 0 4px; border: 1px solid var(--el-color-warning); border-radius: 3px; color: var(--el-color-warning); font-size: 10px; }
.source { margin-left: auto; color: var(--el-text-color-secondary); font-size: 10px; }
.proposal-value { max-height: 160px; overflow: auto; margin: 4px 0 2px; padding: 6px; border-radius: 4px; background: var(--el-fill-color); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.missing { color: var(--el-color-danger); }
.steward-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.steward-actions button { padding: 3px 10px; border: 1px solid var(--el-border-color); border-radius: 5px; background: var(--el-bg-color); color: var(--el-text-color-primary); cursor: pointer; font-size: 12px; }
.steward-actions .primary { border-color: var(--el-color-primary); background: var(--el-color-primary); color: white; }
.steward-actions .danger { color: var(--el-color-danger); }
</style>
