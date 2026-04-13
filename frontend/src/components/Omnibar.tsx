import { useEffect, useRef, useState, useCallback } from 'react'
import type { AgentRecord, SearchResult } from '../types'

interface OmnibarProps {
  open: boolean
  onClose: () => void
  agents: AgentRecord[]
  recentTabs: Array<{ path: string; title: string }>
  onSearchSelect: (path: string) => void
  onAskSubmit: (input: string) => void
  onSearch: (query: string) => Promise<SearchResult[]>
  initialInput?: string
}

function matchAgentByPrefix(agents: AgentRecord[], input: string): AgentRecord | null {
  if (!input.startsWith('@')) return null
  const match = input.slice(1).match(/^([^\s]+)/)
  if (!match?.[1]) return null
  const name = match[1].toLowerCase()
  return agents.find((a) => a.name.toLowerCase() === name) ?? null
}

export function Omnibar({
  open,
  onClose,
  agents,
  recentTabs,
  onSearchSelect,
  onAskSubmit,
  onSearch,
  initialInput,
}: OmnibarProps) {
  const [input, setInput] = useState(() => initialInput ?? '')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<number>(0)
  const searchSequence = useRef(0)

  useEffect(() => {
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(focusTimer)
      window.clearTimeout(searchTimer.current)
    }
  }, [])

  const isAgentMode = input.startsWith('@')
  const routedAgent = matchAgentByPrefix(agents, input)

  const queueSearch = useCallback((nextInput: string) => {
    window.clearTimeout(searchTimer.current)
    searchSequence.current += 1

    const trimmed = nextInput.trim()
    if (!trimmed || nextInput.startsWith('@')) {
      setSearching(false)
      setResults([])
      return
    }

    const requestId = searchSequence.current
    setSearching(true)
    searchTimer.current = window.setTimeout(async () => {
      const r = await onSearch(trimmed)
      if (searchSequence.current !== requestId) return
      setResults(r)
      setSearching(false)
    }, 180)
  }, [onSearch])

  function handleInputChange(nextInput: string) {
    setInput(nextInput)
    queueSearch(nextInput)
  }

  const handleSubmit = useCallback(() => {
    if (isAgentMode && input.trim().length > 1) {
      onAskSubmit(input)
      onClose()
    } else if (results.length > 0) {
      onSearchSelect(results[0].path)
      onClose()
    }
  }, [input, isAgentMode, results, onAskSubmit, onSearchSelect, onClose])

  if (!open) return null

  return (
    <div className="omnibar-backdrop" onClick={onClose}>
      <div className="omnibar" onClick={(e) => e.stopPropagation()}>
        <div className="omnibar-input-row">
          <svg className="omnibar-search-icon" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="7.5" cy="7.5" r="5.5" />
            <path d="M12 12l4 4" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search notes, @agent to ask..."
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
              if (e.key === 'Escape') onClose()
            }}
          />
          <kbd className="omnibar-kbd">esc</kbd>
        </div>

        {/* Routing hint */}
        {isAgentMode ? (
          <div className="omnibar-hint">
            {routedAgent ? (
              <span>
                <span className={`agent-dot ${routedAgent.isRunning ? 'dot-running' : 'dot-ready'}`} />
                Routes to <strong>{routedAgent.name}</strong>
                {routedAgent.scopePath ? ` in ${routedAgent.scopePath}` : ''}
              </span>
            ) : (
              <span className="omnibar-hint-muted">No agent matched. Available: {agents.filter((a) => a.enabled).map((a) => a.name).join(', ')}</span>
            )}
          </div>
        ) : null}

        {/* Agent chips */}
        {!input.trim() ? (
          <div className="omnibar-section">
            <div className="omnibar-agents-row">
              {agents.filter((a) => a.enabled).slice(0, 6).map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="omnibar-agent-chip"
                  onClick={() => handleInputChange(`@${agent.name} `)}
                >
                  <span className={`agent-dot ${agent.isRunning ? 'dot-running' : 'dot-ready'}`} />
                  {agent.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Recent files */}
        {!input.trim() && recentTabs.length > 0 ? (
          <div className="omnibar-section">
            <div className="omnibar-section-label">Recent</div>
            {recentTabs.slice(0, 4).map((tab) => (
              <button
                key={tab.path}
                type="button"
                className="omnibar-result"
                onClick={() => { onSearchSelect(tab.path); onClose() }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
                  <path d="M5 5h6M5 8h6M5 11h3" />
                </svg>
                <span className="omnibar-result-title">{tab.title}</span>
                <span className="omnibar-result-path">{tab.path}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Search results */}
        {!isAgentMode && input.trim() ? (
          <div className="omnibar-section">
            {searching ? (
              <div className="omnibar-searching">Searching...</div>
            ) : results.length === 0 ? (
              <div className="omnibar-no-results">No results found.</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className="omnibar-result"
                  onClick={() => { onSearchSelect(r.path); onClose() }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
                    <path d="M5 5h6M5 8h6M5 11h3" />
                  </svg>
                  <span className="omnibar-result-title">{r.title || r.path}</span>
                  <span className="omnibar-result-path">{r.path}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
