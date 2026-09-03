<script setup lang="ts">
defineProps<{
  message: string
  probing?: boolean
  openingSettings?: boolean
}>()

defineEmits<{
  openSettings: []
  retry: []
}>()
</script>

<template>
  <aside v-if="message" class="macos-folder-access-banner" role="status">
    <p>{{ message }}</p>
    <div class="macos-folder-access-banner-actions">
      <button
        type="button"
        title="打开系统设置中的文件和文件夹权限"
        aria-label="打开系统设置中的文件和文件夹权限"
        :disabled="openingSettings"
        @click="$emit('openSettings')"
      >
        打开系统设置
      </button>
      <button
        type="button"
        title="重新检测文件夹权限"
        aria-label="重新检测文件夹权限"
        :disabled="probing"
        @click="$emit('retry')"
      >
        重新检测
      </button>
    </div>
  </aside>
</template>

<style scoped>
.macos-folder-access-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--danger) 10%, var(--surface-1));
  color: var(--text-1);
}

.macos-folder-access-banner p {
  margin: 0;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
}

.macos-folder-access-banner-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.macos-folder-access-banner button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-chip);
  color: var(--text-1);
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.macos-folder-access-banner button:hover:not(:disabled) {
  background: var(--hover-fill);
}

.macos-folder-access-banner button:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .macos-folder-access-banner button {
    transition: none;
  }
}
</style>
