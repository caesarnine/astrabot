export type ViewMode = 'edit' | 'preview' | 'split'

export interface AccountState {
  loggedIn: boolean
  email: string | null
  authType: string | null
}

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  children?: TreeNode[]
}

export interface SearchResult {
  path: string
  title: string | null
  snippet: string
}

export interface DocumentRecord {
  path: string
  kind: 'dir' | 'file'
  title: string
  editable: boolean
  content: string | null
}

export interface AgentRecord {
  id: string
  name: string
  prompt: string
  scopePath: string
  outputDir: string
  threadId: string | null
  model: string
  reasoningEffort: string
  approvalPolicy: string
  sandboxMode: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastRunStatus: string | null
  nextRunAt: string | null
  activeTurnId: string | null
  isRunning: boolean
}

export interface JobRecord {
  id: string
  agentId: string
  name: string
  prompt: string
  triggerType: 'manual' | 'interval' | 'cron' | 'file_watch'
  intervalMinutes: number | null
  cronExpression: string | null
  cronPreview: string | null
  watchPath: string | null
  watchDebounceSeconds: number | null
  nextRunAt: string | null
  lastRunAt: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RunRecord {
  id: string
  agentId: string
  jobId: string | null
  threadId: string | null
  turnId: string | null
  trigger: string
  status: string
  startedAt: string
  finishedAt: string | null
  summaryText: string | null
  errorText: string | null
  touchedPaths: string[]
}

export interface ActivityRecord {
  id: string
  agentId: string
  jobId: string | null
  runId: string | null
  threadId: string | null
  turnId: string | null
  kind: 'artifact' | 'notification' | 'attention'
  status: string
  title: string
  body: string | null
  primaryPath: string | null
  paths: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface UpcomingItem {
  id: string
  agentId: string
  agentName: string
  jobName: string
  triggerType: 'interval' | 'cron' | 'file_watch'
  nextRunAt: string | null
  watchPath: string | null
}

export interface FileActivityRecord {
  activityId: string
  agentId: string
  agentName: string | null
  kind: 'artifact' | 'attention'
  status: string
  title: string
  createdAt: string
}

export interface ActivityBundle {
  attention: ActivityRecord[]
  today: ActivityRecord[]
  upcoming: UpcomingItem[]
}

export interface Defaults {
  model: string
  reasoningEffort: string
  approvalPolicy: string
  sandboxMode: string
  inboxDir: string
}

export interface BootstrapResponse {
  account: AccountState
  tree: TreeNode
  agents: AgentRecord[]
  activity: ActivityBundle
  recentFileActivity: Record<string, FileActivityRecord>
  defaults: Defaults
  appName: string
  vaultName: string
}

export interface AgentDetailResponse {
  agent: AgentRecord
  jobs: JobRecord[]
  runs: RunRecord[]
}

export interface AskResponse {
  mode: 'run' | 'steer'
  agentId: string
  run?: RunRecord
}

export interface EventEnvelope {
  type: string
  timestamp: string
  payload: Record<string, unknown>
}
