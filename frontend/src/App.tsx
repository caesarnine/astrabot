import {
  startTransition,
  useCallback,
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
import { ToastStack } from './components/ToastStack'
import { StatusBar } from './components/StatusBar'
import { BottomDrawer } from './components/BottomDrawer'
import { Omnibar } from './components/Omnibar'
import { AgentSlideOut } from './components/AgentSlideOut'
import { DocHeader } from './components/DocHeader'
import { WelcomeView } from './components/WelcomeView'
import type {
  ActivityBundle,
  ActivityRecord,
  AgentDetailResponse,
  AgentFormState,
  AgentRecord,
  AskResponse,
  BootstrapResponse,
  Defaults,
  DocumentRecord,
  DrawerTab,
  EventEnvelope,
  FileActivityRecord,
  JobFormState,
  JobRecord,
  RunRecord,
  SearchResult,
  ToastItem,
  TreeNode,
  ViewMode,
  WatchedAgentInfo,
} from './types'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const COMPACT_BREAKPOINT = 960
const MOBILE_BREAKPOINT = 680

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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
  if (!node) return null
  for (const child of node.children ?? []) {
    if (child.kind === 'file') return child.path
    const nested = firstFilePath(child)
    if (nested) return nested
  }
  return null
}

function findNodeByPath(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    const nested = findNodeByPath(child, path)
    if (nested) return nested
  }
  return null
}

function encodePath(path: string) {
  return path.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/')
}

function countWords(text: string) {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

function currentViewportWidth() {
  if (typeof window === 'undefined') return COMPACT_BREAKPOINT + 1
  return window.innerWidth || document.documentElement.clientWidth || COMPACT_BREAKPOINT + 1
}

function buildWatchedFolders(agents: AgentRecord[]) {
  const map: Record<string, WatchedAgentInfo[]> = {}
  for (const agent of agents) {
    const scope = agent.scopePath.trim()
    if (!scope) continue
    const segments = scope.split('/')
    for (let i = 0; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i + 1).join('/')
      map[prefix] ??= []
      map[prefix].push({ name: agent.name, running: agent.isRunning })
    }
  }
  return map
}

function matchAgentByName(agents: AgentRecord[], value: string) {
  const normalized = value.trim().toLowerCase()
  return agents.find((a) => a.name.trim().toLowerCase() === normalized) ?? null
}

