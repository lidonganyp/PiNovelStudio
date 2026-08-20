<script setup lang="ts">
/**
 * 登录页：邮箱 + 密码，成功后跳转 redirect 参数指定的页面或门户首页。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const form = reactive({
  email: '',
  password: '',
});
const loading = ref(false);

async function onSubmit(): Promise<void> {
  loading.value = true;
  try {
    await auth.login(form.email, form.password);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect);
  } catch {
    // 错误提示由 http 拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

async function goRegister(): Promise<void> {
  await router.push({ name: 'register' });
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card">
      <template #header>
        <h2 class="login-title">登录 PiNovel 平台</h2>
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
        <el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            :loading="loading"
            style="width: 100%"
          >
            登录
          </el-button>
        </el-form-item>
        <div class="login-footer">
          还没有账号？
          <el-button text type="primary" @click="goRegister">立即注册</el-button>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--el-fill-color-light);
}
.login-card {
  width: 380px;
}
.login-title {
  margin: 0;
  font-size: 18px;
  text-align: center;
}
.login-footer {
  text-align: center;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
</style>
