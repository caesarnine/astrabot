import type {
  ActivityBundle,
  ActivityRecord,
  AgentRecord,
  DrawerTab,
  UpcomingItem,
} from '../types'

interface BottomDrawerProps {
  open: boolean
  activeTab: DrawerTab
  onTabChange: (tab: DrawerTab) => void
  onClose: () => void
  /* Activity tab */
  activity: ActivityBundle
  agents: AgentRecord[]
  dismissedActivityIds: string[]
  replyDrafts: Record<string, string>
  onReplyDraftChange: (id: string, text: string) => void
  onReplySubmit: (activityId: string) => void
  onDismissAttention: (activityId: string) => void
  onActivityItemClick: (item: ActivityRecord) => void
  /* Agents tab */
  onAgentClick: (agentId: string) => void
  onManageAgents: () => void
  /* Ask tab */
  askInput: string
  onAskInputChange: (value: string) => void
  onAskSubmit: () => void
  routedAgentName: string | null
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

function feedDotClass(item: ActivityRecord | UpcomingItem) {
  if ('triggerType' in item) return 'feed-dot-ring'
  if ((item as ActivityRecord).kind === 'attention') return 'feed-dot-attention'
  if ((item as ActivityRecord).kind === 'artifact') return 'feed-dot-artifact'
  return 'feed-dot-notification'
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?\n]+[.!?]?/)
  return match ? match[0].trim() : text.slice(0, 80)
}

function agentById(agents: AgentRecord[], id: string): AgentRecord | undefined {
  return agents.find((a) => a.id === id)
}

