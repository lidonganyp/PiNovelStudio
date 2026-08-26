<script setup lang="ts">
import { computed } from 'vue';
import type { ContextManifest } from '../../../composables/useAssistantChat';

const props = defineProps<{ sending: boolean; manifest?: ContextManifest }>();
const emit = defineEmits<{ stop: [] }>();

const summary = computed(() => {
  const manifest = props.manifest;
  if (!manifest) return '';
  const omitted = manifest.truncatedBlocks?.length ? `，截断 ${manifest.truncatedBlocks.length} 块` : '';
  return `上下文 ${manifest.totalTokensUsed.toLocaleString()} / ${manifest.totalTokenBudget.toLocaleString()} tokens${omitted}`;
});

const coverageRows = computed(() => {
  const coverage = props.manifest?.retrievalCoverage;
  if (!coverage) return [];
  return Object.entries(coverage).map(([key, value]) => ({ key, value: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value) }));
});

const percent = computed(() => {
  const manifest = props.manifest;
  if (!manifest || !manifest.totalTokenBudget) return 0;
  return Math.min(100, Math.round((manifest.totalTokensUsed / manifest.totalTokenBudget) * 100));
});
</script>

<template>
  <div v-if="sending || summary" class="stream-status" aria-live="polite">
    <span v-if="sending"><span class="dot" /> 正在生成回复</span>
    <el-popover v-if="manifest" placement="top-end" :width="340" trigger="click" popper-class="context-manifest-popover">
      <template #reference>
        <button type="button" class="tokens" title="查看上下文占用明细">{{ summary }}</button>
      </template>
      <div class="manifest">
        <div class="manifest-title">上下文占用明细<span v-if="manifest.profile"> · {{ manifest.profile }}</span></div>
        <div class="manifest-bar"><span class="manifest-bar-fill" :style="{ width: percent + '%' }" /></div>
        <dl class="manifest-stats">
          <div><dt>预算内用量</dt><dd>{{ manifest.totalTokensUsed.toLocaleString() }} / {{ manifest.totalTokenBudget.toLocaleString() }} tokens（{{ percent }}%）</dd></div>
          <div v-if="manifest.estimatedInputTokens != null"><dt>预估输入 inputTokens</dt><dd>{{ manifest.estimatedInputTokens.toLocaleString() }}</dd></div>
          <div v-if="manifest.actualInputTokens != null"><dt>实际输入 inputTokens</dt><dd>{{ manifest.actualInputTokens.toLocaleString() }}</dd></div>
          <div v-if="manifest.actualOutputTokens != null"><dt>实际输出 outputTokens</dt><dd>{{ manifest.actualOutputTokens.toLocaleString() }}</dd></div>
        </dl>
        <div v-if="manifest.truncatedBlocks?.length" class="manifest-block">
          <div class="manifest-subtitle">已截断资料块（truncatedBlocks）</div>
          <ul><li v-for="name in manifest.truncatedBlocks" :key="name">{{ name }}</li></ul>
        </div>
        <div v-if="coverageRows.length" class="manifest-block">
          <div class="manifest-subtitle">检索覆盖（retrievalCoverage）</div>
          <ul><li v-for="row in coverageRows" :key="row.key">{{ row.key }}：{{ row.value }}</li></ul>
        </div>
        <div class="manifest-block">
          <div class="manifest-subtitle">资料块清单（contextManifest.blocks）</div>
          <table>
            <thead><tr><th>资料块</th><th>状态</th><th>tokens</th></tr></thead>
            <tbody>
              <tr v-for="block in manifest.blocks" :key="block.name" :class="{ omitted: !block.included }">
                <td :title="block.omittedReason">{{ block.name }}</td>
                <td>{{ block.included ? '已注入' : '未注入' }}</td>
                <td>{{ block.tokensUsed.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </el-popover>
    <button v-if="sending" type="button" class="stop" @click="emit('stop')">停止</button>
  </div>
</template>

<style scoped>
.stream-status { display: flex; align-items: center; gap: 8px; min-height: 24px; padding: 0 12px; color: var(--el-text-color-secondary); font-size: 11px; }
.dot { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--el-color-primary); animation: pulse 1s infinite; }
.tokens { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font-size: 11px; }
.tokens:hover { color: var(--el-color-primary); text-decoration: underline; }
.stop { border: 0; background: transparent; color: var(--el-color-danger); cursor: pointer; font-size: 11px; }
@keyframes pulse { 50% { opacity: .35; } }
</style>

<style>
.context-manifest-popover .manifest { display: grid; gap: 10px; font-size: 12px; }
.context-manifest-popover .manifest-title { font-weight: 600; }
.context-manifest-popover .manifest-bar { height: 6px; border-radius: 3px; background: var(--el-fill-color-dark); overflow: hidden; }
.context-manifest-popover .manifest-bar-fill { display: block; height: 100%; background: var(--el-color-primary); }
.context-manifest-popover .manifest-stats { display: grid; gap: 4px; margin: 0; }
.context-manifest-popover .manifest-stats > div { display: flex; justify-content: space-between; gap: 12px; }
.context-manifest-popover .manifest-stats dt { color: var(--el-text-color-secondary); }
.context-manifest-popover .manifest-stats dd { margin: 0; }
.context-manifest-popover .manifest-subtitle { margin-bottom: 3px; color: var(--el-text-color-secondary); font-size: 11px; }
.context-manifest-popover .manifest-block ul { max-height: 120px; overflow: auto; margin: 0; padding-left: 16px; }
.context-manifest-popover .manifest-block table { width: 100%; border-collapse: collapse; }
.context-manifest-popover .manifest-block th, .context-manifest-popover .manifest-block td { padding: 2px 4px; border-bottom: 1px solid var(--el-border-color-lighter); text-align: left; }
.context-manifest-popover .manifest-block td:first-child { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-manifest-popover .manifest-block tr.omitted td { color: var(--el-text-color-secondary); }
</style>
