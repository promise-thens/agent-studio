<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { PhWarning as Warning } from '@phosphor-icons/vue'

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)

onMounted(() => {
  void nextTick(() => cancelButton.value?.focus())
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <section
      class="permission-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="takeover-confirm-title"
      aria-describedby="takeover-confirm-description"
      @keydown.esc="emit('cancel')"
    >
      <header>
        <div class="permission-icon" data-risk="L3">
          <Warning :size="22" weight="fill" />
        </div>
        <div>
          <h2 id="takeover-confirm-title">让 Grok 完全接管当前任务？</h2>
          <div id="takeover-confirm-description">
            <p>将不再询问工具权限</p>
            <p>桌面看不到未上报的操作</p>
            <p>命令、改文件、出网都会自己做</p>
            <p>若已启用浏览器或 Computer Use 插件，也会自己点</p>
          </div>
        </div>
      </header>
      <div class="permission-options">
        <button
          ref="cancelButton"
          class="primary-button"
          type="button"
          title="取消"
          autofocus
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          class="danger-secondary-button"
          type="button"
          title="开始接管"
          @click="emit('confirm')"
        >
          开始接管
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.permission-dialog header {
  grid-template-columns: 38px minmax(0, 1fr);
}

.danger-secondary-button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 58%, var(--border));
  border-radius: var(--radius-soft);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}

.danger-secondary-button:hover {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
}
</style>
