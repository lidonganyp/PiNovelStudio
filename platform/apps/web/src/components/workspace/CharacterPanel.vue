<script setup lang="ts">
/**
 * P5-2 角色面板：列表 + 新建/编辑抽屉（name/roleType/aliases/identity/goals）。
 * 生成前 Preflight 要求至少一个角色，此处给出就绪提示。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ROLE_TYPES,
  createCharacter,
  listCharacters,
  removeCharacter,
  updateCharacter,
  type NovelCharacter,
} from '../../api/workspace';

const props = defineProps<{ projectId: number }>();

const items = ref<NovelCharacter[]>([]);
const loading = ref(false);
const drawerVisible = ref(false);
const saving = ref(false);
const editingId = ref<number | null>(null);

const form = reactive({
  name: '',
  roleType: 'protagonist',
  aliasesText: '',
  identity: '',
  goals: '',
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await listCharacters(props.projectId);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = null;
  form.name = '';
  form.roleType = 'protagonist';
  form.aliasesText = '';
  form.identity = '';
  form.goals = '';
  drawerVisible.value = true;
}

function openEdit(character: NovelCharacter): void {
  editingId.value = character.id;
  form.name = character.name;
  form.roleType = character.roleType;
  form.aliasesText = (character.aliases ?? []).join('、');
  form.identity = character.identity;
  form.goals = character.goals;
  drawerVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('角色名必填');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      roleType: form.roleType,
      aliases: form.aliasesText
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      identity: form.identity,
      goals: form.goals,
    };
    if (editingId.value === null) {
      await createCharacter(props.projectId, payload);
      ElMessage.success('角色已创建');
    } else {
      await updateCharacter(props.projectId, editingId.value, payload);
      ElMessage.success('角色已更新');
    }
    drawerVisible.value = false;
    void load();
  } finally {
    saving.value = false;
  }
}

function onDelete(character: NovelCharacter): void {
  void ElMessageBox.confirm(
    `删除角色「${character.name}」？`,
    '删除角色',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  )
    .then(async () => {
      await removeCharacter(props.projectId, character.id);
      ElMessage.success('已删除');
      void load();
    })
    .catch(() => {
      /* 用户取消 */
    });
}

function roleLabel(value: string): string {
  return ROLE_TYPES.find((r) => r.value === value)?.label ?? value;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="character-panel" v-loading="loading">
    <div class="toolbar">
      <el-alert
        v-if="items.length === 0"
        type="warning"
        :closable="false"
        title="尚无角色：正式生成前 Preflight 要求至少一个角色档案。"
      />
      <el-button type="primary" @click="openCreate">+ 新建角色</el-button>
    </div>
    <el-empty v-if="!loading && items.length === 0" description=" " :image-size="60" />
    <div class="list">
      <el-card v-for="character in items" :key="character.id" class="item" shadow="never">
        <div class="item-head">
          <span class="name">{{ character.name }}</span>
          <el-tag size="small">{{ roleLabel(character.roleType) }}</el-tag>
          <div class="item-actions">
            <el-button link type="primary" size="small" @click="openEdit(character)">编辑</el-button>
            <el-button link type="danger" size="small" @click="onDelete(character)">删除</el-button>
          </div>
        </div>
        <p class="identity">{{ character.identity || '未填写身份' }}</p>
        <p v-if="character.aliases?.length" class="aliases">
          别名：{{ character.aliases.join('、') }}
        </p>
        <p v-if="character.goals" class="goals">目标：{{ character.goals }}</p>
      </el-card>
    </div>

    <el-drawer v-model="drawerVisible" :title="editingId === null ? '新建角色' : '编辑角色'" size="420px">
      <el-form label-position="top">
        <el-form-item label="角色名" required>
          <el-input v-model="form.name" maxlength="100" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.roleType">
            <el-option
              v-for="role in ROLE_TYPES"
              :key="role.value"
              :value="role.value"
              :label="role.label"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="别名（顿号/逗号分隔）">
          <el-input v-model="form.aliasesText" placeholder="例如：小林、林队" />
        </el-form-item>
        <el-form-item label="身份">
          <el-input v-model="form.identity" type="textarea" :rows="2" placeholder="一句话身份设定" />
        </el-form-item>
        <el-form-item label="目标">
          <el-input v-model="form.goals" type="textarea" :rows="2" placeholder="角色想要什么" />
        </el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </el-form>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-bottom: 12px;
  align-items: center;
}
.toolbar .el-alert {
  flex: 1;
}
.list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  font-weight: 600;
}
.item-actions {
  margin-left: auto;
}
.identity,
.aliases,
.goals {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
