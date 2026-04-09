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
import { MarkdownPreview } from './components/MarkdownPreview'
import type {
  AgentDetailResponse,
  AgentRecord,
  BootstrapResponse,
  Defaults,
  DocumentRecord,
  EventEnvelope,
  JobRecord,
  RunRecord,
  SearchResult,
  TreeNode,
  ViewMode,
} from './types'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const APPROVALS = ['untrusted', 'on-failure', 'on-request', 'never']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
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
  scheduleType: 'manual' | 'interval'
  intervalMinutes: number
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
    scheduleType: 'interval',
    intervalMinutes: 60,
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
    scheduleType: job.scheduleType,
    intervalMinutes: job.intervalMinutes ?? 60,
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
  if (status === 'succeeded' || status === 'saved') {
    return 'success'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'queued' || status === 'running') {
    return 'warning'
  }
  return 'muted'
}

function shortRunTitle(run: RunRecord) {
  if (run.outputNotePath) {
    const parts = run.outputNotePath.split('/')
    return parts[parts.length - 1] || run.outputNotePath
  }
  return run.id
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

export default function App() {
  const [appName, setAppName] = useState('Astra')
  const [vaultName, setVaultName] = useState('Vault')
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [account, setAccount] = useState<BootstrapResponse['account'] | null>(null)
  const [currentDocument, setCurrentDocument] = useState<DocumentRecord | null>(null)
  const [selectedDocumentPath, setSelectedDocumentPath] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<Array<{ path: string; title: string }>>([])
  const [documentViewMode, setDocumentViewMode] = useState<ViewMode>(() =>
    currentViewportWidth() <= COMPACT_BREAKPOINT ? 'preview' : 'split',
  )
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => currentViewportWidth() > COMPACT_BREAKPOINT)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(() => currentViewportWidth() > MOBILE_BREAKPOINT)
  const [viewportWidth, setViewportWidth] = useState(() => currentViewportWidth())
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
  const [agentForm, setAgentForm] = useState<AgentFormState>(blankAgentForm(null))
  const [jobForm, setJobForm] = useState<JobFormState>(blankJobForm())
  const [quickRunPrompt, setQuickRunPrompt] = useState('')
  const [agentConfigOpen, setAgentConfigOpen] = useState(true)
  const [jobConfigOpen, setJobConfigOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState('')

  const searchWrapRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const newNoteNameRef = useRef<HTMLInputElement | null>(null)
  const previousViewportWidthRef = useRef(viewportWidth)

  const deferredSearchQuery = useDeferredValue(searchQuery.trim())
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null
  const currentWordCount = countWords(editorValue)
  const isCompactLayout = viewportWidth <= COMPACT_BREAKPOINT
  const isMobileLayout = viewportWidth <= MOBILE_BREAKPOINT

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

    const timeout = window.setTimeout(() => {
      setToastMessage('')
    }, 3_200)

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
        const result = await api<{ results: SearchResult[] }>(
          `/api/search?q=${encodeURIComponent(deferredSearchQuery)}`,
        )
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveCurrentDocument({ autosave: false })
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      toggleLeftSidebar()
      return
    }

    if (event.key === 'Escape') {
      setNewNoteOpen(false)
      setSearchOpen(false)
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
      await refreshTree()
      if (selectedDocumentPath && !dirty) {
        await loadDocument(selectedDocumentPath, { bypassConfirm: true })
      }
      return
    }

    if (message.type === 'agents.changed' || message.type === 'jobs.changed') {
      await refreshAgents()
      if (selectedAgentId) {
        await loadAgentDetails(selectedAgentId)
      }
      return
    }

    if (message.type === 'run.queued' || message.type === 'run.started' || message.type === 'run.completed') {
      await refreshAgents()
      await refreshRunsForSelection()
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
        setRuns(data.runs)
        setAccount(data.account)
        setAgentForm(blankAgentForm(data.defaults))
        setJobForm(blankJobForm())
      })

      if (data.agents.length > 0) {
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

    const timeout = window.setTimeout(() => {
      runAutosave()
    }, 900)

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
          reconnectTimer = window.setTimeout(connect, 1_500)
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

  async function refreshRunsForSelection() {
    if (selectedAgentId) {
      await loadAgentDetails(selectedAgentId)
      return
    }

    const result = await api<{ runs: RunRecord[] }>('/api/runs')
    startTransition(() => {
      setRuns(result.runs)
      setSelectedRunId((current) =>
        result.runs.some((run) => run.id === current) ? current : (result.runs[0]?.id ?? null),
      )
    })
  }

  async function loadDocument(path: string, options: { bypassConfirm: boolean } = { bypassConfirm: false }) {
    if (!options.bypassConfirm && !confirmDiscardChanges()) {
      return
    }

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
        setAgentConfigOpen(false)
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
      await refreshTree()
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

  async function quickRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedAgentId) {
      showToast('Select an agent first.')
      return
    }

    try {
      const result = await api<{ run: RunRecord }>(`/api/agents/${selectedAgentId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ prompt: quickRunPrompt }),
      })
      setQuickRunPrompt('')
      revealRightSidebar()
      showToast(`Run ${result.run.id} started.`)
      await refreshRunsForSelection()
      await refreshAgents()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start run.')
    }
  }

  async function runOnCurrentNote() {
    if (!selectedAgentId) {
      revealRightSidebar()
      showToast('Select an agent first.')
      return
    }

    if (!currentDocument?.path) {
      showToast('Open a note first.')
      return
    }

    const prompt = `Review the note at \`${currentDocument.path}\`. Improve its clarity and structure, preserve the author's intent, and write the results back into the vault if a meaningful update is warranted.`

    try {
      const result = await api<{ run: RunRecord }>(`/api/agents/${selectedAgentId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      })
      revealRightSidebar()
      showToast(`Run ${result.run.id} started.`)
      await refreshRunsForSelection()
      await refreshAgents()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start run.')
    }
  }

  async function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedAgentId) {
      showToast('Select an agent first.')
      return
    }

    const payload = {
      name: jobForm.name,
      prompt: jobForm.prompt,
      schedule_type: jobForm.scheduleType,
      interval_minutes: jobForm.intervalMinutes,
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
      await loadAgentDetails(selectedAgentId)
      setJobForm(blankJobForm())
      setSelectedJobId(null)
      setJobConfigOpen(false)
      showToast('Job saved.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save job.')
    }
  }

  async function runJob(jobId: string) {
    try {
      const result = await api<{ run: RunRecord }>(`/api/jobs/${jobId}/run`, { method: 'POST' })
      showToast(`Run ${result.run.id} started.`)
      await refreshRunsForSelection()
      await refreshAgents()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start job.')
    }
  }

  function resetAgentForm() {
    setSelectedAgentId(null)
    setSelectedJobId(null)
    setSelectedRunId(runs[0]?.id ?? null)
    setAgentForm(blankAgentForm(defaults))
    setJobs([])
    setQuickRunPrompt('')
    setAgentConfigOpen(true)
  }

  function fillJobForm(job: JobRecord) {
    setSelectedJobId(job.id)
    setJobForm(jobToForm(job))
    setJobConfigOpen(true)
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

  const accountLabel = account?.loggedIn ? account.email || 'Logged in' : 'Not logged in'
  const nextRunLabel = nextScheduledRun(agents)
  const statusAgentLabel = selectedAgent
    ? selectedAgent.isRunning
      ? `${selectedAgent.name} running`
      : selectedAgent.name
    : 'No agent'

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
                    <div
                      className="card-meta"
                      dangerouslySetInnerHTML={{ __html: highlightSnippet(result.snippet || '') }}
                    />
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
            title="Toggle agent panel"
            onClick={toggleRightSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="2" y="2" width="14" height="14" rx="2" />
              <path d="M11 2v14" />
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
              onSelect={(path) => void loadDocument(path)}
            />
          </nav>
        </aside>

        <main className="editor-main">
          <div className="editor-tab-bar">
            <div className="tab-list">
              {openTabs.map((tab) => (
                <button
                  key={tab.path}
                  type="button"
                  className={`note-tab ${tab.path === selectedDocumentPath ? 'note-tab-active' : ''}`.trim()}
                  onClick={() => void loadDocument(tab.path)}
                >
                  {tab.title}
                </button>
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

          <section className="doc-surface">
            <div className="doc-header">
              <div className="doc-header-text">
                <p className="doc-path">{currentDocument?.path || 'Choose a note from the vault.'}</p>
                <h1 className="doc-title">{currentDocument?.title || 'Welcome'}</h1>
              </div>
              <div className="doc-actions">
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  title="Run ambient agent on this note"
                  disabled={!selectedAgentId || !currentDocument?.editable}
                  onClick={() => void runOnCurrentNote()}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5,3 13,8 5,13" />
                  </svg>
                  Run
                </button>
                <span className={`state-pill ${currentDocumentStateKind()}`.trim()}>
                  {currentDocument ? saveStateLabel : 'Idle'}
                </span>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={!currentDocument?.editable}
                  onClick={() => void saveCurrentDocument({ autosave: false })}
                >
                  Save
                </button>
              </div>
            </div>

            <div className={`doc-content doc-content-${documentViewMode}`.trim()}>
              <textarea
                id="editor-textarea"
                spellCheck={false}
                className={documentViewMode === 'preview' ? 'hidden' : undefined}
                disabled={!currentDocument?.editable}
                placeholder="Select a note to start writing."
                value={editorValue}
                onChange={(event) => updateEditor(event.target.value)}
              />
              <div className={`preview-pane ${documentViewMode === 'edit' ? 'hidden' : ''}`.trim()}>
                <MarkdownPreview value={editorValue} />
              </div>
            </div>
          </section>
        </main>

        <aside className={`sidebar-right ${rightSidebarOpen ? '' : 'right-sidebar-collapsed'}`.trim()}>
          <div className="sidebar-scroll">
            <div className="panel-section agent-selector-section">
              <div className="section-head">
                <span className="section-label">Agents</span>
                <button
                  type="button"
                  className="icon-btn-sm"
                  title="New agent"
                  onClick={() => {
                    revealRightSidebar()
                    resetAgentForm()
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </button>
              </div>
              <div className="agent-picker">
                {agents.length === 0 ? (
                  <span className="empty-state">No agents yet.</span>
                ) : (
                  agents.map((agent) => {
                    const dotClass = agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className={`agent-chip ${agent.id === selectedAgentId ? 'agent-chip-active' : ''}`.trim()}
                        onClick={() => void loadAgentDetails(agent.id)}
                      >
                        <span className={`agent-chip-dot ${dotClass}`.trim()} />
                        {agent.name}
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            <div className="panel-section agent-context">
              <div className="agent-context-head">
                <div className="agent-context-info">
                  <h3 className="agent-context-name">{selectedAgent?.name || 'No agent selected'}</h3>
                  <p className="agent-context-meta">
                    {selectedAgent
                      ? [selectedAgent.scopePath || null, selectedAgent.threadId ? `Thread ${selectedAgent.threadId.slice(0, 8)}...` : 'No thread yet']
                          .filter(Boolean)
                          .join(' · ')
                      : 'Create an agent to get started.'}
                  </p>
                </div>
                <span
                  className={`agent-status-dot ${
                    selectedAgent?.isRunning ? 'dot-running' : selectedAgent?.enabled ? 'dot-ready' : selectedAgent ? 'dot-off' : ''
                  }`.trim()}
                />
              </div>

              <form className="quick-run-form" onSubmit={(event) => void quickRun(event)}>
                <textarea
                  rows={2}
                  name="quick-run-prompt"
                  placeholder="Ask this agent to do something..."
                  value={quickRunPrompt}
                  onChange={(event) => setQuickRunPrompt(event.target.value)}
                />
                <button type="submit" className="btn-primary btn-sm" disabled={!selectedAgentId}>
                  Run
                </button>
              </form>
            </div>

            <div className="panel-section">
              <div className="section-head">
                <span className="section-label">Runs</span>
              </div>
              <div className="run-list">
                {runs.length === 0 ? (
                  <div className="empty-state">No runs yet.</div>
                ) : (
                  runs.map((run) => (
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
                      <p className="card-meta">
                        {run.trigger} &middot; {formatDate(run.startedAt)}
                      </p>
                    </button>
                  ))
                )}
              </div>
              {selectedRun ? (
                <div className="run-detail">
                  <div className="card-row detail-row">
                    <span className="run-id-label">{selectedRun.id}</span>
                    <span className={`status-pill ${statusClass(selectedRun.status)}`.trim()}>{selectedRun.status}</span>
                  </div>
                  <div className="card-meta">
                    {formatDate(selectedRun.startedAt)} &rarr; {formatDate(selectedRun.finishedAt)}
                  </div>
                  {selectedRun.touchedPaths.length > 0 ? (
                    <div className="card-meta">Touched: {selectedRun.touchedPaths.join(', ')}</div>
                  ) : null}
                  <div className="card-meta run-detail-text">{selectedRun.finalText || selectedRun.errorText || 'No summary.'}</div>
                  {selectedRun.outputNotePath ? (
                    <div className="run-detail-actions">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => void loadDocument(selectedRun.outputNotePath as string, { bypassConfirm: false })}
                      >
                        Open note
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="run-detail empty-state">Select a run to see details.</div>
              )}
            </div>

            <div className="panel-section">
              <div className="section-head">
                <span className="section-label">Jobs</span>
                <button
                  type="button"
                  className="icon-btn-sm"
                  title="New job"
                  onClick={() => {
                    revealRightSidebar()
                    setSelectedJobId(null)
                    setJobForm(blankJobForm())
                    setJobConfigOpen(true)
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </button>
              </div>
              <div className="job-list">
                {jobs.length === 0 ? (
                  <div className="empty-state">No jobs for this agent.</div>
                ) : (
                  jobs.map((job) => (
                    <div key={job.id} className={`job-card ${job.id === selectedJobId ? 'job-card-active' : ''}`.trim()}>
                      <div className="card-row">
                        <span className="card-title">{job.name}</span>
                        <span className={`status-pill ${job.enabled ? 'success' : 'muted'}`.trim()}>
                          {job.scheduleType === 'interval' ? `${job.intervalMinutes}m` : 'Manual'}
                        </span>
                      </div>
                      <p className="card-meta">Next: {formatDate(job.nextRunAt)}</p>
                      <div className="form-row job-card-actions">
                        <button type="button" className="btn-ghost btn-sm" onClick={() => fillJobForm(job)}>
                          Edit
                        </button>
                        <button type="button" className="btn-primary btn-sm" onClick={() => void runJob(job.id)}>
                          Run now
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <details
                className="config-details"
                open={jobConfigOpen}
                onToggle={(event) => setJobConfigOpen((event.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>{jobForm.id ? 'Edit job' : 'New job'}</summary>
                <form className="config-form" onSubmit={(event) => void saveJob(event)}>
                  <label>
                    <span>Name</span>
                    <input
                      name="job-name"
                      type="text"
                      placeholder="Daily scan"
                      required
                      value={jobForm.name}
                      onChange={(event) => setJobForm((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Prompt</span>
                    <textarea
                      rows={3}
                      name="job-prompt"
                      placeholder="What should happen each run."
                      required
                      value={jobForm.prompt}
                      onChange={(event) => setJobForm((current) => ({ ...current, prompt: event.target.value }))}
                    />
                  </label>
                  <div className="form-grid-2">
                    <label>
                      <span>Schedule</span>
                      <select
                        name="job-schedule-type"
                        value={jobForm.scheduleType}
                        onChange={(event) =>
                          setJobForm((current) => ({
                            ...current,
                            scheduleType: event.target.value as JobFormState['scheduleType'],
                          }))
                        }
                      >
                        <option value="interval">Heartbeat</option>
                        <option value="manual">Manual</option>
                      </select>
                    </label>
                    <label>
                      <span>Interval (min)</span>
                      <input
                        name="job-interval-minutes"
                        type="number"
                        min="1"
                        step="1"
                        disabled={jobForm.scheduleType !== 'interval'}
                        value={jobForm.intervalMinutes}
                        onChange={(event) =>
                          setJobForm((current) => ({
                            ...current,
                            intervalMinutes: Number(event.target.value || 0),
                          }))
                        }
                      />
                    </label>
                  </div>
                  <label className="checkbox-label">
                    <input
                      name="job-enabled"
                      type="checkbox"
                      checked={jobForm.enabled}
                      onChange={(event) => setJobForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enabled</span>
                  </label>
                  <div className="form-row">
                    <button type="submit" className="btn-primary btn-sm">
                      Save job
                    </button>
                  </div>
                </form>
              </details>
            </div>

            <div className="panel-section">
              <details
                className="config-details"
                open={agentConfigOpen}
                onToggle={(event) => setAgentConfigOpen((event.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>Agent settings</summary>
                <form className="config-form" onSubmit={(event) => void saveAgent(event)}>
                  <label>
                    <span>Name</span>
                    <input
                      name="agent-name"
                      type="text"
                      placeholder="Research Copilot"
                      required
                      value={agentForm.name}
                      onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Scope</span>
                    <input
                      name="agent-scope-path"
                      type="text"
                      placeholder="Research"
                      value={agentForm.scopePath}
                      onChange={(event) => setAgentForm((current) => ({ ...current, scopePath: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Output dir</span>
                    <input
                      name="agent-output-dir"
                      type="text"
                      placeholder="Research/Inbox"
                      value={agentForm.outputDir}
                      onChange={(event) => setAgentForm((current) => ({ ...current, outputDir: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Prompt</span>
                    <textarea
                      rows={4}
                      name="agent-prompt"
                      placeholder="Describe the agent's role."
                      required
                      value={agentForm.prompt}
                      onChange={(event) => setAgentForm((current) => ({ ...current, prompt: event.target.value }))}
                    />
                  </label>
                  <div className="form-grid-2">
                    <label>
                      <span>Model</span>
                      <input
                        name="agent-model"
                        type="text"
                        value={agentForm.model}
                        onChange={(event) => setAgentForm((current) => ({ ...current, model: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Effort</span>
                      <select
                        name="agent-reasoning-effort"
                        value={agentForm.reasoningEffort}
                        onChange={(event) =>
                          setAgentForm((current) => ({ ...current, reasoningEffort: event.target.value }))
                        }
                      >
                        {EFFORTS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Approval</span>
                      <select
                        name="agent-approval-policy"
                        value={agentForm.approvalPolicy}
                        onChange={(event) =>
                          setAgentForm((current) => ({ ...current, approvalPolicy: event.target.value }))
                        }
                      >
                        {APPROVALS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Sandbox</span>
                      <select
                        name="agent-sandbox-mode"
                        value={agentForm.sandboxMode}
                        onChange={(event) =>
                          setAgentForm((current) => ({ ...current, sandboxMode: event.target.value }))
                        }
                      >
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
                      name="agent-enabled"
                      type="checkbox"
                      checked={agentForm.enabled}
                      onChange={(event) => setAgentForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enabled</span>
                  </label>
                  <div className="form-row">
                    <button type="submit" className="btn-primary btn-sm">
                      Save
                    </button>
                    <button type="button" className="btn-ghost btn-sm" onClick={resetAgentForm}>
                      Reset
                    </button>
                  </div>
                </form>
              </details>
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
          <span>{statusAgentLabel}</span>
          <span className="status-sep">&middot;</span>
          <span>{nextRunLabel ? `Next: ${formatDate(nextRunLabel)}` : 'No heartbeat'}</span>
        </div>
      </footer>

      <div className={`toast ${toastMessage ? '' : 'hidden'}`.trim()}>{toastMessage}</div>
    </div>
  )
}
