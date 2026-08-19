<script setup lang="ts">
import { computed } from 'vue'
import { parseAssistantMarkdown } from '../assistant-markdown'
import AssistantMarkdownInline from './AssistantMarkdownInline.vue'

const props = defineProps<{
  text: string
}>()

/** 每次流式追加整段重解析；半截围栏由解析器收成代码块。 */
const blocks = computed(() => parseAssistantMarkdown(props.text))
</script>

<template>
  <div class="assistant-markdown">
    <template v-for="(block, index) in blocks" :key="index">
      <h1 v-if="block.type === 'heading' && block.level === 1" class="assistant-md-heading">
        <AssistantMarkdownInline :nodes="block.children" />
      </h1>
      <h2 v-else-if="block.type === 'heading' && block.level === 2" class="assistant-md-heading">
        <AssistantMarkdownInline :nodes="block.children" />
      </h2>
      <h3 v-else-if="block.type === 'heading' && block.level === 3" class="assistant-md-heading">
        <AssistantMarkdownInline :nodes="block.children" />
      </h3>
      <ul v-else-if="block.type === 'list' && !block.ordered" class="assistant-md-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <AssistantMarkdownInline :nodes="item" />
        </li>
      </ul>
      <ol v-else-if="block.type === 'list' && block.ordered" class="assistant-md-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <AssistantMarkdownInline :nodes="item" />
        </li>
      </ol>
      <pre
        v-else-if="block.type === 'code'"
        class="assistant-md-pre"
      ><code>{{ block.value }}</code></pre>
      <div v-else-if="block.type === 'table'" class="assistant-md-table-wrap">
        <table class="assistant-md-table">
          <thead>
            <tr>
              <th v-for="(cell, cellIndex) in block.header" :key="cellIndex">
                <AssistantMarkdownInline :nodes="cell" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">
                <AssistantMarkdownInline :nodes="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="block.type === 'paragraph'" class="assistant-md-paragraph">
        <AssistantMarkdownInline :nodes="block.children" />
      </p>
    </template>
  </div>
</template>
