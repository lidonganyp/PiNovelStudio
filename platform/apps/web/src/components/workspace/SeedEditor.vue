<script setup lang="ts">
/**
 * P5-2 种子编辑器：写前章纲六要素表单；
 * intent 与 endingGoal 必填（后端提交生成时校验），
 * 保存后可一键提交生成任务。
 */
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { upsertSeed, type Chapter } from '../../api/chapters';

const props = defineProps<{
  projectId: number;
  chapter: Chapter;
}>();

const emit = defineEmits<{
  updated: [chapter: Chapter];
  generate: [];
}>();

const FIELDS: Array<{ key: keyof FormState; label: string; placeholder: string; required?: boolean }> = [
  {
    key: 'intent',
    label: '本章意图（必填）',
    placeholder: '这一章要推进什么：核心事件、转折或信息释放',
    required: true,
  },
  {
    key: 'endingGoal',
    label: '章末目标（必填）',
    placeholder: '章末落到什么状态：钩子、悬念或情绪落点',
    required: true,
  },
  {
    key: 'mustInclude',
    label: '必须包含',
    placeholder: '必须出现的事实 / 场景 / 互动（可留空）',
  },
  {
    key: 'forbiddenFacts',
    label: '禁止事项',
    placeholder: '不得违背的事实 / 不得出现的剧透（可留空）',
  },
  {
    key: 'characterMotives',
    label: '人物动机',
    placeholder: '参与角色在本章的动机与目标（可留空）',
  },
  {
    key: 'promises',
    label: '伏笔与承诺',
    placeholder: '本章埋设或兑现的伏笔（可留空）',
  },
];

interface FormState {
  intent: string;
  endingGoal: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
}

const form = reactive<FormState>({
  intent: '',
  endingGoal: '',
  mustInclude: '',
  forbiddenFacts: '',
  characterMotives: '',
  promises: '',
});

watch(
  () => props.chapter.seed,
  (seed) => {
    form.intent = seed?.intent ?? '';
    form.endingGoal = seed?.endingGoal ?? '';
    form.mustInclude = seed?.mustInclude ?? '';
    form.forbiddenFacts = seed?.forbiddenFacts ?? '';
    form.characterMotives = seed?.characterMotives ?? '';
    form.promises = seed?.promises ?? '';
  },
  { immediate: true },
);

const saving = ref(false);

const ready = computed(() => form.intent.trim() !== '' && form.endingGoal.trim() !== '');

async function save(): Promise<void> {
  saving.value = true;
  try {
    await upsertSeed(props.projectId, props.chapter.id, {
      ...form,
      expectedVersion: props.chapter.seed?.version ?? 1,
    });
    ElMessage.success('种子已保存');
  } finally {
    saving.value = false;
  }
}

async function saveAndGenerate(): Promise<void> {
  if (!ready.value) {
    ElMessage.warning('本章意图与章末目标为必填项');
    return;
  }
  saving.value = true;
  try {
    await upsertSeed(props.projectId, props.chapter.id, {
      ...form,
      expectedVersion: props.chapter.seed?.version ?? 1,
    });
    emit('generate');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="seed-editor">
    <el-alert
      v-if="chapter.seed?.status === 'consumed'"
      type="info"
      :closable="false"
      title="本种子已消费：上次生成已使用当前种子内容，修改后可再次生成。"
      class="consumed-tip"
    />
    <el-form label-position="top">
      <el-form-item v-for="field in FIELDS" :key="field.key" :label="field.label">
        <el-input
          v-model="form[field.key]"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          :placeholder="field.placeholder"
        />
      </el-form-item>
    </el-form>
    <div class="actions">
      <el-button :loading="saving" @click="save">仅保存</el-button>
      <el-tooltip
        content="提交统一主链路生成任务：预占额度 → Agentic 初稿 → 作者风格优化 → 事实复检 → 落库"
        placement="top"
      >
        <el-button type="primary" :loading="saving" :disabled="!ready" @click="saveAndGenerate">
          保存并生成
        </el-button>
      </el-tooltip>
    </div>
  </div>
</template>

<style scoped>
.seed-editor {
  max-width: 720px;
  padding-bottom: 8px;
}
.consumed-tip {
  margin-bottom: 12px;
}
.actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 0;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>
