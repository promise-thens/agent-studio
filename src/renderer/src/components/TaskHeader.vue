<script setup lang="ts">
import type { TaskHeaderFacts } from '../task-composer-actions'

defineProps<{
  facts: TaskHeaderFacts
  loadError?: boolean
}>()

defineEmits<{
  retryLoad: []
}>()
</script>

<template>
  <header class="task-header">
    <div class="task-header-copy">
      <h1 :title="facts.title">{{ facts.title }}</h1>
      <p v-if="facts.weakStatusLine" class="task-header-status" role="status">
        {{ facts.weakStatusLine }}
        <button
          v-if="loadError"
          class="history-load-more"
          type="button"
          @click="$emit('retryLoad')"
        >
          重试
        </button>
      </p>
    </div>
    <dl class="task-header-facts" aria-label="Task 固定事实">
      <div>
        <dt>Project</dt>
        <dd :title="facts.projectName">{{ facts.projectName }}</dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd>{{ facts.runtimeLabel || '—' }}</dd>
      </div>
      <div>
        <dt>模型</dt>
        <dd :title="facts.modelLabel || '未记录'">
          {{ facts.modelLabel || '未记录' }}
        </dd>
      </div>
      <div>
        <dt>环境</dt>
        <dd :title="`${facts.environmentLabel} · ${facts.worktreeLabel}`">
          {{ facts.environmentLabel }}
          <span class="task-header-worktree">{{ facts.worktreeLabel }}</span>
        </dd>
      </div>
      <div v-if="facts.stateLabel">
        <dt>状态</dt>
        <dd>{{ facts.stateLabel }}</dd>
      </div>
      <div v-if="facts.createdAtLabel">
        <dt>创建</dt>
        <dd>{{ facts.createdAtLabel }}</dd>
      </div>
    </dl>
  </header>
</template>
