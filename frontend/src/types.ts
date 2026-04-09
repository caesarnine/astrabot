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
  isRunning: boolean
}

export interface JobRecord {
  id: string
  agentId: string
  name: string
  prompt: string
  scheduleType: 'manual' | 'interval'
  intervalMinutes: number | null
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
  trigger: string
  status: string
  startedAt: string
  finishedAt: string | null
  finalText: string | null
  errorText: string | null
  touchedPaths: string[]
  outputNotePath: string | null
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
  runs: RunRecord[]
  defaults: Defaults
  appName: string
  vaultName: string
}

export interface AgentDetailResponse {
  agent: AgentRecord
  jobs: JobRecord[]
  runs: RunRecord[]
}

export interface EventEnvelope {
  type: string
  timestamp: string
  payload: Record<string, unknown>
}