function routeAgentByPath(agents: AgentRecord[], path: string) {
  const normalized = path.trim().replace(/^\/+/, '')
  const matches = agents
    .filter((a) => a.enabled)
    .map((a) => {
      const scope = a.scopePath.trim().replace(/^\/+/, '')
      if (!scope) return { score: 0, agent: a }
      if (normalized === scope || normalized.startsWith(`${scope}/`)) return { score: scope.length, agent: a }
      return null
    })
    .filter(Boolean) as Array<{ score: number; agent: AgentRecord }>
  if (!matches.length) return null
  matches.sort((a, b) => b.score - a.score)
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

let toastCounter = 0

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  /* ---- Core state ---- */
  const [appName, setAppName] = useState('Astra')
  const [vaultName, setVaultName] = useState('Vault')
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [activity, setActivity] = useState<ActivityBundle>({ attention: [], today: [], upcoming: [] })
  const [recentFileActivity, setRecentFileActivity] = useState<Record<string, FileActivityRecord>>({})
  const [account, setAccount] = useState<BootstrapResponse['account'] | null>(null)

  /* ---- Document state ---- */
  const [currentDocument, setCurrentDocument] = useState<DocumentRecord | null>(null)
  const [selectedDocumentPath, setSelectedDocumentPath] = useState('')
  const [openTabs, setOpenTabs] = useState<Array<{ path: string; title: string }>>([])
  const [documentViewMode, setDocumentViewMode] = useState<ViewMode>(() =>
    currentViewportWidth() <= COMPACT_BREAKPOINT ? 'preview' : 'split',
  )
  const [loadingDocument, setLoadingDocument] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStateLabel, setSaveStateLabel] = useState('Idle')
  const [editorValue, setEditorValue] = useState('')

  /* ---- UI state ---- */
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(() => currentViewportWidth() > MOBILE_BREAKPOINT)
  const [viewportWidth, setViewportWidth] = useState(() => currentViewportWidth())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('activity')
  const [omnibarOpen, setOmnibarOpen] = useState(false)
  const [omnibarInitialInput, setOmnibarInitialInput] = useState('')
  const [agentSlideOutOpen, setAgentSlideOutOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  /* ---- Note creation ---- */
  const [newNoteOpen, setNewNoteOpen] = useState(false)
  const [newNoteName, setNewNoteName] = useState('')
  const [newNoteParent, setNewNoteParent] = useState('')

  /* ---- Agent management ---- */
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [agentForm, setAgentForm] = useState<AgentFormState>(blankAgentForm(null))
  const [jobForm, setJobForm] = useState<JobFormState>(blankJobForm())

  /* ---- Interaction state ---- */
  const [askInput, setAskInput] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [dismissedActivityIds, setDismissedActivityIds] = useState<string[]>([])

  /* ---- Refs ---- */
  const newNoteNameRef = useRef<HTMLInputElement | null>(null)
  const previousViewportWidthRef = useRef(viewportWidth)

  /* ---- Derived state ---- */
  const currentWordCount = countWords(editorValue)
  const isMobileLayout = viewportWidth <= MOBILE_BREAKPOINT
  const watchedFolders = buildWatchedFolders(agents)
  const visibleAttention = activity.attention.filter((item) => !dismissedActivityIds.includes(item.id))
  const watchingAgents = currentDocument
    ? agents.filter((a) => {
        const scope = a.scopePath.trim()
        if (!scope) return false
        return currentDocument.path === scope || currentDocument.path.startsWith(`${scope}/`)
      })
    : []
  const activeAgents = agents.filter((a) => a.isRunning)
  const enabledAgents = agents.filter((a) => a.enabled)
  const askCommandRoute = commandTarget(agents, askInput, currentDocument?.path ?? '')

  /* ---- Computed save state ---- */
  const saveStateDot: 'clean' | 'dirty' | 'saving' | 'error' =
    saveStateLabel === 'Saving...' ? 'saving'
    : saveStateLabel === 'Save failed' ? 'error'
    : dirty ? 'dirty'
    : 'clean'

  /* ================================================================ */
  /*  Effects                                                          */
  /* ================================================================ */

  useEffect(() => { document.title = appName }, [appName])

  useEffect(() => {
    function handleResize() { setViewportWidth(currentViewportWidth()) }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const prev = previousViewportWidthRef.current
    if (prev > MOBILE_BREAKPOINT && viewportWidth <= MOBILE_BREAKPOINT) setLeftSidebarOpen(false)
    if (prev <= MOBILE_BREAKPOINT && viewportWidth > MOBILE_BREAKPOINT) setLeftSidebarOpen(true)
    if (prev > COMPACT_BREAKPOINT && viewportWidth <= COMPACT_BREAKPOINT) {
      setDocumentViewMode((c) => c === 'split' ? 'preview' : c)
    }
    previousViewportWidthRef.current = viewportWidth
  }, [viewportWidth])

  // Toast auto-dismiss
  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((t) => {
      if (t.duration <= 0) return 0
      return window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id))
      }, t.duration)
    })
    return () => timers.forEach((id) => { if (id) window.clearTimeout(id) })
  }, [toasts])

  useEffect(() => {
    if (!dirty) return
    function handleBeforeUnload(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const withCmd = event.metaKey || event.ctrlKey

    if (withCmd && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setOmnibarInitialInput('')
      setOmnibarOpen(true)
      return
    }
    if (withCmd && event.key.toLowerCase() === 'j') {
      event.preventDefault()
      setDrawerOpen((o) => !o)
      return
    }
    if (withCmd && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveCurrentDocument({ autosave: false })
      return
    }
    if (withCmd && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      toggleLeftSidebar()
      return
    }
    // Cmd+1-8 for tab switching
    if (withCmd && event.key >= '1' && event.key <= '8') {
      event.preventDefault()
      const idx = Number(event.key) - 1
      if (idx < openTabs.length) {
        void loadDocument(openTabs[idx].path)
      }
      return
    }
    if (event.key === 'Escape') {
      if (omnibarOpen) { setOmnibarOpen(false); return }
      if (agentSlideOutOpen) { setAgentSlideOutOpen(false); return }
      if (drawerOpen) { setDrawerOpen(false); return }
      setNewNoteOpen(false)
    }
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { handleGlobalKeyDown(e) }
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
      if (agentSlideOutOpen && selectedAgentId) {
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
      if (agentSlideOutOpen && selectedAgentId) {
        await loadAgentDetails(selectedAgentId)
      }

      // Fire toasts for key events
      if (message.type === 'run.completed') {
        const payload = message.payload as { status?: string; summaryText?: string; touchedPaths?: string[]; agentId?: string }
        const agentName = agents.find((a) => a.id === payload.agentId)?.name || 'Agent'
        const touchedCount = payload.touchedPaths?.length ?? 0
        if (payload.status === 'succeeded') {
          addToast('success', `${agentName} finished${touchedCount > 0 ? ` \u2014 updated ${touchedCount} file${touchedCount !== 1 ? 's' : ''}` : ''}`, {
            label: 'View',
            callback: () => {
              if (payload.touchedPaths?.[0]) {
                void loadDocument(payload.touchedPaths[0], { bypassConfirm: false })
              }
            },
          })
        } else if (payload.status === 'failed') {
          addToast('error', `${agentName} run failed`, {
            label: 'Details',
            callback: () => { setDrawerOpen(true); setDrawerTab('activity') },
          })
        }
      }
      if (message.type === 'activity.created') {
        const payload = message.payload as { kind?: string; title?: string; id?: string }
        if (payload.kind === 'attention') {
          addToast('attention', payload.title || 'Agent needs your input', {
            label: 'Reply',
            callback: () => { setDrawerOpen(true); setDrawerTab('activity') },
          })
        }
      }
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
      if (data.agents[0]) await loadAgentDetails(data.agents[0].id)
      const initialPath = firstFilePath(data.tree)
      if (initialPath) await loadDocument(initialPath, { bypassConfirm: true })
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Failed to load Astra.')
    }
  })

  useEffect(() => { void runBootstrapHydration() }, [])

  const runAutosave = useEffectEvent(() => {
    void saveCurrentDocument({ autosave: true })
  })

  useEffect(() => {
    if (!currentDocument?.editable || !dirty || isSaving) return
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
        void handleSocketMessage(JSON.parse(event.data) as EventEnvelope)
      })
      socket.addEventListener('close', () => {
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 1500)
      })
    }
    connect()
    return () => { cancelled = true; window.clearTimeout(reconnectTimer); socket?.close() }
  }, [])

  /* ================================================================ */
  /*  Handlers                                                         */
  /* ================================================================ */

  function addToast(kind: ToastItem['kind'], message: string, action?: ToastItem['action']) {
    const id = `toast-${++toastCounter}`
    setToasts((prev) => [...prev.slice(-3), { id, kind, message, action, duration: kind === 'error' ? 8000 : 5000 }])
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  function toggleLeftSidebar() {
    setLeftSidebarOpen((open) => {
      const next = !open
      if (next && isMobileLayout) setDrawerOpen(false)
      return next
    })
  }

  function openDrawer(tab: DrawerTab) {
    setDrawerTab(tab)
    setDrawerOpen(true)
  }

  function openNewNoteComposer() {
    setLeftSidebarOpen(true)
    if (isMobileLayout) setDrawerOpen(false)
    setNewNoteParent(preferredNewNoteParent())
    setNewNoteName('')
    setNewNoteOpen(true)
    window.setTimeout(() => newNoteNameRef.current?.focus(), 0)
  }

  function preferredNewNoteParent() {
    if (!currentDocument?.path) return defaults?.inboxDir ?? ''
    const parts = currentDocument.path.split('/')
    parts.pop()
    return parts.join('/') || defaults?.inboxDir || ''
  }

  function confirmDiscardChanges() {
    if (!dirty) return true
    return window.confirm('Discard unsaved changes?')
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
    if (!options.bypassConfirm && !confirmDiscardChanges()) return
    setLoadingDocument(true)
    try {
      const doc = await api<DocumentRecord>(`/api/documents/${encodePath(path)}`)
      startTransition(() => {
        setCurrentDocument(doc)
        setSelectedDocumentPath(doc.path)
        setEditorValue(doc.content ?? '')
        setDirty(false)
        setSaveStateLabel(doc.editable ? 'Ready' : 'Read only')
        setOpenTabs((current) => rememberTab(current, doc))
      })
      if (isMobileLayout) setLeftSidebarOpen(false)
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not load document.')
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
        setSelectedRunId((c) => result.runs.some((r) => r.id === c) ? c : (result.runs[0]?.id ?? null))
      })
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not load agent.')
    }
  }

  async function saveCurrentDocument({ autosave }: { autosave: boolean }) {
    if (!currentDocument?.editable || isSaving) return
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
      if (!autosave) addToast('info', 'Saved.')
    } catch (error) {
      setSaveStateLabel('Save failed')
      addToast('error', error instanceof Error ? error.message : 'Could not save.')
    } finally {
      setIsSaving(false)
    }
  }

  async function login() {
    try {
      const result = await api<{ authUrl: string }>('/api/account/login', { method: 'POST' })
      if (result.authUrl) window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      const next = await api<BootstrapResponse['account']>('/api/account')
      setAccount(next)
      addToast('info', 'Login started in your browser.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not start login.')
    }
  }

  async function logout() {
    try {
      await api<{ status: string }>('/api/account/logout', { method: 'POST' })
      const next = await api<BootstrapResponse['account']>('/api/account')
      setAccount(next)
      addToast('info', 'Logged out.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not log out.')
    }
  }

  async function submitNewNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newNoteName.trim()) { addToast('info', 'Name the note first.'); return }
    try {
      const result = await api<DocumentRecord>('/api/documents', {
        method: 'POST',
        body: JSON.stringify({ parent: newNoteParent, name: newNoteName.trim() }),
      })
      setNewNoteOpen(false)
      await refreshTree()
      await loadDocument(result.path, { bypassConfirm: true })
      addToast('success', `Created ${result.path}`)
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not create note.')
    }
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload = {
      name: agentForm.name, scope_path: agentForm.scopePath, output_dir: agentForm.outputDir,
      prompt: agentForm.prompt, model: agentForm.model, reasoning_effort: agentForm.reasoningEffort,
      approval_policy: agentForm.approvalPolicy, sandbox_mode: agentForm.sandboxMode, enabled: agentForm.enabled,
    }
    try {
      const result = agentForm.id
        ? await api<{ agent: AgentRecord }>(`/api/agents/${agentForm.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api<{ agent: AgentRecord }>('/api/agents', { method: 'POST', body: JSON.stringify(payload) })
      await refreshAgents()
      await loadAgentDetails(result.agent.id)
      addToast('success', 'Agent saved.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not save agent.')
    }
  }

  async function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedAgentId) { addToast('info', 'Choose an agent first.'); return }
    const payload = {
      name: jobForm.name, prompt: jobForm.prompt, trigger_type: jobForm.triggerType,
      interval_minutes: jobForm.intervalMinutes, cron_expression: jobForm.cronExpression,
      watch_path: jobForm.watchPath, watch_debounce_seconds: jobForm.watchDebounceSeconds, enabled: jobForm.enabled,
    }
    try {
      if (jobForm.id) {
        await api<{ job: JobRecord }>(`/api/jobs/${jobForm.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      } else {
        await api<{ job: JobRecord }>(`/api/agents/${selectedAgentId}/jobs`, { method: 'POST', body: JSON.stringify(payload) })
      }
      await Promise.all([loadAgentDetails(selectedAgentId), refreshActivityBundle(), refreshAgents()])
      setJobForm(blankJobForm())
      addToast('success', 'Job saved.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not save job.')
    }
  }

  async function runJob(jobId: string) {
    try {
      await api<{ run: RunRecord }>(`/api/jobs/${jobId}/run`, { method: 'POST' })
      await Promise.all([refreshActivityBundle(), refreshAgents()])
      addToast('info', 'Job started.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not start job.')
    }
  }

  async function submitAsk(input: string) {
    if (!input.trim()) { addToast('info', 'Write a prompt first.'); return }
    const target = commandTarget(agents, input, currentDocument?.path ?? '')
    if (!target.agent) { addToast('info', 'No agent matches this request yet.'); return }
    try {
      const result = await api<AskResponse>('/api/ask', {
        method: 'POST',
        body: JSON.stringify({ prompt: target.cleanedPrompt, agent_id: target.agent.id, context_path: currentDocument?.path ?? null }),
      })
      setAskInput('')
      if (result.mode === 'steer') {
        addToast('info', `${target.agent.name} received your follow-up.`)
      } else {
        addToast('info', `${target.agent.name} started a run.`)
      }
      await Promise.all([refreshActivityBundle(), refreshAgents()])
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not ask the agent.')
    }
  }

  async function replyToAttention(activityId: string) {
    const text = replyDrafts[activityId]?.trim()
    if (!text) { addToast('info', 'Write a reply first.'); return }
    try {
      await api<{ activity: ActivityRecord }>(`/api/attention/${activityId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      setReplyDrafts((c) => ({ ...c, [activityId]: '' }))
      await refreshActivityBundle()
      addToast('success', 'Reply sent.')
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not send reply.')
    }
  }

  async function dismissAttention(activityId: string) {
    setDismissedActivityIds((prev) => [...prev, activityId])
    try {
      await api<{ activity: ActivityRecord }>(`/api/attention/${activityId}/dismiss`, { method: 'POST' })
      await refreshActivityBundle()
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : 'Could not dismiss.')
    }
  }

  function updateEditor(value: string) {
    setEditorValue(value)
    if (!currentDocument?.editable) return
    setDirty(true)
    setSaveStateLabel('Unsaved')
  }

  function closeTab(path: string) {
    setOpenTabs((current) => {
      const next = current.filter((t) => t.path !== path)
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
    if (path) void loadDocument(path, { bypassConfirm: false })
  }

  const handleOmnibarSearch = useCallback(async (query: string): Promise<SearchResult[]> => {
    try {
      const result = await api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`)
      return result.results
    } catch {
      return []
    }
  }, [])

  const accountLabel = account?.loggedIn ? account.email || 'Logged in' : 'Not logged in'

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div className="workspace">
      {/* ---- Top bar ---- */}
      <header className="topbar">
        <div className="topbar-start">
          <button type="button" className="icon-btn" title="Toggle file explorer (Cmd+B)" onClick={toggleLeftSidebar}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 4.5h12M3 9h12M3 13.5h12" />
            </svg>
          </button>
          <div className="brand">
            <span className="brand-mark">A</span>
            <span className="brand-name">{appName}</span>
          </div>
        </div>

        {/* Search bar — click opens omnibar */}
        <div className="search-wrap" onClick={() => { setOmnibarInitialInput(''); setOmnibarOpen(true) }}>
          <svg className="search-icon" width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="7.5" cy="7.5" r="5.5" />
            <path d="M12 12l4 4" />
          </svg>
          <div className="search-placeholder">Search notes, @agent to ask...</div>
          <kbd className="search-kbd">&#8984;K</kbd>
        </div>

        <div className="topbar-end">
          <button type="button" className="icon-btn" title="New note" onClick={openNewNoteComposer}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <div className="auth-group">
            <span className={`auth-pill ${account?.loggedIn ? '' : 'warning'}`}>{accountLabel}</span>
            {account?.loggedIn ? (
              <button type="button" className="text-btn" onClick={() => void logout()}>Logout</button>
            ) : (
              <button type="button" className="text-btn" onClick={() => void login()}>Login</button>
            )}
          </div>
        </div>
      </header>

      {/* ---- Body ---- */}
      <div className="app-body">
        {/* Left sidebar */}
        <aside className={`sidebar-left ${leftSidebarOpen ? '' : 'collapsed'}`}>
          <div className="sidebar-head">
            <h2 className="vault-name">{vaultName}</h2>
            <button type="button" className="icon-btn-sm" title="New note" onClick={openNewNoteComposer}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          </div>

          {newNoteOpen ? (
            <form className="new-note-form" onSubmit={(e) => void submitNewNote(e)}>
              <input ref={newNoteNameRef} type="text" placeholder="Note name" value={newNoteName} onChange={(e) => setNewNoteName(e.target.value)} />
              <input type="text" placeholder="Folder" value={newNoteParent} onChange={(e) => setNewNoteParent(e.target.value)} />
              <div className="form-row">
                <button type="submit" className="btn-primary btn-sm">Create</button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setNewNoteOpen(false)}>Cancel</button>
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

        {/* Main editor area */}
        <main className="editor-main">
          {/* Agent progress bar */}
          <div className={`agent-progress-bar ${activeAgents.length > 0 ? 'agent-progress-active' : ''}`} />

          {/* Tab bar */}
          <div className="editor-tab-bar">
            <div className="tab-list">
              {openTabs.map((tab, idx) => (
                <div key={tab.path} className={`note-tab ${tab.path === selectedDocumentPath ? 'note-tab-active' : ''}`}>
                  {tab.path === selectedDocumentPath && dirty ? <span className="tab-unsaved-dot" title="Unsaved" /> : null}
                  <button type="button" className="tab-label" onClick={() => void loadDocument(tab.path)}>
                    {idx < 8 ? <span className="tab-shortcut">{idx + 1}</span> : null}
                    {tab.title}
                  </button>
                  <button type="button" className="tab-close" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(tab.path) }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                    </svg>
                  </button>
                </div>
              ))}
              <div className="tab-list-fade" />
            </div>
            <div className="view-controls">
              <div className="view-switcher">
                {(['edit', 'preview', 'split'] as ViewMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`view-btn ${documentViewMode === mode ? 'view-btn-active' : ''}`}
                    onClick={() => setDocumentViewMode(mode)}
                  >
                    {mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Document surface */}
          <section className={`doc-surface ${loadingDocument ? 'doc-loading' : ''}`}>
            {currentDocument ? (
              <>
                <DocHeader
                  document={currentDocument}
                  saveState={saveStateDot}
                  watchingAgents={watchingAgents}
                  onSave={() => void saveCurrentDocument({ autosave: false })}
                  onPathSegmentClick={(path) => {
                    const targetNode = findNodeByPath(tree, path)
                    const targetPath = targetNode?.kind === 'file' ? targetNode.path : firstFilePath(targetNode)
                    if (targetPath) {
                      void loadDocument(targetPath, { bypassConfirm: false })
                    }
                  }}
                />
                <div className={`doc-content doc-content-${documentViewMode}`}>
                  {documentViewMode !== 'preview' ? (
                    <MarkdownEditor value={editorValue} onChange={updateEditor} editable={currentDocument.editable} placeholder="Start writing..." />
                  ) : null}
                  {documentViewMode !== 'edit' ? (
                    <div className="preview-pane">
                      <MarkdownPreview value={editorValue} />
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <WelcomeView
                appName={appName}
                agents={agents}
                recentActivity={[...activity.attention, ...activity.today]}
                onNewNote={openNewNoteComposer}
                onAskAgent={() => { setOmnibarInitialInput(''); setOmnibarOpen(true) }}
                onSearch={() => { setOmnibarInitialInput(''); setOmnibarOpen(true) }}
                onActivityClick={openActivityItem}
              />
            )}
          </section>

          {/* Bottom drawer */}
          <BottomDrawer
            open={drawerOpen}
            activeTab={drawerTab}
            onTabChange={setDrawerTab}
            onClose={() => setDrawerOpen(false)}
            activity={activity}
            agents={agents}
            dismissedActivityIds={dismissedActivityIds}
            replyDrafts={replyDrafts}
            onReplyDraftChange={(id, text) => setReplyDrafts((c) => ({ ...c, [id]: text }))}
            onReplySubmit={(id) => void replyToAttention(id)}
            onDismissAttention={(id) => void dismissAttention(id)}
            onActivityItemClick={openActivityItem}
            onAgentClick={(agentId) => {
              void loadAgentDetails(agentId)
              setAgentSlideOutOpen(true)
            }}
            onManageAgents={() => setAgentSlideOutOpen(true)}
            askInput={askInput}
            onAskInputChange={setAskInput}
            onAskSubmit={() => void submitAsk(askInput)}
            routedAgentName={askCommandRoute.agent?.name ?? null}
          />
        </main>
      </div>

      {/* ---- Status bar ---- */}
      <StatusBar
        filePath={currentDocument?.path ?? null}
        wordCount={currentWordCount}
        saveState={saveStateDot}
        activeAgents={activeAgents}
        enabledAgents={enabledAgents}
        attentionCount={visibleAttention.length}
        onClickRight={() => openDrawer('activity')}
      />

      {/* ---- Omnibar ---- */}
      {omnibarOpen ? (
        <Omnibar
          open
          onClose={() => setOmnibarOpen(false)}
          agents={agents}
          recentTabs={openTabs}
          onSearchSelect={(path) => {
            setOmnibarOpen(false)
            void loadDocument(path, { bypassConfirm: false })
          }}
          onAskSubmit={(input) => {
            void submitAsk(input)
          }}
          onSearch={handleOmnibarSearch}
          initialInput={omnibarInitialInput}
        />
      ) : null}

      {/* ---- Agent slide-out ---- */}
      <AgentSlideOut
        open={agentSlideOutOpen}
        onClose={() => setAgentSlideOutOpen(false)}
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={(id) => void loadAgentDetails(id)}
        agentForm={agentForm}
        onAgentFormChange={setAgentForm}
        onAgentSave={(e) => void saveAgent(e)}
        onAgentReset={() => {
          setAgentForm(blankAgentForm(defaults))
          setJobForm(blankJobForm())
          setSelectedAgentId(null)
          setSelectedRunId(null)
        }}
        jobForm={jobForm}
        onJobFormChange={setJobForm}
        onJobSave={(e) => void saveJob(e)}
        onJobFill={(job) => setJobForm(jobToForm(job))}
        onJobRun={(jobId) => void runJob(jobId)}
        jobs={jobs}
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
        defaults={defaults}
      />

      {/* ---- Toasts ---- */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
