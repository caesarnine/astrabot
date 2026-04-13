import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from 'react'

import { api } from './api'
import { FileTree } from './components/FileTree'
import { MarkdownEditor } from './components/MarkdownEditor'
import { MarkdownPreview } from './components/MarkdownPreview'
import type {
  ActivityBundle,
  ActivityRecord,
  AgentDetailResponse,
  AgentRecord,
  AskResponse,
  BootstrapResponse,
  Defaults,
  DocumentRecord,
  EventEnvelope,
  FileActivityRecord,
  JobRecord,
  RunRecord,
  SearchResult,
  TreeNode,
  UpcomingItem,
  ViewMode,
} from './types'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const APPROVALS = ['untrusted', 'on-failure', 'on-request', 'never']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const TRIGGERS = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' },
  { value: 'file_watch', label: 'File Watch' },
  { value: 'manual', label: 'Manual' },
] as const
const COMPACT_BREAKPOINT = 960
const MOBILE_BREAKPOINT = 680

interface AgentFormState {
  id: string
  name: string
  scopePath: string
  outputDir: string
  prompt: string
  model: string
  reasoningEffort: string
  approvalPolicy: string
  sandboxMode: string
  enabled: boolean
}

interface JobFormState {
  id: string
  name: string
  prompt: string
  triggerType: 'manual' | 'interval' | 'cron' | 'file_watch'
  intervalMinutes: number
  cronExpression: string
  watchPath: string
  watchDebounceSeconds: number
  enabled: boolean
}

function blankAgentForm(defaults: Defaults | null): AgentFormState {
  return {
    id: '',
    name: '',
    scopePath: '',
    outputDir: defaults?.inboxDir ?? 'Inbox',
    prompt: '',
    model: defaults?.model ?? '',
    reasoningEffort: defaults?.reasoningEffort ?? 'high',
    approvalPolicy: defaults?.approvalPolicy ?? 'never',
    sandboxMode: defaults?.sandboxMode ?? 'workspace-write',
    enabled: true,
  }
}

function blankJobForm(): JobFormState {
  return {
    id: '',
    name: '',
    prompt: '',
    triggerType: 'interval',
    intervalMinutes: 60,
    cronExpression: '0 7 * * 1-5',
    watchPath: '',
    watchDebounceSeconds: 5,
    enabled: true,
  }
}

function agentToForm(agent: AgentRecord): AgentFormState {
  return {
    id: agent.id,
    name: agent.name,
    scopePath: agent.scopePath,
    outputDir: agent.outputDir,
    prompt: agent.prompt,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    approvalPolicy: agent.approvalPolicy,
    sandboxMode: agent.sandboxMode,
    enabled: agent.enabled,
  }
}

function jobToForm(job: JobRecord): JobFormState {
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    triggerType: job.triggerType,
    intervalMinutes: job.intervalMinutes ?? 60,
    cronExpression: job.cronExpression ?? '0 7 * * 1-5',
    watchPath: job.watchPath ?? '',
    watchDebounceSeconds: job.watchDebounceSeconds ?? 5,
    enabled: job.enabled,
  }
}

function rememberTab(current: { path: string; title: string }[], document: DocumentRecord) {
  const next = current.filter((tab) => tab.path !== document.path)
  next.unshift({ path: document.path, title: document.title || document.path })
  return next.slice(0, 8)
}

function firstFilePath(node: TreeNode | null): string | null {
  if (!node) {
    return null
  }
  for (const child of node.children ?? []) {
    if (child.kind === 'file') {
      return child.path
    }
    const nested = firstFilePath(child)
    if (nested) {
      return nested
    }
  }
  return null
}

function encodePath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function countWords(text: string) {
  const matches = text.trim().match(/\S+/g)
  return matches ? matches.length : 0
}

