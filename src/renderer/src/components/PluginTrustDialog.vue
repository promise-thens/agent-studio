<script setup lang="ts">
import { ref } from 'vue'
import { PhWarningCircle as WarningCircle } from '@phosphor-icons/vue'
import { PLUGIN_TRUST_WARNING_COPY } from '../plugins-page'

const props = defineProps<{
  name: string
  sourceName: string
  busy?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const trusted = ref(false)

/** 未勾选不得发出确认；忙碌时也挡住重复点击。 */
function confirmTrust(): void {
  if (!trusted.value || props.busy) return
  emit('confirm')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="!busy && emit('cancel')">
    <section
      class="permission-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-trust-title"
      aria-describedby="plugin-trust-description"
      @keydown.esc="!busy && emit('cancel')"
    >
      <header>
        <div class="permission-icon">
          <WarningCircle :size="22" weight="fill" />
        </div>
        <div>
          <h2 id="plugin-trust-title">信任并安装</h2>
          <p id="plugin-trust-description">
            将安装「{{ name }}」，来源：{{ sourceName }}。{{ PLUGIN_TRUST_WARNING_COPY }}
          </p>
        </div>
      </header>
      <label class="trust-check">
        <input v-model="trusted" type="checkbox" :disabled="busy" />
        我信任该插件，并允许它以我的用户权限运行
      </label>
      <div class="permission-options">
        <button
          class="secondary-button"
          type="button"
          :disabled="busy"
          title="取消安装"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="!trusted"
          :aria-busy="busy ? 'true' : 'false'"
          :title="busy ? '正在安装' : trusted ? '信任并安装' : '勾选信任后才能安装'"
          @click="confirmTrust"
        >
          {{ busy ? '正在安装…' : '信任并安装' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 对齐历史确认框：第一列给 icon，警告句走 minmax(0,1fr)，避免落到全局 38px 图标列。 */
.permission-dialog header {
  grid-template-columns: 38px minmax(0, 1fr);
}

.trust-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 16px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.45;
}

.trust-check input {
  margin-top: 2px;
}

.permission-options {
  margin-top: 16px;
}
</style>
