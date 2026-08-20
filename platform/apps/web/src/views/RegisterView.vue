<script setup lang="ts">
/**
 * 注册页：邮箱 + 密码 + 确认密码 + 昵称，注册成功即登录并跳转门户首页。
 */
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  nickname: '',
});
const loading = ref(false);

async function onSubmit(): Promise<void> {
  if (form.password !== form.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致');
    return;
  }
  loading.value = true;
  try {
    await auth.register(form.email, form.password, form.nickname);
    await router.push({ name: 'portal-home' });
  } catch {
    // 错误提示由 http 拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

async function goLogin(): Promise<void> {
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="register-page">
    <el-card class="register-card">
      <template #header>
        <h2 class="register-title">注册 PiNovel 平台</h2>
      </template>
      <el-form :model="form" label-position="top" @submit.prevent="onSubmit">
        <el-form-item label="邮箱">
          <el-input v-model="form.email" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="至少 8 位"
          />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            placeholder="再次输入密码"
          />
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="form.nickname" placeholder="1-32 字符" />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            :loading="loading"
            style="width: 100%"
          >
            注册
          </el-button>
        </el-form-item>
        <div class="register-footer">
          已有账号？
          <el-button text type="primary" @click="goLogin">返回登录</el-button>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.register-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--el-fill-color-light);
}
.register-card {
  width: 380px;
}
.register-title {
  margin: 0;
  font-size: 18px;
  text-align: center;
}
.register-footer {
  text-align: center;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
</style>