function formatDate(value: string | null) {
  if (!value) {
    return '\u2014'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const diff = Date.now() - date.getTime()
  if (diff >= 0 && diff < 60_000) {
    return 'just now'
  }
  if (diff >= 0 && diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`
  }
  if (diff >= 0 && diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusClass(status: string) {
  if (status === 'succeeded' || status === 'replied') {
    return 'success'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'queued' || status === 'running' || status === 'pending') {
    return 'warning'
  }
  return 'muted'
}

function activityIcon(activity: ActivityRecord | UpcomingItem) {
  if ('triggerType' in activity) {
    return 'ring'
  }
  if (activity.kind === 'attention') {
    return 'attention'
  }
  if (activity.kind === 'artifact') {
    return 'artifact'
  }
  return 'notification'
}

function shortRunTitle(run: RunRecord) {
  if (run.touchedPaths.length === 1) {
    return run.touchedPaths[0]
  }
  return run.summaryText || run.id
}

function describeJobSchedule(job: JobRecord) {
  if (job.triggerType === 'file_watch') {
    return job.watchPath ? `Watching ${job.watchPath}` : 'Watching scope'
  }
  if (job.triggerType === 'cron') {
    return job.cronPreview || job.cronExpression || 'Cron schedule'
  }
  if (job.triggerType === 'interval') {
    return job.intervalMinutes ? `${job.intervalMinutes}m` : 'Interval'
  }
  return 'Manual'
}

function nextScheduledRun(agents: AgentRecord[]) {
  const dates = agents
    .map((agent) => agent.nextRunAt)
    .filter(Boolean)
    .map((value) => new Date(value as string))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())
  return dates[0]?.toISOString() ?? null
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function highlightSnippet(value: string) {
  return escapeHtml(value).replaceAll('&lt;mark&gt;', '<mark>').replaceAll('&lt;/mark&gt;', '</mark>')
}

function currentViewportWidth() {
  if (typeof window === 'undefined') {
    return COMPACT_BREAKPOINT + 1
  }
  return window.innerWidth || document.documentElement.clientWidth || COMPACT_BREAKPOINT + 1
}

function buildWatchedFolders(agents: AgentRecord[]) {
  const map: Record<string, string[]> = {}
  for (const agent of agents) {
    const scope = agent.scopePath.trim()
    if (!scope) {
      continue
    }
    const segments = scope.split('/')
    const prefixes: string[] = []
    for (let index = 0; index < segments.length; index += 1) {
      prefixes.push(segments.slice(0, index + 1).join('/'))
    }
    for (const prefix of prefixes) {
      map[prefix] ??= []
      map[prefix].push(agent.name)
    }
  }
  return map
}

function matchAgentByName(agents: AgentRecord[], value: string) {
  const normalized = value.trim().toLowerCase()
  return agents.find((agent) => agent.name.trim().toLowerCase() === normalized) ?? null
}

function routeAgentByPath(agents: AgentRecord[], path: string) {
  const normalized = path.trim().replace(/^\/+/, '')
  const matches = agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const scope = agent.scopePath.trim().replace(/^\/+/, '')
      if (!scope) {
        return { score: 0, agent }
      }
      if (normalized === scope || normalized.startsWith(`${scope}/`)) {
        return { score: scope.length, agent }
      }
      return null
    })
    .filter(Boolean) as Array<{ score: number; agent: AgentRecord }>
  if (!matches.length) {
    return null
  }
  matches.sort((left, right) => right.score - left.score)
  return matches[0].agent
}

function commandTarget(agents: AgentRecord[], input: string, currentPath: string) {
  if (input.startsWith('@')) {
    const match = input.slice(1).match(/^([^\s]+)\s*/)
    if (match?.[1]) {
      const agent = matchAgentByName(agents, match[1])
      if (agent) {
        const cleaned = input.replace(/^@[^\s]+\s*/, '').trim()
        return { agent, cleanedPrompt: cleaned || input.trim() }
      }
    }
  }
  const routed = routeAgentByPath(agents, currentPath)
  return { agent: routed, cleanedPrompt: input.trim() }
}

export default function App() {
  const [appName, setAppName] = useState('Astra')
  const [vaultName, setVaultName] = useState('Vault')
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [activity, setActivity] = useState<ActivityBundle>({ attention: [], today: [], upcoming: [] })
  const [recentFileActivity, setRecentFileActivity] = useState<Record<string, FileActivityRecord>>({})
  const [account, setAccount] = useState<BootstrapResponse['account'] | null>(null)
  const [currentDocument, setCurrentDocument] = useState<DocumentRecord | null>(null)
  const [selectedDocumentPath, setSelectedDocumentPath] = useState('')
  const [openTabs, setOpenTabs] = useState<Array<{ path: string; title: string }>>([])
  const [documentViewMode, setDocumentViewMode] = useState<ViewMode>(() =>
    currentViewportWidth() <= COMPACT_BREAKPOINT ? 'preview' : 'split',
  )
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => currentViewportWidth() > COMPACT_BREAKPOINT)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(() => currentViewportWidth() > MOBILE_BREAKPOINT)
  const [viewportWidth, setViewportWidth] = useState(() => currentViewportWidth())
  const [loadingDocument, setLoadingDocument] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStateLabel, setSaveStateLabel] = useState('Idle')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [newNoteOpen, setNewNoteOpen] = useState(false)
  const [newNoteName, setNewNoteName] = useState('')
  const [newNoteParent, setNewNoteParent] = useState('')
  const [editorValue, setEditorValue] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [agentForm, setAgentForm] = useState<AgentFormState>(blankAgentForm(null))
  const [jobForm, setJobForm] = useState<JobFormState>(blankJobForm())
  const [agentModalOpen, setAgentModalOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [sidebarAskInput, setSidebarAskInput] = useState('')
  const [toastMessage, setToastMessage] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [dismissedActivityIds, setDismissedActivityIds] = useState<string[]>([])

  const searchWrapRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const newNoteNameRef = useRef<HTMLInputElement | null>(null)
  const previousViewportWidthRef = useRef(viewportWidth)
  const commandInputRef = useRef<HTMLInputElement | null>(null)

  const deferredSearchQuery = useDeferredValue(searchQuery.trim())
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null
  const currentWordCount = countWords(editorValue)
  const isCompactLayout = viewportWidth <= COMPACT_BREAKPOINT
  const isMobileLayout = viewportWidth <= MOBILE_BREAKPOINT
  const watchedFolders = buildWatchedFolders(agents)
  const visibleAttention = activity.attention.filter((item) => !dismissedActivityIds.includes(item.id))
  const currentFileActivity = currentDocument ? recentFileActivity[currentDocument.path] : undefined
  const watchingAgents = currentDocument
    ? agents.filter((agent) => {
        const scope = agent.scopePath.trim()
        if (!scope) {
          return false
        }
        return currentDocument.path === scope || currentDocument.path.startsWith(`${scope}/`)
      })
    : []
  const commandRoute = commandTarget(agents, commandInput, currentDocument?.path ?? '')

  useEffect(() => {
    document.title = appName
  }, [appName])

  useEffect(() => {
    function handleResize() {
      setViewportWidth(currentViewportWidth())
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const previousWidth = previousViewportWidthRef.current
    const enteredCompact = previousWidth > COMPACT_BREAKPOINT && viewportWidth <= COMPACT_BREAKPOINT
    const enteredMobile = previousWidth > MOBILE_BREAKPOINT && viewportWidth <= MOBILE_BREAKPOINT
    const leftCompact = previousWidth <= COMPACT_BREAKPOINT && viewportWidth > COMPACT_BREAKPOINT
    const leftMobile = previousWidth <= MOBILE_BREAKPOINT && viewportWidth > MOBILE_BREAKPOINT

    if (enteredCompact) {
      setRightSidebarOpen(false)
      setDocumentViewMode((current) => (current === 'split' ? 'preview' : current))
    }
    if (enteredMobile) {
      setLeftSidebarOpen(false)
    }
    if (leftCompact) {
      setRightSidebarOpen(true)
    }
    if (leftMobile) {
      setLeftSidebarOpen(true)
    }

    previousViewportWidthRef.current = viewportWidth
  }, [viewportWidth])

  useEffect(() => {
    if (!toastMessage) {
      return undefined
    }
    const timeout = window.setTimeout(() => setToastMessage(''), 3200)
    return () => window.clearTimeout(timeout)
  }, [toastMessage])

  useEffect(() => {
    if (!dirty) {
      return undefined
    }
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!deferredSearchQuery) {
      setSearchResults([])
      return undefined
    }
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(deferredSearchQuery)}`)
        startTransition(() => {
          setSearchResults(result.results)
          setSearchOpen(true)
        })
      } catch (error) {
        setToastMessage(error instanceof Error ? error.message : 'Search failed.')
      }
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [deferredSearchQuery])

  useEffect(() => {
    if (!commandPaletteOpen) {
      return
    }
    window.setTimeout(() => commandInputRef.current?.focus(), 0)
  }, [commandPaletteOpen])

  const handleGlobalClick = useEffectEvent((event: MouseEvent) => {
    if (!searchWrapRef.current?.contains(event.target as Node)) {
      setSearchOpen(false)
    }
  })

  useEffect(() => {
    function onClick(event: MouseEvent) {
      handleGlobalClick(event)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const withCommand = event.metaKey || event.ctrlKey
    if (withCommand && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setCommandPaletteOpen(true)
      return
    }
    if (withCommand && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    if (withCommand && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveCurrentDocument({ autosave: false })
      return
    }
    if (withCommand && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      toggleLeftSidebar()
      return
    }
    if (event.key === 'Escape') {
      setNewNoteOpen(false)
      setSearchOpen(false)
      setCommandPaletteOpen(false)
      setAgentModalOpen(false)
    }
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      handleGlobalKeyDown(event)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleSocketMessage = useEffectEvent(async (message: EventEnvelope) => {
    if (message.type === 'vault.changed') {
      await Promise.all([refreshTree(), refreshRecentActivity()])
      if (selectedDocumentPath && !dirty) {
        await loadDocument(selectedDocumentPath, { bypassConfirm: true })
      }
      return
    }

    if (message.type === 'agents.changed' || message.type === 'jobs.changed') {
      await refreshAgents()
      await refreshActivityBundle()
      if (agentModalOpen && selectedAgentId) {
        await loadAgentDetails(selectedAgentId)
      }
      return
    }

    if (
      message.type === 'run.queued' ||
      message.type === 'run.started' ||
      message.type === 'run.completed' ||
      message.type === 'activity.created' ||
      message.type === 'attention.updated'
    ) {
      await Promise.all([refreshAgents(), refreshActivityBundle(), refreshRecentActivity()])
      if (agentModalOpen && selectedAgentId) {
        await loadAgentDetails(selectedAgentId)
      }
      return
    }
  })

  const runBootstrapHydration = useEffectEvent(async () => {
    try {
      const data = await api<BootstrapResponse>('/api/bootstrap')
      startTransition(() => {
        setAppName(data.appName)
        setVaultName(data.vaultName)
        setDefaults(data.defaults)
        setTree(data.tree)
        setAgents(data.agents)
        setActivity(data.activity)
        setRecentFileActivity(data.recentFileActivity)
        setAccount(data.account)
        setAgentForm(blankAgentForm(data.defaults))
        setJobForm(blankJobForm())
      })

      setSelectedAgentId(data.agents[0]?.id ?? null)
      if (data.agents[0]) {
        await loadAgentDetails(data.agents[0].id)
      }

      const initialPath = firstFilePath(data.tree)
      if (initialPath) {
        await loadDocument(initialPath, { bypassConfirm: true })
      }
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : 'Failed to load Astra.')
    }
  })

  useEffect(() => {
    void runBootstrapHydration()
  }, [])

  const runAutosave = useEffectEvent(() => {
    void saveCurrentDocument({ autosave: true })
  })

  useEffect(() => {
    if (!currentDocument?.editable || !dirty || isSaving) {
      return undefined
    }
    const timeout = window.setTimeout(() => runAutosave(), 900)
    return () => window.clearTimeout(timeout)
  }, [currentDocument?.editable, currentDocument?.path, dirty, editorValue, isSaving])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer = 0
    let cancelled = false

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${protocol}://${window.location.host}/api/events`)
      socket.addEventListener('message', (event) => {
        const data = JSON.parse(event.data) as EventEnvelope
        void handleSocketMessage(data)
      })
      socket.addEventListener('close', () => {
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 1500)
        }
      })
    }

    connect()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  function showToast(message: string) {
    setToastMessage(message)
  }

  function closeCompactPanels() {
    if (!isCompactLayout) {
      return
    }
    setRightSidebarOpen(false)
    if (isMobileLayout) {
      setLeftSidebarOpen(false)
    }
  }

  function revealLeftSidebar() {
    if (isMobileLayout) {
      setRightSidebarOpen(false)
    }
    setLeftSidebarOpen(true)
  }

  function revealRightSidebar() {
    if (isMobileLayout) {
      setLeftSidebarOpen(false)
    }
    setRightSidebarOpen(true)
  }

  function toggleLeftSidebar() {
    setLeftSidebarOpen((open) => {
      const next = !open
      if (next && isMobileLayout) {
        setRightSidebarOpen(false)
      }
      return next
    })
  }

  function toggleRightSidebar() {
    setRightSidebarOpen((open) => {
      const next = !open
      if (next && isMobileLayout) {
        setLeftSidebarOpen(false)
      }
      return next
    })
  }

  function openNewNoteComposer() {
    revealLeftSidebar()
    setNewNoteParent(preferredNewNoteParent())
    setNewNoteName('')
    setNewNoteOpen(true)
    window.setTimeout(() => newNoteNameRef.current?.focus(), 0)
  }

  function preferredNewNoteParent() {
    if (!currentDocument?.path) {
      return defaults?.inboxDir ?? ''
    }
    const parts = currentDocument.path.split('/')
    parts.pop()
    return parts.join('/') || defaults?.inboxDir || ''
  }

  function confirmDiscardChanges() {
    if (!dirty) {
      return true
    }
    return window.confirm('Discard unsaved changes?')
  }

  async function refreshAccount() {
    const next = await api<BootstrapResponse['account']>('/api/account')
    setAccount(next)
  }

  async function refreshTree() {
    const next = await api<TreeNode>('/api/tree')
    startTransition(() => setTree(next))
  }

  async function refreshAgents() {
    const result = await api<{ agents: AgentRecord[] }>('/api/agents')
    startTransition(() => {
      setAgents(result.agents)
      if (result.agents.length === 0) {
        setSelectedAgentId(null)
        setAgentForm(blankAgentForm(defaults))
      }
    })
  }

  async function refreshActivityBundle() {
    const next = await api<ActivityBundle>('/api/activity')
    startTransition(() => setActivity(next))
  }

  async function refreshRecentActivity() {
    const next = await api<{ items: Record<string, FileActivityRecord> }>('/api/activity/recent')
    startTransition(() => setRecentFileActivity(next.items))
  }

  async function loadDocument(path: string, options: { bypassConfirm: boolean } = { bypassConfirm: false }) {
    if (!options.bypassConfirm && !confirmDiscardChanges()) {
      return
    }
    setLoadingDocument(true)
    try {
      const document = await api<DocumentRecord>(`/api/documents/${encodePath(path)}`)
      startTransition(() => {
        setCurrentDocument(document)
        setSelectedDocumentPath(document.path)
        setEditorValue(document.content ?? '')
        setDirty(false)
        setSaveStateLabel(document.editable ? 'Ready' : 'Read only')
        setOpenTabs((current) => rememberTab(current, document))
      })
      closeCompactPanels()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load document.')
    } finally {
      setLoadingDocument(false)
    }
  }

  async function loadAgentDetails(agentId: string) {
    try {
      const result = await api<AgentDetailResponse>(`/api/agents/${agentId}`)
      startTransition(() => {
        setSelectedAgentId(agentId)
        setAgentForm(agentToForm(result.agent))
        setJobs(result.jobs)
        setRuns(result.runs)
        setSelectedRunId((current) =>
          result.runs.some((run) => run.id === current) ? current : (result.runs[0]?.id ?? null),
        )
      })
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load agent.')
    }
  }

  async function saveCurrentDocument({ autosave }: { autosave: boolean }) {
    if (!currentDocument?.editable || isSaving) {
      return
    }
    setIsSaving(true)
    setSaveStateLabel('Saving...')
    try {
      const result = await api<DocumentRecord>(`/api/documents/${encodePath(currentDocument.path)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editorValue }),
      })
      startTransition(() => {
        setCurrentDocument(result)
        setEditorValue(result.content ?? '')
        setDirty(false)
        setSaveStateLabel('Saved')
        setOpenTabs((current) => rememberTab(current, result))
      })
      await Promise.all([refreshTree(), refreshRecentActivity()])
      if (!autosave) {
        showToast('Saved.')
      }
    } catch (error) {
      setSaveStateLabel('Save failed')
      showToast(error instanceof Error ? error.message : 'Could not save.')
    } finally {
      setIsSaving(false)
    }
  }

  async function login() {
    try {
      const result = await api<{ authUrl: string }>('/api/account/login', { method: 'POST' })
      if (result.authUrl) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      }
      await refreshAccount()
      showToast('Login started in your browser.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start login.')
    }
  }

  async function logout() {
    try {
      await api<{ status: string }>('/api/account/logout', { method: 'POST' })
      await refreshAccount()
      showToast('Logged out.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not log out.')
    }
  }

  async function submitNewNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newNoteName.trim()) {
      showToast('Name the note first.')
      return
    }
    try {
      const result = await api<DocumentRecord>('/api/documents', {
        method: 'POST',
        body: JSON.stringify({ parent: newNoteParent, name: newNoteName.trim() }),
      })
      setNewNoteOpen(false)
      await refreshTree()
      await loadDocument(result.path, { bypassConfirm: true })
      showToast(`Created ${result.path}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create note.')
    }
  }

  async function handleSearchSelect(path: string) {
    setSearchOpen(false)
    setSearchQuery('')
    await loadDocument(path, { bypassConfirm: false })
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload = {
      name: agentForm.name,
      scope_path: agentForm.scopePath,
      output_dir: agentForm.outputDir,
      prompt: agentForm.prompt,
      model: agentForm.model,
      reasoning_effort: agentForm.reasoningEffort,
      approval_policy: agentForm.approvalPolicy,
      sandbox_mode: agentForm.sandboxMode,
      enabled: agentForm.enabled,
    }
    try {
      const result = agentForm.id
        ? await api<{ agent: AgentRecord }>(`/api/agents/${agentForm.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await api<{ agent: AgentRecord }>('/api/agents', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
      await refreshAgents()
      await loadAgentDetails(result.agent.id)
      showToast('Agent saved.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save agent.')
    }
  }

  async function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedAgentId) {
      showToast('Choose an agent first.')
      return
    }
    const payload = {
      name: jobForm.name,
      prompt: jobForm.prompt,
      trigger_type: jobForm.triggerType,
      interval_minutes: jobForm.intervalMinutes,
      cron_expression: jobForm.cronExpression,
      watch_path: jobForm.watchPath,
      watch_debounce_seconds: jobForm.watchDebounceSeconds,
      enabled: jobForm.enabled,
    }
    try {
      if (jobForm.id) {
        await api<{ job: JobRecord }>(`/api/jobs/${jobForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
      } else {
        await api<{ job: JobRecord }>(`/api/agents/${selectedAgentId}/jobs`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }
      await Promise.all([loadAgentDetails(selectedAgentId), refreshActivityBundle(), refreshAgents()])
      setJobForm(blankJobForm())
      showToast('Job saved.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save job.')
    }
  }

  async function runJob(jobId: string) {
    try {
      await api<{ run: RunRecord }>(`/api/jobs/${jobId}/run`, { method: 'POST' })
      await Promise.all([refreshActivityBundle(), refreshAgents()])
      showToast('Job started.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start job.')
    }
  }

  async function submitAsk(
    event: FormEvent<HTMLFormElement> | null,
    input: string,
    { reset }: { reset: () => void },
  ) {
    event?.preventDefault()
    if (!input.trim()) {
      showToast('Write a prompt first.')
      return
    }
    const target = commandTarget(agents, input, currentDocument?.path ?? '')
    if (!target.agent) {
      showToast('No agent matches this request yet.')
      return
    }
    try {
      const result = await api<AskResponse>('/api/ask', {
        method: 'POST',
        body: JSON.stringify({
          prompt: target.cleanedPrompt,
          agent_id: target.agent.id,
          context_path: currentDocument?.path ?? null,
        }),
      })
      reset()
      setCommandPaletteOpen(false)
      revealRightSidebar()
      if (result.mode === 'steer') {
        showToast(`${target.agent.name} received your follow-up.`)
      } else {
        showToast(`${target.agent.name} started a run.`)
      }
      await Promise.all([refreshActivityBundle(), refreshAgents()])
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not ask the agent.')
    }
  }

  async function replyToAttention(activityId: string) {
    const text = replyDrafts[activityId]?.trim()
    if (!text) {
      showToast('Write a reply first.')
      return
    }
    try {
      await api<{ activity: ActivityRecord }>(`/api/attention/${activityId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      setReplyDrafts((current) => ({ ...current, [activityId]: '' }))
      await refreshActivityBundle()
      showToast('Reply sent.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send reply.')
    }
  }

  async function dismissAttention(activityId: string) {
    try {
      await api<{ activity: ActivityRecord }>(`/api/attention/${activityId}/dismiss`, { method: 'POST' })
      await refreshActivityBundle()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not dismiss request.')
    }
  }

  function resetAgentForm() {
    setAgentForm(blankAgentForm(defaults))
    setJobForm(blankJobForm())
    setSelectedAgentId(agents[0]?.id ?? null)
  }

  function fillJobForm(job: JobRecord) {
    setJobForm(jobToForm(job))
  }

  function currentDocumentStateKind() {
    if (!currentDocument?.editable) {
      return 'muted'
    }
    if (saveStateLabel === 'Unsaved' || saveStateLabel === 'Saving...') {
      return 'warning'
    }
    if (saveStateLabel === 'Save failed') {
      return 'danger'
    }
    return 'success'
  }

  function updateEditor(value: string) {
    setEditorValue(value)
    if (!currentDocument?.editable) {
      return
    }
    setDirty(true)
    setSaveStateLabel('Unsaved')
  }

  function closeTab(path: string) {
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab.path !== path)
      // If closing the active tab, switch to the most recent remaining tab
      if (path === selectedDocumentPath && next.length > 0) {
        void loadDocument(next[0].path, { bypassConfirm: true })
      } else if (next.length === 0) {
        setCurrentDocument(null)
        setSelectedDocumentPath('')
        setEditorValue('')
        setDirty(false)
        setSaveStateLabel('Idle')
      }
      return next
    })
  }

  function openActivityItem(item: ActivityRecord) {
    const path = item.primaryPath || item.paths[0]
    if (path) {
      void loadDocument(path, { bypassConfirm: false })
    }
  }

  const accountLabel = account?.loggedIn ? account.email || 'Logged in' : 'Not logged in'
  const nextRunLabel = nextScheduledRun(agents)
  const activeAgents = agents.filter((agent) => agent.isRunning)
  const enabledAgents = agents.filter((agent) => agent.enabled)

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-start">
          <button
            id="toggle-left-sidebar"
            type="button"
            className="icon-btn"
            title="Toggle file explorer (Cmd+B)"
            onClick={toggleLeftSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 4.5h12M3 9h12M3 13.5h12" />
            </svg>
          </button>
          <div className="brand">
            <span className="brand-mark">A</span>
            <span className="brand-name">{appName}</span>
          </div>
        </div>

        <div ref={searchWrapRef} className="search-wrap">
          <svg className="search-icon" width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="7.5" cy="7.5" r="5.5" />
            <path d="M12 12l4 4" />
          </svg>
          <input
            ref={searchInputRef}
            name="search"
            type="search"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onFocus={() => {
              if (searchQuery.trim()) {
                setSearchOpen(true)
              }
            }}
          />
          <kbd className="search-kbd">&#8984;K</kbd>
          {searchOpen ? (
            <div className="search-dropdown">
              {searchResults.length === 0 ? (
                <div className="empty-state search-empty">No results.</div>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={result.path}
                    type="button"
                    className="search-result"
                    onClick={() => void handleSearchSelect(result.path)}
                  >
                    <div className="card-row">
                      <span className="card-title">{result.title || result.path}</span>
                      <span className="card-meta search-path">{result.path}</span>
                    </div>
                    <div className="card-meta" dangerouslySetInnerHTML={{ __html: highlightSnippet(result.snippet || '') }} />
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="topbar-end">
          <button id="new-note-button" type="button" className="icon-btn" title="New note" onClick={openNewNoteComposer}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <div className="auth-group">
            <span className={`auth-pill ${account?.loggedIn ? '' : 'warning'}`.trim()}>{accountLabel}</span>
            {account?.loggedIn ? (
              <button type="button" className="text-btn" onClick={() => void logout()}>
                Logout
              </button>
            ) : (
              <button type="button" className="text-btn" onClick={() => void login()}>
                Login
              </button>
            )}
          </div>
          <button
            id="toggle-right-sidebar-button"
            type="button"
            className="icon-btn"
            title="Toggle activity panel"
            onClick={toggleRightSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="2" y="2" width="14" height="14" rx="2" />
              <path d="M6 5.5h6M6 9h6M6 12.5h4" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className={`sidebar-left ${leftSidebarOpen ? '' : 'collapsed'}`.trim()}>
          <div className="sidebar-head">
            <h2 className="vault-name">{vaultName}</h2>
            <button type="button" className="icon-btn-sm" title="New note" onClick={openNewNoteComposer}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          </div>

          {newNoteOpen ? (
            <form className="new-note-form" onSubmit={(event) => void submitNewNote(event)}>
              <input
                ref={newNoteNameRef}
                name="new-note-name"
                type="text"
                placeholder="Note name"
                value={newNoteName}
                onChange={(event) => setNewNoteName(event.target.value)}
              />
              <input
                name="new-note-parent"
                type="text"
                placeholder="Folder"
                value={newNoteParent}
                onChange={(event) => setNewNoteParent(event.target.value)}
              />
              <div className="form-row">
                <button type="submit" className="btn-primary btn-sm">
                  Create
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setNewNoteOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <nav className="file-tree">
            <FileTree
              nodes={tree?.children ?? []}
              selectedPath={selectedDocumentPath}
              recentActivity={recentFileActivity}
              watchedFolders={watchedFolders}
              onSelect={(path) => void loadDocument(path)}
              onNewNote={(parentPath) => {
                setNewNoteParent(parentPath)
                setNewNoteName('')
                setNewNoteOpen(true)
                window.setTimeout(() => newNoteNameRef.current?.focus(), 0)
              }}
            />
          </nav>
        </aside>

        <main className="editor-main">
          {/* Progress bar for active agent runs */}
          <div className={`agent-progress-bar ${activeAgents.length > 0 ? 'agent-progress-active' : ''}`.trim()} />

          <div className="editor-tab-bar">
            <div className="tab-list">
              {openTabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`note-tab ${tab.path === selectedDocumentPath ? 'note-tab-active' : ''}`.trim()}
                >
                  {tab.path === selectedDocumentPath && dirty ? (
                    <span className="tab-unsaved-dot" title="Unsaved changes" />
                  ) : null}
                  <button
                    type="button"
                    className="tab-label"
                    onClick={() => void loadDocument(tab.path)}
                  >
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    title="Close tab"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.path) }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <div className="view-controls">
              <div className="view-switcher">
                <button
                  type="button"
                  className={`view-btn ${documentViewMode === 'edit' ? 'view-btn-active' : ''}`.trim()}
                  onClick={() => setDocumentViewMode('edit')}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`view-btn ${documentViewMode === 'preview' ? 'view-btn-active' : ''}`.trim()}
                  onClick={() => setDocumentViewMode('preview')}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className={`view-btn ${documentViewMode === 'split' ? 'view-btn-active' : ''}`.trim()}
                  onClick={() => setDocumentViewMode('split')}
                >
                  Split
                </button>
              </div>
            </div>
          </div>

          <section className={`doc-surface ${loadingDocument ? 'doc-loading' : ''}`.trim()}>
            {/* Attention banner — slides in when agent needs input */}
            {visibleAttention.length > 0 ? (
              <div className="attention-banner">
                <div className="attention-banner-icon">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M8 5v3M8 10.5v.5" />
                    <circle cx="8" cy="8" r="6.5" />
                  </svg>
                </div>
                <div className="attention-banner-body">
                  <strong>{visibleAttention[0].title}</strong>
                  {visibleAttention[0].body ? <span className="attention-banner-text">{visibleAttention[0].body}</span> : null}
                </div>
                <div className="attention-banner-actions">
                  <input
                    type="text"
                    placeholder="Reply..."
                    value={replyDrafts[visibleAttention[0].id] ?? ''}
                    onChange={(event) => setReplyDrafts((current) => ({ ...current, [visibleAttention[0].id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void replyToAttention(visibleAttention[0].id)
                      }
                    }}
                  />
                  <button type="button" className="btn-primary btn-sm" onClick={() => void replyToAttention(visibleAttention[0].id)}>Reply</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void dismissAttention(visibleAttention[0].id)}>Dismiss</button>
                </div>
                {visibleAttention.length > 1 ? (
                  <span className="attention-banner-more">+{visibleAttention.length - 1} more</span>
                ) : null}
              </div>
            ) : null}

            {currentDocument ? (
              <>
                <div className="doc-header">
                  <div className="doc-header-text">
                    <p className="doc-path">{currentDocument.path}</p>
                    <h1 className="doc-title">{currentDocument.title || currentDocument.path}</h1>
                  </div>
                  <div className="doc-actions">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setCommandPaletteOpen(true)}>
                      Ask Agent
                    </button>
                    <span className={`state-pill ${currentDocumentStateKind()}`.trim()}>
                      {saveStateLabel}
                    </span>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      disabled={!currentDocument.editable}
                      onClick={() => void saveCurrentDocument({ autosave: false })}
                    >
                      Save
                    </button>
                  </div>
                </div>

                {currentFileActivity && !dismissedActivityIds.includes(currentFileActivity.activityId) ? (
                  <div className="doc-activity-banner">
                    <div>
                      <strong>{currentFileActivity.agentName || 'Agent'}</strong> touched this {formatDate(currentFileActivity.createdAt)}
                      <div className="doc-activity-copy">{currentFileActivity.title}</div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn-sm"
                      onClick={() => setDismissedActivityIds((current) => [...current, currentFileActivity.activityId])}
                    >
                      ×
                    </button>
                  </div>
                ) : null}

                {watchingAgents.length > 0 ? (
                  <div className="watching-strip">
                    <span className="watching-label">Watching:</span>
                    {watchingAgents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        className={`watching-chip ${agent.isRunning ? 'watching-chip-active' : ''}`.trim()}
                        onClick={() => {
                          setCommandInput(`@${agent.name} `)
                          setCommandPaletteOpen(true)
                        }}
                      >
                        {agent.isRunning ? <span className="watching-chip-dot" /> : null}
                        {agent.name}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className={`doc-content doc-content-${documentViewMode}`.trim()}>
                  {documentViewMode !== 'preview' ? (
                    <MarkdownEditor
                      value={editorValue}
                      onChange={updateEditor}
                      editable={currentDocument.editable}
                      placeholder="Start writing..."
                    />
                  ) : null}
                  {documentViewMode !== 'edit' ? (
                    <div className="preview-pane">
                      <MarkdownPreview value={editorValue} />
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              /* Welcome / empty state */
              <div className="welcome-view">
                <div className="welcome-logo">
                  <span className="brand-mark brand-mark-lg">A</span>
                </div>
                <h1 className="welcome-title">{appName}</h1>
                <p className="welcome-subtitle">Your knowledge workspace with ambient agents.</p>
                <div className="welcome-actions">
                  <button type="button" className="btn-primary" onClick={openNewNoteComposer}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M8 3v10M3 8h10" />
                    </svg>
                    New Note
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setCommandPaletteOpen(true)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M2 8h12M10 4l4 4-4 4" />
                    </svg>
                    Ask an Agent
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => searchInputRef.current?.focus()}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="6.5" cy="6.5" r="4.5" />
                      <path d="M10 10l4 4" />
                    </svg>
                    Search
                  </button>
                </div>
                {agents.length > 0 ? (
                  <div className="welcome-agents">
                    <p className="welcome-agents-label">{enabledAgents.length} agent{enabledAgents.length !== 1 ? 's' : ''} ready</p>
                    <div className="welcome-agent-row">
                      {agents.slice(0, 4).map((agent) => (
                        <span key={agent.id} className="welcome-agent-chip">
                          <span className={`agent-status-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`.trim()} />
                          {agent.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </main>

        <aside className={`sidebar-right ${rightSidebarOpen ? '' : 'right-sidebar-collapsed'}`.trim()}>
          <div className="sidebar-scroll">
            {/* Agent status strip */}
            <div className="agent-strip">
              <div className="agent-strip-head">
                <span className="section-label">Agents</span>
                <button type="button" className="icon-btn-sm" title="Manage agents" onClick={() => setAgentModalOpen(true)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="8" cy="8" r="2.2" />
                    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" />
                  </svg>
                </button>
              </div>
              {agents.length === 0 ? (
                <div className="agent-strip-empty">
                  <p>No agents yet.</p>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setAgentModalOpen(true)}>Create one</button>
                </div>
              ) : (
                <div className="agent-chip-row">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className={`agent-status-chip ${agent.isRunning ? 'agent-status-running' : agent.enabled ? 'agent-status-ready' : 'agent-status-off'}`.trim()}
                      title={`${agent.name} — ${agent.isRunning ? 'running' : agent.enabled ? 'idle' : 'disabled'}`}
                      onClick={() => {
                        setCommandInput(`@${agent.name} `)
                        setCommandPaletteOpen(true)
                      }}
                    >
                      <span className={`agent-status-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`.trim()} />
                      <span className="agent-status-name">{agent.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Attention items */}
            {visibleAttention.length > 0 ? (
              <div className="panel-section">
                <div className="section-head">
                  <span className="section-label">
                    Needs Attention
                    <span className="attention-count">{visibleAttention.length}</span>
                  </span>
                </div>
                <div className="feed-list">
                  {visibleAttention.map((item) => (
                    <div key={item.id} className="feed-card feed-card-attention">
                      <div className="feed-title-row">
                        <span className="feed-dot feed-dot-attention" />
                        <span className="card-title">{item.title}</span>
                        <span className={`status-pill ${statusClass(item.status)}`.trim()}>{item.status}</span>
                      </div>
                      <p className="card-meta">{formatDate(item.createdAt)}</p>
                      {item.body ? <p className="feed-body">{item.body}</p> : null}
                      <div className="attention-actions">
                        <input
                          type="text"
                          placeholder="Reply..."
                          value={replyDrafts[item.id] ?? ''}
                          onChange={(event) => setReplyDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void replyToAttention(item.id)
                            }
                          }}
                        />
                        <button type="button" className="btn-primary btn-sm" onClick={() => void replyToAttention(item.id)}>
                          Reply
                        </button>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => void dismissAttention(item.id)}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Today's activity */}
            <div className="panel-section">
              <div className="section-head">
                <span className="section-label">Today</span>
              </div>
              <div className="feed-list">
                {activity.today.length === 0 ? (
                  <div className="empty-state-card">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                    <p>No activity yet today.</p>
                    <p className="empty-state-hint">Ask an agent something to get started.</p>
                  </div>
                ) : (
                  activity.today.map((item) => (
                    <button key={item.id} type="button" className="feed-card" onClick={() => openActivityItem(item)}>
                      <div className="feed-title-row">
                        <span className={`feed-dot feed-dot-${activityIcon(item)}`.trim()} />
                        <span className="card-title">{item.title}</span>
                        <span className="card-meta">{formatDate(item.createdAt)}</span>
                      </div>
                      {item.primaryPath ? <p className="card-meta feed-path">{item.primaryPath}</p> : null}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Upcoming — collapsible */}
            {activity.upcoming.length > 0 ? (
              <div className="panel-section">
                <details className="upcoming-details">
                  <summary className="section-head section-head-toggle">
                    <span className="section-label">Upcoming</span>
                    <span className="upcoming-count">{activity.upcoming.length}</span>
                  </summary>
                  <div className="feed-list">
                    {activity.upcoming.map((item) => (
                      <div key={item.id} className="feed-card feed-card-upcoming">
                        <div className="feed-title-row">
                          <span className="feed-dot feed-dot-ring" />
                          <span className="card-title">{item.agentName}</span>
                          <span className="card-meta">{item.nextRunAt ? formatDate(item.nextRunAt) : 'Watching'}</span>
                        </div>
                        <p className="card-meta">{item.jobName} &middot; {
                          item.triggerType === 'file_watch'
                            ? `watching ${item.watchPath || 'scope'}`
                            : item.nextRunAt
                              ? `next ${formatDate(item.nextRunAt)}`
                              : 'scheduled'
                        }</p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}

            {/* Sticky ask panel */}
            <div className="panel-section ask-panel">
              <form
                className="quick-run-form"
                onSubmit={(event) =>
                  void submitAsk(event, sidebarAskInput, {
                    reset: () => setSidebarAskInput(''),
                  })
                }
              >
                <input
                  type="text"
                  name="sidebar-ask"
                  placeholder="@Agent ask something..."
                  value={sidebarAskInput}
                  onChange={(event) => setSidebarAskInput(event.target.value)}
                />
                <button type="submit" className="btn-primary btn-sm">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M2 8h12M10 4l4 4-4 4" />
                  </svg>
                </button>
              </form>
              <button type="button" className="ask-shortcut" onClick={() => setCommandPaletteOpen(true)}>
                <span>Command palette</span>
                <kbd>&#8984;&#8679;K</kbd>
              </button>
            </div>
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <div className="status-left">
          <span>{currentDocument?.path || 'No note'}</span>
          <span className="status-sep">&middot;</span>
          <span>{currentWordCount} words</span>
          <span className="status-sep">&middot;</span>
          <span>{saveStateLabel}</span>
        </div>
        <div className="status-right">
          <span className="agent-dot-cluster">
            {activeAgents.map((agent) => (
              <span key={agent.id} className="status-agent-dot dot-running" title={agent.name} />
            ))}
            {enabledAgents.slice(activeAgents.length).map((agent) => (
              <span key={agent.id} className="status-agent-dot dot-ready" title={agent.name} />
            ))}
          </span>
          <span>{activeAgents.length} active</span>
          <span className="status-sep">&middot;</span>
          <span>{Math.max(enabledAgents.length - activeAgents.length, 0)} idle</span>
          <span className="status-sep">&middot;</span>
          <span>{nextRunLabel ? `Next ${formatDate(nextRunLabel)}` : 'No schedule'}</span>
          <span className="status-sep">&middot;</span>
          <button type="button" className="status-attention-btn" onClick={revealRightSidebar}>
            ⚠ {visibleAttention.length}
          </button>
        </div>
      </footer>

      {commandPaletteOpen ? (
        <div className="overlay-backdrop" onClick={() => setCommandPaletteOpen(false)}>
          <div className="command-palette" onClick={(event) => event.stopPropagation()}>
            <form
              onSubmit={(event) =>
                void submitAsk(event, commandInput, {
                  reset: () => setCommandInput(''),
                })
              }
            >
              <input
                ref={commandInputRef}
                type="text"
                placeholder="@Agent ask something..."
                value={commandInput}
                onChange={(event) => setCommandInput(event.target.value)}
              />
            </form>
            <div className="command-hint">
              {commandRoute.agent ? (
                <span>
                  ↳ routes to <strong>{commandRoute.agent.name}</strong>
                  {commandRoute.agent.scopePath ? ` in ${commandRoute.agent.scopePath}` : ''}
                </span>
              ) : (
                <span>Type @Agent or open a note inside an agent scope.</span>
              )}
            </div>
            <div className="command-recent">
              {agents.slice(0, 5).map((agent) => (
                <button key={agent.id} type="button" onClick={() => setCommandInput(`@${agent.name} `)}>
                  <strong>{agent.name}</strong>
                  <span>{agent.scopePath || 'whole vault'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {agentModalOpen ? (
        <div className="overlay-backdrop" onClick={() => setAgentModalOpen(false)}>
          <div className="agent-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Agents</h2>
              <button type="button" className="icon-btn-sm" onClick={() => setAgentModalOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-grid">
              <div className="modal-list">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`modal-agent-row ${agent.id === selectedAgentId ? 'modal-agent-row-active' : ''}`.trim()}
                    onClick={() => void loadAgentDetails(agent.id)}
                  >
                    <span className={`agent-chip-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`.trim()} />
                    <div>
                      <strong>{agent.name}</strong>
                      <p>{agent.scopePath || 'whole vault'}</p>
                    </div>
                  </button>
                ))}
                <button type="button" className="btn-ghost btn-sm" onClick={resetAgentForm}>
                  New agent
                </button>
              </div>
              <div className="modal-main">
                <form className="config-form" onSubmit={(event) => void saveAgent(event)}>
                  <label>
                    <span>Name</span>
                    <input value={agentForm.name} onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))} />
                  </label>
                  <label>
                    <span>Scope</span>
                    <input value={agentForm.scopePath} onChange={(event) => setAgentForm((current) => ({ ...current, scopePath: event.target.value }))} />
                  </label>
                  <label>
                    <span>Output dir</span>
                    <input value={agentForm.outputDir} onChange={(event) => setAgentForm((current) => ({ ...current, outputDir: event.target.value }))} />
                  </label>
                  <label>
                    <span>Prompt</span>
                    <textarea rows={4} value={agentForm.prompt} onChange={(event) => setAgentForm((current) => ({ ...current, prompt: event.target.value }))} />
                  </label>
                  <div className="form-grid-2">
                    <label>
                      <span>Model</span>
                      <input value={agentForm.model} onChange={(event) => setAgentForm((current) => ({ ...current, model: event.target.value }))} />
                    </label>
                    <label>
                      <span>Effort</span>
                      <select value={agentForm.reasoningEffort} onChange={(event) => setAgentForm((current) => ({ ...current, reasoningEffort: event.target.value }))}>
                        {EFFORTS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Approval</span>
                      <select value={agentForm.approvalPolicy} onChange={(event) => setAgentForm((current) => ({ ...current, approvalPolicy: event.target.value }))}>
                        {APPROVALS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Sandbox</span>
                      <select value={agentForm.sandboxMode} onChange={(event) => setAgentForm((current) => ({ ...current, sandboxMode: event.target.value }))}>
                        {SANDBOXES.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={agentForm.enabled}
                      onChange={(event) => setAgentForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enabled</span>
                  </label>
                  <div className="form-row">
                    <button type="submit" className="btn-primary btn-sm">
                      Save agent
                    </button>
                  </div>
                </form>

                <div className="modal-section">
                  <div className="section-head">
                    <span className="section-label">Jobs</span>
                  </div>
                  <div className="job-list modal-job-list">
                    {jobs.map((job) => (
                      <div key={job.id} className="job-card">
                        <div className="card-row">
                          <span className="card-title">{job.name}</span>
                          <span className={`status-pill ${job.enabled ? 'success' : 'muted'}`.trim()}>{job.triggerType}</span>
                        </div>
                        <p className="card-meta">{describeJobSchedule(job)}</p>
                        <div className="form-row job-card-actions">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => fillJobForm(job)}>
                            Edit
                          </button>
                          <button type="button" className="btn-primary btn-sm" onClick={() => void runJob(job.id)}>
                            Run
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <form className="config-form" onSubmit={(event) => void saveJob(event)}>
                    <label>
                      <span>Name</span>
                      <input value={jobForm.name} onChange={(event) => setJobForm((current) => ({ ...current, name: event.target.value }))} />
                    </label>
                    <label>
                      <span>Prompt</span>
                      <textarea rows={3} value={jobForm.prompt} onChange={(event) => setJobForm((current) => ({ ...current, prompt: event.target.value }))} />
                    </label>
                    <div className="form-grid-2">
                      <label>
                        <span>Trigger</span>
                        <select value={jobForm.triggerType} onChange={(event) => setJobForm((current) => ({ ...current, triggerType: event.target.value as JobFormState['triggerType'] }))}>
                          {TRIGGERS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Interval (min)</span>
                        <input
                          type="number"
                          min="1"
                          disabled={jobForm.triggerType !== 'interval'}
                          value={jobForm.intervalMinutes}
                          onChange={(event) => setJobForm((current) => ({ ...current, intervalMinutes: Number(event.target.value || 0) }))}
                        />
                      </label>
                      <label>
                        <span>Cron</span>
                        <input
                          disabled={jobForm.triggerType !== 'cron'}
                          value={jobForm.cronExpression}
                          onChange={(event) => setJobForm((current) => ({ ...current, cronExpression: event.target.value }))}
                        />
                      </label>
                      <label>
                        <span>Watch path</span>
                        <input
                          disabled={jobForm.triggerType !== 'file_watch'}
                          value={jobForm.watchPath}
                          onChange={(event) => setJobForm((current) => ({ ...current, watchPath: event.target.value }))}
                        />
                      </label>
                      <label>
                        <span>Debounce (sec)</span>
                        <input
                          type="number"
                          min="1"
                          disabled={jobForm.triggerType !== 'file_watch'}
                          value={jobForm.watchDebounceSeconds}
                          onChange={(event) => setJobForm((current) => ({ ...current, watchDebounceSeconds: Number(event.target.value || 1) }))}
                        />
                      </label>
                    </div>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={jobForm.enabled} onChange={(event) => setJobForm((current) => ({ ...current, enabled: event.target.checked }))} />
                      <span>Enabled</span>
                    </label>
                    <div className="form-row">
                      <button type="submit" className="btn-primary btn-sm">
                        Save job
                      </button>
                    </div>
                  </form>
                </div>

                <div className="modal-section">
                  <div className="section-head">
                    <span className="section-label">Runs</span>
                  </div>
                  <div className="run-list modal-run-list">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        className={`run-card ${run.id === selectedRunId ? 'run-card-active' : ''}`.trim()}
                        onClick={() => setSelectedRunId(run.id)}
                      >
                        <div className="card-row">
                          <span className="card-title">{shortRunTitle(run)}</span>
                          <span className={`status-pill ${statusClass(run.status)}`.trim()}>{run.status}</span>
                        </div>
                        <p className="card-meta">{formatDate(run.startedAt)}</p>
                      </button>
                    ))}
                  </div>
                  {selectedRun ? (
                    <div className="run-detail">
                      <div className="card-row detail-row">
                        <span className="run-id-label">{selectedRun.id}</span>
                        <span className={`status-pill ${statusClass(selectedRun.status)}`.trim()}>{selectedRun.status}</span>
                      </div>
                      <div className="card-meta">{selectedRun.summaryText || selectedRun.errorText || 'No summary.'}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`toast ${toastMessage ? '' : 'hidden'}`.trim()}>{toastMessage}</div>
    </div>
  )
}
