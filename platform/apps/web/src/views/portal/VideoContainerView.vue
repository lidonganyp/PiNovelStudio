<template>
  <div class="video-container-wrapper">
    <div class="video-header">
      <el-button :icon="ArrowLeft" size="small" @click="goBack">返回工作台</el-button>
      <span class="video-title">视频生成工作台</span>
    </div>
    <div id="pivideo-container" class="pivideo-mount"></div>
  </div>
</template>
<script setup lang="ts">
import { useRouter } from "vue-router";
import { ArrowLeft } from "@element-plus/icons-vue";
const router = useRouter();
const goBack = () => router.back();
</script>
<style scoped>
.video-container-wrapper { height: 100vh; display: flex; flex-direction: column; }
.video-header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: #f5f7fa; border-bottom: 1px solid #e4e7ed; }
.video-title { font-size: 16px; font-weight: 600; color: #303133; }
.pivideo-mount { flex: 1; min-height: 0; overflow: hidden; }
</style>
