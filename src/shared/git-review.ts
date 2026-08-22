/**
 * 主进程解析结果。绝对路径只留在主进程，本任务不经 IPC 交给 Renderer。
 */
export type ProjectGitPresence =
  | { kind: 'git'; gitRoot: string; head: GitHeadState; nested: boolean }
  | { kind: 'non-git'; reason: 'no-repository' | 'parent-escaped' | 'git-unavailable' }
  | { kind: 'invalid'; reason: 'root-missing' | 'not-directory' | 'escaped' | 'unavailable' }

export interface GitHeadState {
  oid: string | null
  branch: string | null
  detached: boolean
}

export interface ResolvedProjectRoot {
  taskId: string
  projectId: string
  environmentId: string
  environmentKind: 'local'
  executionRoot: string
  git: ProjectGitPresence
  resolvedAt: string
  /**
   * execution root 的设备/inode 指纹。仅主进程用于识别同路径目录被替换。
   */
  rootFingerprint?: string
}

export type TaskChangePathKind = 'tracked' | 'untracked'
export type TaskChangeBaselineStatus = 'captured' | 'invalid' | 'unavailable'

export interface TaskChangePathSnapshot {
  path: string
  kind: TaskChangePathKind
  statusCode?: string
  contentHash?: string
  omitted?: 'too-large' | 'binary' | 'limit'
}

export interface TaskChangeBaseline {
  schemaVersion: 1
  taskId: string
  environmentId: string
  environmentKind: 'local'
  executionRoot: string
  gitRoot?: string
  baseCommit?: string
  headBranch?: string
  detached?: boolean
  nestedGit?: boolean
  gitPresence: ProjectGitPresence['kind']
  capturedAt: string
  status: TaskChangeBaselineStatus
  invalidReason?:
    | 'git-root-changed'
    | 'head-changed'
    | 'path-replaced'
    | 'root-missing'
    | 'project-unavailable'
    | 'nested-changed'
  porcelainSummary?: string
  preExistingPaths: TaskChangePathSnapshot[]
  truncated?: true
  /**
   * execution root 的设备/inode 指纹。仅主进程用于识别同路径目录被替换，不得当作 IPC 字段。
   */
  rootFingerprint?: string
}

export interface BaselineInvalidation {
  valid: boolean
  reason?: NonNullable<TaskChangeBaseline['invalidReason']>
}
