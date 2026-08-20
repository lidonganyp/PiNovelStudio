<script setup lang="ts">
/**
 * P5-1 项目创建向导：三步（基本信息 → 类型设定 → 世界观关键词）→ 提交。
 * 提交成功跳转工作台。
 */
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { createProject } from '../../api/projects';

const router = useRouter();
const step = ref(0);
const submitting = ref(false);

const form = reactive({
  title: '',
  description: '',
  genre: '',
  subGenresText: '',
  worldKeyTermsText: '',
});

/** 表单校验状态。 */
const titleError = ref('');

function next(): void {
  if (step.value === 0) {
    titleError.value = form.title.trim() ? '' : '请填写项目标题';
    if (titleError.value) return;
  }
  step.value += 1;
}

function splitTerms(text: string): string[] {
  return text
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function submit(): Promise<void> {
  submitting.value = true;
  try {
    const created = await createProject({
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      genre: form.genre.trim() || undefined,
      subGenres: splitTerms(form.subGenresText),
      worldKeyTerms: splitTerms(form.worldKeyTermsText),
    });
    ElMessage.success('项目已创建');
    void router.push({ name: 'workspace', params: { id: created.id } });
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="create-page">
    <el-card class="wizard">
      <template #header>新建小说项目</template>
      <el-steps :active="step" simple finish-status="success">
        <el-step title="基本信息" />
        <el-step title="类型设定" />
        <el-step title="世界观关键词" />
      </el-steps>

      <div v-show="step === 0" class="pane">
        <el-form label-position="top">
          <el-form-item label="项目标题" :error="titleError">
            <el-input
              v-model="form.title"
              maxlength="200"
              show-word-limit
              placeholder="例如：星海之上"
            />
          </el-form-item>
          <el-form-item label="简介">
            <el-input
              v-model="form.description"
              type="textarea"
              :rows="4"
              maxlength="10000"
              placeholder="一句话或一段话概括这部作品（可留空）"
            />
          </el-form-item>
        </el-form>
      </div>

      <div v-show="step === 1" class="pane">
        <el-form label-position="top">
          <el-form-item label="主类型">
            <el-input
              v-model="form.genre"
              maxlength="50"
              placeholder="例如：科幻、都市、玄幻"
            />
          </el-form-item>
          <el-form-item label="子类型（逗号或换行分隔）">
            <el-input
              v-model="form.subGenresText"
              type="textarea"
              :rows="3"
              placeholder="例如：太空歌剧, 赛博朋克"
            />
          </el-form-item>
        </el-form>
      </div>

      <div v-show="step === 2" class="pane">
        <el-form label-position="top">
          <el-form-item label="世界观关键词（逗号或换行分隔）">
            <el-input
              v-model="form.worldKeyTermsText"
              type="textarea"
              :rows="4"
              placeholder="例如：曲率引擎, 星际联邦, 灵能"
            />
          </el-form-item>
          <el-alert
            type="info"
            :closable="false"
            title="创建后可在工作台补充角色档案与设定文档；首次生成前需至少一个角色。"
          />
        </el-form>
      </div>

      <div class="footer">
        <el-button v-if="step > 0" @click="step -= 1">上一步</el-button>
        <el-button v-if="step < 2" type="primary" @click="next">下一步</el-button>
        <el-button v-else type="primary" :loading="submitting" @click="submit">
          创建项目
        </el-button>
        <el-button @click="router.back()">取消</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.create-page {
  max-width: 640px;
  margin: 0 auto;
}
.wizard .pane {
  margin-top: 24px;
  min-height: 260px;
}
.footer {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
