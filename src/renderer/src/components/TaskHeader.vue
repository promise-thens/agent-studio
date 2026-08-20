<script setup lang="ts">
import { computed } from 'vue'
import { resolveTaskHeaderMainPath, type TaskHeaderFacts } from '../task-composer-actions'

const props = defineProps<{
  facts: TaskHeaderFacts
  loadError?: boolean
}>()

defineEmits<{
  retryLoad: []
}>()

const mainPath = computed(() => resolveTaskHeaderMainPath(props.facts))
</script>

<template>
  <header class="task-header" :data-execution="mainPath.executionScope">
    <div class="task-header-copy">
      <h1 :title="mainPath.title">{{ mainPath.title }}</h1>
      <p
        class="task-header-status"
        role="status"
        :data-runtime-state="mainPath.runtimeState"
        :data-execution="mainPath.executionScope"
      >
        {{ mainPath.weakStatusLine }}
        <button
          v-if="loadError"
          class="task-header-retry"
          type="button"
          title="重试加载"
          aria-label="重试加载"
          @click="$emit('retryLoad')"
        >
          重试
        </button>
      </p>
    </div>
  </header>
</template>
