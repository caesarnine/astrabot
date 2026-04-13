import type { AgentRecord, DocumentRecord } from '../types'

interface DocHeaderProps {
  document: DocumentRecord
  saveState: 'clean' | 'dirty' | 'saving' | 'error'
  watchingAgents: AgentRecord[]
  onSave: () => void
  onPathSegmentClick: (path: string) => void
}

export function DocHeader({
  document: doc,
  saveState,
  watchingAgents,
  onSave,
  onPathSegmentClick,
}: DocHeaderProps) {
  const segments = doc.path.split('/').filter(Boolean)

  return (
    <div className="doc-header">
      <div className="doc-header-text">
        {/* Breadcrumb path */}
        <div className="doc-breadcrumb">
          {segments.map((segment, i) => {
            const path = segments.slice(0, i + 1).join('/')
            const isLast = i === segments.length - 1
            return (
              <span key={path} className="breadcrumb-item">
                {i > 0 ? <span className="breadcrumb-sep">/</span> : null}
                {isLast ? (
                  <span className="breadcrumb-current">{segment}</span>
                ) : (
                  <button type="button" className="breadcrumb-link" onClick={() => onPathSegmentClick(path)}>
                    {segment}
                  </button>
                )}
              </span>
            )
          })}
        </div>

        <h1 className="doc-title">{doc.title || doc.path}</h1>

        {/* Watching agents inline */}
        {watchingAgents.length > 0 ? (
          <p className="doc-watching">
            Watched by {watchingAgents.map((a) => a.name).join(', ')}
          </p>
        ) : null}
      </div>

      <div className="doc-actions">
        <span className={`status-save-dot ${saveState}`} title={saveState} />
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!doc.editable}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  )
}