export function BottomDrawer({
  open,
  activeTab,
  onTabChange,
  onClose,
  activity,
  agents,
  dismissedActivityIds,
  replyDrafts,
  onReplyDraftChange,
  onReplySubmit,
  onDismissAttention,
  onActivityItemClick,
  onAgentClick,
  onManageAgents,
  askInput,
  onAskInputChange,
  onAskSubmit,
  routedAgentName,
}: BottomDrawerProps) {
  const visibleAttention = activity.attention.filter(
    (item) => !dismissedActivityIds.includes(item.id),
  )

  return (
    <div className={`bottom-drawer ${open ? 'drawer-open' : ''}`}>
      <div className="drawer-header">
        <div className="drawer-tabs">
          {(['activity', 'agents', 'ask'] as DrawerTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`drawer-tab ${activeTab === tab ? 'drawer-tab-active' : ''}`}
              onClick={() => onTabChange(tab)}
            >
              {tab === 'activity' ? 'Activity' : tab === 'agents' ? 'Agents' : 'Ask'}
              {tab === 'activity' && visibleAttention.length > 0 ? (
                <span className="drawer-tab-badge">{visibleAttention.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <button type="button" className="drawer-close" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 9l6-6M3 3l6 6" />
          </svg>
        </button>
      </div>

      <div className="drawer-content">
        {/* ---- Activity Tab ---- */}
        {activeTab === 'activity' ? (
          <div className="drawer-activity">
            {/* Attention items first */}
            {visibleAttention.length > 0 ? (
              <div className="drawer-section">
                <div className="drawer-section-label">Needs Attention</div>
                <div className="drawer-feed">
                  {visibleAttention.map((item) => (
                    <div key={item.id} className="drawer-card drawer-card-attention">
                      <div className="drawer-card-head">
                        <span className="feed-dot feed-dot-attention" />
                        <span className="drawer-card-title">{item.title}</span>
                        <span className={`status-pill ${statusClass(item.status)}`}>{item.status}</span>
                      </div>
                      <p className="drawer-card-meta">
                        {agentById(agents, item.agentId)?.name || 'Agent'} &middot; {formatDate(item.createdAt)}
                      </p>
                      {item.body ? <p className="drawer-card-body">{item.body}</p> : null}
                      <div className="drawer-card-actions">
                        <input
                          type="text"
                          placeholder="Reply..."
                          value={replyDrafts[item.id] ?? ''}
                          onChange={(e) => onReplyDraftChange(item.id, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') onReplySubmit(item.id) }}
                        />
                        <button type="button" className="btn-primary btn-sm" onClick={() => onReplySubmit(item.id)}>Reply</button>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => onDismissAttention(item.id)}>Dismiss</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Today's activity */}
            <div className="drawer-section">
              <div className="drawer-section-label">Today</div>
              {activity.today.length === 0 ? (
                <div className="drawer-empty">
                  <p>No activity yet today.</p>
                </div>
              ) : (
                <div className="drawer-feed">
                  {activity.today.map((item) => (
                    <button key={item.id} type="button" className="drawer-card" onClick={() => onActivityItemClick(item)}>
                      <div className="drawer-card-head">
                        <span className={`feed-dot ${feedDotClass(item)}`} />
                        <span className="drawer-card-title">{item.title}</span>
                        <span className="drawer-card-time">{formatDate(item.createdAt)}</span>
                      </div>
                      {item.primaryPath ? <p className="drawer-card-meta">{item.primaryPath}</p> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Upcoming */}
            {activity.upcoming.length > 0 ? (
              <div className="drawer-section">
                <details className="drawer-upcoming">
                  <summary className="drawer-section-label drawer-section-toggle">
                    Upcoming
                    <span className="drawer-upcoming-count">{activity.upcoming.length}</span>
                  </summary>
                  <div className="drawer-feed">
                    {activity.upcoming.map((item) => (
                      <div key={item.id} className="drawer-card drawer-card-upcoming">
                        <div className="drawer-card-head">
                          <span className="feed-dot feed-dot-ring" />
                          <span className="drawer-card-title">{item.agentName}</span>
                          <span className="drawer-card-time">
                            {item.nextRunAt ? formatDate(item.nextRunAt) : 'Watching'}
                          </span>
                        </div>
                        <p className="drawer-card-meta">
                          {item.jobName} &middot; {item.triggerType === 'file_watch'
                            ? `watching ${item.watchPath || 'scope'}`
                            : item.nextRunAt
                              ? `next ${formatDate(item.nextRunAt)}`
                              : 'scheduled'}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---- Agents Tab ---- */}
        {activeTab === 'agents' ? (
          <div className="drawer-agents">
            {agents.length === 0 ? (
              <div className="drawer-empty">
                <p>No agents configured yet.</p>
                <button type="button" className="btn-primary btn-sm" onClick={onManageAgents}>Create one</button>
              </div>
            ) : (
              <div className="drawer-agent-grid">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`drawer-agent-card ${agent.isRunning ? 'drawer-agent-running' : ''}`}
                    onClick={() => onAgentClick(agent.id)}
                  >
                    <div className="drawer-agent-head">
                      <span className={`agent-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`} />
                      <span className="drawer-agent-name">{agent.name}</span>
                      <span className="drawer-agent-status">
                        {agent.isRunning ? 'running' : agent.enabled ? 'idle' : 'off'}
                      </span>
                    </div>
                    <p className="drawer-agent-desc">{firstSentence(agent.prompt)}</p>
                    <p className="drawer-agent-meta">
                      {agent.scopePath || 'whole vault'}
                      {agent.lastRunAt ? ` \u00b7 last ${formatDate(agent.lastRunAt)}` : ''}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <div className="drawer-agent-footer">
              <button type="button" className="btn-ghost btn-sm" onClick={onManageAgents}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <circle cx="8" cy="8" r="2.2" />
                  <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" />
                </svg>
                Manage Agents
              </button>
            </div>
          </div>
        ) : null}

        {/* ---- Ask Tab ---- */}
        {activeTab === 'ask' ? (
          <div className="drawer-ask">
            <form
              className="drawer-ask-form"
              onSubmit={(e) => { e.preventDefault(); onAskSubmit() }}
            >
              <input
                type="text"
                placeholder="@Agent ask something..."
                value={askInput}
                onChange={(e) => onAskInputChange(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn-primary btn-sm">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 8h12M10 4l4 4-4 4" />
                </svg>
              </button>
            </form>
            <div className="drawer-ask-hint">
              {routedAgentName ? (
                <span>Routes to <strong>{routedAgentName}</strong></span>
              ) : (
                <span>Type <strong>@AgentName</strong> followed by your prompt</span>
              )}
            </div>
            <div className="drawer-ask-agents">
              {agents.filter((a) => a.enabled).map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="drawer-ask-chip"
                  onClick={() => onAskInputChange(`@${agent.name} `)}
                >
                  <span className={`agent-dot ${agent.isRunning ? 'dot-running' : 'dot-ready'}`} />
                  {agent.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
