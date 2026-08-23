<script setup lang="ts">
import { commandInconsistencyLabel, formatCommandDuration } from '../command-evidence-presentation'
import type { TaskResultReviewModel, TimelineCommandEvidenceView } from '../task-timeline-reducer'

/** 结果审阅卡片暂时不挂到对话里；数据层仍计算 resultReview，便于以后再接回。 */

defineProps<{
  model: TaskResultReviewModel
  canResume?: boolean
  resumePending?: boolean
  canCreateTask?: boolean
  hideChangedPaths?: boolean
}>()

defineEmits<{
  resumeTask: []
  createTask: []
}>()

/** 将没有可用值的审阅能力明确标注为未观察或未接入，避免结果卡暗示成功。 */
function availabilityLabel(model: {
  availability: 'observed' | 'not-observed' | 'unavailable'
  reason?: string
  outcome?: string
}): string {
  if (model.availability === 'observed') {
    if (model.outcome === 'pass') return '通过'
    if (model.outcome === 'fail') return model.reason ? `未通过（${model.reason}）` : '未通过'
    if (model.outcome === 'unknown') return model.reason ? `未知（${model.reason}）` : '未知'
    return '已观察'
  }
  return model.reason ?? (model.availability === 'unavailable' ? '能力尚未接入' : '本轮未提供')
}

function usageLabel(model: TaskResultReviewModel): string {
  const usage = model.usage
  if (!usage || 'availability' in usage) return usage ? availabilityLabel(usage) : '本轮未提供'
  return `${usage.value.totalTokens ?? '已提供'} tokens（来源：${usage.source}）`
}

function exitCodeLabel(command: TimelineCommandEvidenceView): string {
  return command.exitCode === undefined ? '未上报' : String(command.exitCode)
}

function durationLabel(command: TimelineCommandEvidenceView): string {
  return command.durationMs === undefined ? '未记录' : formatCommandDuration(command.durationMs)
}

function inconsistencyLabel(command: TimelineCommandEvidenceView): string {
  if (!command.inconsistency) return ''
  const label = commandInconsistencyLabel(command.inconsistency)
  return command.exitCode === undefined ? label : `${label}（退出码 ${command.exitCode}）`
}
</script>

<template>
  <section class="task-result-review" aria-label="结果审阅">
    <header class="task-result-review-heading">
      <div>
        <h2>结果审阅</h2>
        <p>基于已持久化的 Turn、事件、命令证据和审计事实生成。</p>
      </div>
      <span class="result-status" :data-status="model.status.value">
        {{ model.status.value }}
      </span>
    </header>

    <dl class="result-facts">
      <div>
        <dt>Usage</dt>
        <dd>{{ usageLabel(model) }}</dd>
      </div>
      <div v-if="!hideChangedPaths">
        <dt>修改路径</dt>
        <dd>
          <template v-if="model.changedPaths.availability === 'observed'">
            {{ model.changedPaths.count }} 个已观察路径
          </template>
          <template v-else>本轮未提供 Diff 引用</template>
        </dd>
      </div>
      <div>
        <dt>验证</dt>
        <dd>{{ availabilityLabel(model.validations) }}</dd>
      </div>
      <div>
        <dt>Artifact</dt>
        <dd>{{ availabilityLabel(model.artifacts) }}</dd>
      </div>
    </dl>

    <ul v-if="model.commands.length" class="command-evidence-list" aria-label="命令证据">
      <li v-for="command in model.commands" :key="command.commandId" class="command-evidence-item">
        <p class="command-evidence-command">{{ command.displayCommand }}</p>
        <dl class="command-evidence-facts">
          <div>
            <dt>来源</dt>
            <dd>{{ command.sourceLabel }}</dd>
          </div>
          <div>
            <dt>可信度</dt>
            <dd>{{ command.trustLabel }}</dd>
          </div>
          <div>
            <dt>工作目录</dt>
            <dd>{{ command.cwdLabel }}</dd>
          </div>
          <div>
            <dt>退出码</dt>
            <dd>{{ exitCodeLabel(command) }}</dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd>{{ durationLabel(command) }}</dd>
          </div>
          <div>
            <dt>超时</dt>
            <dd>{{ command.timedOut ? '是' : '否' }}</dd>
          </div>
          <div>
            <dt>截断</dt>
            <dd>{{ command.truncated ? '是' : '否' }}</dd>
          </div>
        </dl>
        <p v-if="command.inconsistency" class="command-evidence-incomplete" role="status">
          {{ inconsistencyLabel(command) }}
        </p>
        <p v-if="command.logIncomplete" class="command-evidence-incomplete" role="status">
          {{ command.logIncompleteReason ?? '日志不完整' }}
        </p>
      </li>
    </ul>

    <ul v-if="model.warnings.length" class="result-warnings" role="status">
      <li v-for="warning in model.warnings" :key="warning">{{ warning }}</li>
    </ul>

    <div class="result-actions">
      <button
        v-if="canResume"
        class="secondary-button"
        type="button"
        :disabled="resumePending"
        @click="$emit('resumeTask')"
      >
        {{ resumePending ? '正在继续…' : '继续同一 Task' }}
      </button>
      <button
        class="secondary-button"
        type="button"
        :disabled="!canCreateTask"
        @click="$emit('createTask')"
      >
        创建新 Task
      </button>
    </div>
  </section>
</template>
