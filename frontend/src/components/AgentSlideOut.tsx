import { useState, type FormEvent } from 'react'
import type {
  AgentFormState,
  AgentRecord,
  Defaults,
  JobFormState,
  JobRecord,
  RunRecord,
} from '../types'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const APPROVALS = ['untrusted', 'on-failure', 'on-request', 'never']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const TRIGGERS = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' },
  { value: 'file_watch', label: 'File Watch' },
  { value: 'manual', label: 'Manual' },
] as const

interface AgentSlideOutProps {
  open: boolean
  onClose: () => void
  agents: AgentRecord[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  agentForm: AgentFormState
  onAgentFormChange: (form: AgentFormState) => void
  onAgentSave: (e: FormEvent<HTMLFormElement>) => void
  onAgentReset: () => void
  onAgentDelete: (agentId: string) => void
  jobForm: JobFormState
  onJobFormChange: (form: JobFormState) => void
  onJobSave: (e: FormEvent<HTMLFormElement>) => void
  onJobFill: (job: JobRecord) => void
  onJobRun: (jobId: string) => void
  onJobDelete: (jobId: string) => void
  jobs: JobRecord[]
  runs: RunRecord[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  defaults: Defaults | null
}

function formatDate(value: string | null) {
  if (!value) return '\u2014'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diff = Date.now() - date.getTime()
  if (diff >= 0 && diff < 60_000) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusClass(status: string) {
  if (status === 'succeeded' || status === 'replied') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'queued' || status === 'running' || status === 'pending') return 'warning'
  return 'muted'
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?\n]+[.!?]?/)
  return match ? match[0].trim() : text.slice(0, 80)
}

function describeJobSchedule(job: JobRecord) {
  if (job.triggerType === 'file_watch') return job.watchPath ? `Watching ${job.watchPath}` : 'Watching scope'
  if (job.triggerType === 'cron') return job.cronPreview || job.cronExpression || 'Cron'
  if (job.triggerType === 'interval') return job.intervalMinutes ? `${job.intervalMinutes}m` : 'Interval'
  return 'Manual'
}

