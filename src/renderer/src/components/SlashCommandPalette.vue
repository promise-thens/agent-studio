<script setup lang="ts">
import { SLASH_RUNTIME_WAITING_COPY, type SlashCommandItem } from '../slash-command-palette'

defineProps<{
  items: SlashCommandItem[]
  activeIndex: number
  waiting: boolean
}>()

defineEmits<{
  select: [item: SlashCommandItem]
}>()
</script>

<template>
  <div class="slash-command-palette">
    <p v-if="waiting" class="slash-command-waiting">{{ SLASH_RUNTIME_WAITING_COPY }}</p>
    <div id="slash-command-list" role="listbox" aria-label="斜杠命令">
      <button
        v-for="(item, index) in items"
        :id="`slash-command-${item.id}`"
        :key="item.id"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        :title="`/${item.name}`"
        @mousedown.prevent
        @click="$emit('select', item)"
      >
        <span class="slash-command-name">/{{ item.name }}</span>
        <span class="slash-command-description">{{ item.description }}</span>
        <span v-if="item.inputHint" class="slash-command-hint">{{ item.inputHint }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.slash-command-palette {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 12;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-soft);
  color: var(--text-1);
  background: var(--surface-2);
  box-shadow: 0 18px 48px rgb(2 5 9 / 46%);
}

.slash-command-waiting {
  margin: 0;
  padding: 8px 12px 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.45;
}

[role='listbox'] {
  max-height: min(280px, 42vh);
  overflow-y: auto;
  padding: 6px;
}

[role='option'] {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: baseline;
  column-gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  color: var(--text-2);
  text-align: left;
  background: transparent;
  cursor: pointer;
}

[role='option'][aria-selected='true'],
[role='option']:hover {
  color: var(--text-1);
  background: var(--surface-3);
}

.slash-command-name {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-command-description,
.slash-command-hint {
  overflow: hidden;
  min-width: 0;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-command-hint {
  grid-column: 1 / -1;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .slash-command-palette {
    box-shadow: none;
  }
}
</style>
