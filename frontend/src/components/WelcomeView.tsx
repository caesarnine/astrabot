import { useEffect, useState } from 'react'
import type { ActivityRecord, AgentRecord } from '../types'

interface WelcomeViewProps {
  appName: string
  agents: AgentRecord[]
  recentActivity: ActivityRecord[]
  onNewNote: () => void
  onAskAgent: () => void
  onSearch: () => void
  onActivityClick: (item: ActivityRecord) => void
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diff = Date.now() - date.getTime()
  if (diff >= 0 && diff < 60_000) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const LAST_VISIT_KEY = 'astra-last-visit'

export function WelcomeView({
  appName,
  agents,
  recentActivity,
  onNewNote,
  onAskAgent,
  onSearch,
  onActivityClick,
}: WelcomeViewProps) {
  const [wasAway] = useState(() => {
    if (typeof window === 'undefined') return false
    const lastVisit = window.localStorage.getItem(LAST_VISIT_KEY)
    if (!lastVisit) return false
    return Date.now() - Number(lastVisit) > 3_600_000
  })
  const enabledAgents = agents.filter((a) => a.enabled)

  useEffect(() => {
    window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()))
  }, [])

  return (
    <div className="welcome-view">
      <div className="welcome-logo">
        <span className="brand-mark brand-mark-lg">A</span>
      </div>
      <h1 className="welcome-title">{appName}</h1>
      <p className="welcome-subtitle">Your knowledge workspace with ambient agents.</p>

      <div className="welcome-actions">
        <button type="button" className="btn-primary" onClick={onNewNote}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New Note
        </button>
        <button type="button" className="btn-ghost" onClick={onAskAgent}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M2 8h12M10 4l4 4-4 4" />
          </svg>
          Ask an Agent
        </button>
        <button type="button" className="btn-ghost" onClick={onSearch}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10 10l4 4" />
          </svg>
          Search
        </button>
      </div>

      {/* Agent status */}
      {agents.length > 0 ? (
        <div className="welcome-agents">
          <p className="welcome-agents-label">
            {enabledAgents.length} agent{enabledAgents.length !== 1 ? 's' : ''} ready
          </p>
          <div className="welcome-agent-row">
            {agents.slice(0, 4).map((agent) => (
              <span key={agent.id} className="welcome-agent-chip">
                <span className={`agent-dot ${agent.isRunning ? 'dot-running' : agent.enabled ? 'dot-ready' : 'dot-off'}`} />
                {agent.name}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Recent activity / since you've been away */}
      {recentActivity.length > 0 ? (
        <div className="welcome-activity">
          <p className="welcome-activity-label">
            {wasAway ? 'Since you\u2019ve been away' : 'Recent activity'}
          </p>
          <div className="welcome-activity-list">
            {recentActivity.slice(0, 5).map((item) => (
              <button
                key={item.id}
                type="button"
                className="welcome-activity-item"
                onClick={() => onActivityClick(item)}
              >
                <span className={`welcome-activity-dot ${item.kind === 'attention' ? 'dot-attention' : 'dot-artifact'}`} />
                <span className="welcome-activity-text">{item.title}</span>
                <span className="welcome-activity-time">{formatDate(item.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
