<template>
  <div class="flex h-full flex-col">
    <!-- 工具栏 -->
    <div class="border-b border-gray-200 px-6 py-3 dark:border-dark-700">
      <h2 class="text-lg font-bold text-gray-900 dark:text-dark-50">{{ title }}</h2>
      <div class="mt-2 flex items-center justify-between">
        <div class="flex items-center gap-3 text-sm text-gray-500">
          <span>{{ wordCount }} 字</span>
          <span :class="saveStateClass">{{ saveStateText }}</span>
          <span v-if="conflictServerVersion != null" class="text-xs text-red-500">
            服务端已更新至 v{{ conflictServerVersion }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="saveState === 'conflict'"
            class="btn btn-ghost btn-sm"
            @click="reloadServerVersion"
          >
            加载服务端版本
          </button>
          <button class="btn btn-primary btn-sm" :disabled="saveState === 'saving'" @click="save">
            {{ saveState === 'saving' ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 正文编辑区 -->
    <textarea
      v-model="content"
      class="flex-1 resize-none bg-transparent px-6 py-4 font-mono text-sm leading-relaxed text-gray-800 outline-none dark:text-dark-100"
      placeholder="在此输入内容..."
      @keydown="onKeydown"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { getDocument, putDocument } from '@/features/novel-studio/api'
import { useOptimisticLock } from '@/features/novel-studio/useOptimisticLock'

const props = defineProps<{
  projectId: string
  docType: string
  title: string
}>()

const content = ref('')
const loaded = ref(false)

const lock = useOptimisticLock({ initialVersion: 1 })
const { version, saveState, conflictServerVersion, executeSave, setVersion, resetConflict } = lock

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastSavedContent = ''
const DEBOUNCE_MS = 1000

const wordCount = computed(() => Array.from(content.value).length)

const saveStateText = computed(() => {
  switch (saveState.value) {
    case 'saved': return '已保存'
    case 'saving': return '保存中...'
    case 'error': return '保存失败'
    case 'conflict': return '版本冲突'
    default: return ''
  }
})

const saveStateClass = computed(() => {
  switch (saveState.value) {
    case 'saved': return 'text-green-500'
    case 'saving': return 'text-blue-500'
    case 'error': return 'text-red-500'
    case 'conflict': return 'text-red-500'
    default: return 'text-gray-400'
  }
})

function hasUnsavedChanges(): boolean {
  return content.value !== lastSavedContent
}

async function doSave(): Promise<void> {
  if (saveState.value === 'conflict') return
  if (!hasUnsavedChanges()) {
    saveState.value = 'saved'
    return
  }
  await executeSave(
    { content: content.value, version: version.value },
    async (data, expectedVersion) => {
      const updated = await putDocument(props.projectId, props.docType, {
        content: data.content,
        expected_version: expectedVersion,
      })
      return { content: updated.content, version: updated.version }
    },
  )
  if (saveState.value === 'saved') {
    lastSavedContent = content.value
  }
}

function scheduleSave(): void {
  if (saveState.value === 'conflict') return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void doSave()
  }, DEBOUNCE_MS)
}

async function save(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  await doSave()
}

async function reloadServerVersion(): Promise<void> {
  try {
    const fresh = await getDocument(props.projectId, props.docType)
    content.value = fresh.content
    setVersion(fresh.version)
    lastSavedContent = fresh.content
    resetConflict()
  } catch {
    saveState.value = 'error'
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    void save()
  }
}

watch(content, () => {
  if (saveState.value !== 'conflict' && loaded.value) {
    scheduleSave()
  }
})

async function loadDocument() {
  try {
    const doc = await getDocument(props.projectId, props.docType)
    content.value = doc.content
    setVersion(doc.version)
    lastSavedContent = doc.content
  } catch {
    // document not found — start with empty content
    content.value = ''
    setVersion(1)
    lastSavedContent = ''
  } finally {
    loaded.value = true
  }
}

watch(() => [props.projectId, props.docType], loadDocument, { immediate: true })

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>
