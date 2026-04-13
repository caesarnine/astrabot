import { useEffect, useState } from 'react'
import type { AgentRecord } from '../types'

interface StatusBarProps {
  filePath: string | null
  wordCount: number
  saveState: 'clean' | 'dirty' | 'saving' | 'error'
  activeAgents: AgentRecord[]
  enabledAgents: AgentRecord[]
  attentionCount: number
  onClickRight: () => void
}

function elapsed(agent: AgentRecord): string {
  if (!agent.lastRunAt) return ''
  const diff = Date.now() - new Date(agent.lastRunAt).getTime()
  if (diff < 0) return ''
  if (diff < 60_000) return '<1m'
  return `${Math.floor(diff / 60_000)}m`
}

export function StatusBar({
  filePath,
  wordCount,
  saveState,
  activeAgents,
  enabledAgents,
  attentionCount,
  onClickRight,
}: StatusBarProps) {
  const [, setTick] = useState(0)

  // Tick every 30s to update elapsed times
  useEffect(() => {
    if (activeAgents.length === 0) return
    const interval = window.setInterval(() => setTick((t) => t + 1), 30_000)
    return () => window.clearInterval(interval)
  }, [activeAgents.length])

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className="status-path">{filePath || 'No note'}</span>
        <span className="status-sep">&middot;</span>
        <span>{wordCount} words</span>
        <span className="status-sep">&middot;</span>
        <span className={`status-save-dot ${saveState}`} title={saveState} />
      </div>
      <div className="status-right status-heartbeat" onClick={onClickRight}>
        {activeAgents.length > 0 ? (
          <>
            <span className="status-running-dot" />
            <span className="status-running-label">
              {activeAgents[0].name} running
              {activeAgents[0].lastRunAt ? ` \u2014 ${elapsed(activeAgents[0])}` : ''}
            </span>
            {activeAgents.length > 1 ? (
              <span className="status-more">+{activeAgents.length - 1}</span>
            ) : null}
          </>
        ) : (
          <span className="status-idle-label">
            Agents: {enabledAgents.length} ready
          </span>
        )}
        {attentionCount > 0 ? (
          <button type="button" className="status-attention-badge" onClick={(e) => { e.stopPropagation(); onClickRight() }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 5v3M8 10.5v.5" />
              <circle cx="8" cy="8" r="6" />
            </svg>
            {attentionCount}
          </button>
        ) : null}
      </div>
    </footer>
  )
}