export function AgentSlideOut({
  open,
  onClose,
  agents,
  selectedAgentId,
  onSelectAgent,
  agentForm,
  onAgentFormChange,
  onAgentSave,
  onAgentReset,
  onAgentDelete,
  jobForm,
  onJobFormChange,
  onJobSave,
  onJobFill,
  onJobRun,
  onJobDelete,
  jobs,
  runs,
  selectedRunId,
  onSelectRun,
}: AgentSlideOutProps) {
  const [editingAgent, setEditingAgent] = useState(false)
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null
  const creatingNew = editingAgent && !selectedAgentId

  function beginNewAgent() {
    onAgentReset()
    setEditingAgent(true)
  }

  function renderAgentEditor(includeDetails: boolean) {
    return (
      <div className="slideout-edit">
        <form className="config-form" onSubmit={(e) => { onAgentSave(e); setEditingAgent(false) }}>
          <label>
            <span>Name</span>
            <input value={agentForm.name} onChange={(e) => onAgentFormChange({ ...agentForm, name: e.target.value })} />
          </label>
          <label>
            <span>Scope</span>
            <input value={agentForm.scopePath} onChange={(e) => onAgentFormChange({ ...agentForm, scopePath: e.target.value })} />
          </label>
          <label>
            <span>Output dir</span>
            <input value={agentForm.outputDir} onChange={(e) => onAgentFormChange({ ...agentForm, outputDir: e.target.value })} />
          </label>
          <label>
            <span>Prompt</span>
            <textarea rows={3} value={agentForm.prompt} onChange={(e) => onAgentFormChange({ ...agentForm, prompt: e.target.value })} />
          </label>
          <div className="form-grid-2">
            <label>
              <span>Model</span>
              <input value={agentForm.model} onChange={(e) => onAgentFormChange({ ...agentForm, model: e.target.value })} />
            </label>
            <label>
              <span>Effort</span>
              <select value={agentForm.reasoningEffort} onChange={(e) => onAgentFormChange({ ...agentForm, reasoningEffort: e.target.value })}>
                {EFFORTS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label>
              <span>Approval</span>
              <select value={agentForm.approvalPolicy} onChange={(e) => onAgentFormChange({ ...agentForm, approvalPolicy: e.target.value })}>
                {APPROVALS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label>
              <span>Sandbox</span>
              <select value={agentForm.sandboxMode} onChange={(e) => onAgentFormChange({ ...agentForm, sandboxMode: e.target.value })}>
                {SANDBOXES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={agentForm.enabled} onChange={(e) => onAgentFormChange({ ...agentForm, enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
          <div className="form-row">
            <button type="submit" className="btn-primary btn-sm">Save</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingAgent(false)}>Cancel</button>
          </div>
        </form>

        {includeDetails ? (
          <>
            <div className="slideout-section">
              <div className="slideout-section-head">
                <span className="section-label">Jobs</span>
              </div>
              {jobs.map((job) => (
                <div key={job.id} className="slideout-job">
                  <div className="card-row">
                    <span className="card-title">{job.name}</span>
                    <span className={`status-pill ${job.enabled ? 'success' : 'muted'}`}>{job.triggerType}</span>
                  </div>
                  <p className="card-meta">{describeJobSchedule(job)}</p>
                  <div className="form-row" style={{ marginTop: 4 }}>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => onJobFill(job)}>Edit</button>
                    <button type="button" className="btn-primary btn-sm" onClick={() => onJobRun(job.id)}>Run</button>
                    <button type="button" className="btn-danger btn-sm" onClick={() => onJobDelete(job.id)}>Delete</button>
                  </div>
                </div>
              ))}
              <form className="config-form" onSubmit={onJobSave}>
                <label>
                  <span>Job name</span>
                  <input value={jobForm.name} onChange={(e) => onJobFormChange({ ...jobForm, name: e.target.value })} />
                </label>
                <label>
                  <span>Prompt</span>
                  <textarea rows={2} value={jobForm.prompt} onChange={(e) => onJobFormChange({ ...jobForm, prompt: e.target.value })} />
                </label>
                <div className="form-grid-2">
                  <label>
                    <span>Trigger</span>
                    <select value={jobForm.triggerType} onChange={(e) => onJobFormChange({ ...jobForm, triggerType: e.target.value as JobFormState['triggerType'] })}>
                      {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Interval (min)</span>
                    <input type="number" min="1" disabled={jobForm.triggerType !== 'interval'} value={jobForm.intervalMinutes} onChange={(e) => onJobFormChange({ ...jobForm, intervalMinutes: Number(e.target.value || 0) })} />
                  </label>
                  <label>
                    <span>Cron</span>
                    <input disabled={jobForm.triggerType !== 'cron'} value={jobForm.cronExpression} onChange={(e) => onJobFormChange({ ...jobForm, cronExpression: e.target.value })} />
                  </label>
                  <label>
                    <span>Watch path</span>
                    <input disabled={jobForm.triggerType !== 'file_watch'} value={jobForm.watchPath} onChange={(e) => onJobFormChange({ ...jobForm, watchPath: e.target.value })} />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input type="checkbox" checked={jobForm.enabled} onChange={(e) => onJobFormChange({ ...jobForm, enabled: e.target.checked })} />
                  <span>Enabled</span>
                </label>
                <div className="form-row">
                  <button type="submit" className="btn-primary btn-sm">Save job</button>
                </div>
              </form>
            </div>

            <div className="slideout-section">
              <div className="slideout-section-head">
                <span className="section-label">Runs</span>
              </div>
              <div className="slideout-runs">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`slideout-run ${run.id === selectedRunId ? 'slideout-run-active' : ''}`}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <div className="card-row">
                      <span className="card-title">{run.touchedPaths[0] || run.summaryText || run.id}</span>
                      <span className={`status-pill ${statusClass(run.status)}`}>{run.status}</span>
                    </div>
                    <p className="card-meta">{formatDate(run.startedAt)}</p>
                  </button>
                ))}
              </div>
              {selectedRun ? (
                <div className="slideout-run-detail">
                  <div className="card-row">
                    <span className="run-id-label">{selectedRun.id}</span>
                    <span className={`status-pill ${statusClass(selectedRun.status)}`}>{selectedRun.status}</span>
                  </div>
                  <p className="card-meta">{selectedRun.summaryText || selectedRun.errorText || 'No summary.'}</p>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    )
  }

  if (!open) return null

  return (
    <>
      <div className="slideout-backdrop" onClick={onClose} />
      <div className={`agent-slideout ${open ? 'slideout-open' : ''}`}>
        <div className="slideout-header">
          <h2>Agents</h2>
          <button type="button" className="icon-btn-sm" onClick={onClose}>&times;</button>
        </div>

        {/* Agent cards */}
        <div className="slideout-cards">
          {agents.length === 0 && !creatingNew ? (
            <div className="drawer-empty">
              <p>No agents configured yet.</p>
              <button type="button" className="btn-primary btn-sm" onClick={beginNewAgent}>Create one</button>
            </div>
          ) : null}

          {creatingNew ? (
            <div className="slideout-card slideout-card-selected">
              <div className="slideout-card-row">
                <span className="agent-dot dot-ready" />
                <strong>New agent</strong>
              </div>
              <p className="slideout-card-meta">Create an agent to route tasks into a scope.</p>
              {renderAgentEditor(false)}
            </div>
          ) : null}

          {agents.map((agent) => {
            const isSelected = agent.id === selectedAgentId
            const isEditing = isSelected && editingAgent
            return (
              <div key={agent.id} className={`slideout-card ${isSelected ? 'slideout-card-selected' : ''}`}>
                <button
                  type="button"
                  className="slideout-card-summary"
                  onClick={() => {
                    onSelectAgent(agent.id)
                    setEditingAgent(false)
                  }}
                >
                  <div className="slideout-card-row">
                    <span className={`agent-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`} />
                    <strong>{agent.name}</strong>
                    <span className="slideout-card-status">
                      {agent.isRunning ? 'running' : agent.enabled ? 'idle' : 'disabled'}
                    </span>
                  </div>
                  <p className="slideout-card-desc">{firstSentence(agent.prompt)}</p>
                  <p className="slideout-card-meta">
                    {agent.scopePath || 'whole vault'}
                    {agent.lastRunAt ? ` \u00b7 last ${formatDate(agent.lastRunAt)}` : ''}
                  </p>
                </button>

                {isSelected && !isEditing ? (
                  <div className="slideout-card-actions">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingAgent(true)}>Edit</button>
                    <button type="button" className="btn-danger btn-sm" onClick={() => onAgentDelete(agent.id)}>Delete</button>
                  </div>
                ) : null}

                {isEditing ? (
                  renderAgentEditor(true)
                ) : null}
              </div>
            )
          })}
          <button type="button" className="btn-ghost btn-sm" onClick={beginNewAgent} style={{ marginTop: 8 }}>
            + New agent
          </button>
        </div>
      </div>
    </>
  )
}
