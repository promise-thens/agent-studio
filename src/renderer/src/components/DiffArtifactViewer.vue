<script setup lang="ts">
import type { FileDiffResult } from '../../../shared/git-review'
import FileDiffViewer from './FileDiffViewer.vue'

defineProps<{
  path: string
  diff: FileDiffResult | null
  loading?: boolean
  errorMessage?: string
}>()

defineEmits<{
  retry: []
}>()
</script>

<template>
  <FileDiffViewer
    :path="path"
    :diff="diff"
    :loading="loading"
    :error-message="errorMessage"
    @retry="$emit('retry')"
  />
</template>
