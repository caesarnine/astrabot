import { useEffect, useRef, useState, useCallback } from 'react'
import type { FileActivityRecord, TreeNode } from '../types'

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface FileTreeProps {
  nodes: TreeNode[]
  selectedPath: string
  recentActivity: Record<string, FileActivityRecord>
  watchedFolders: Record<string, string[]>
  onSelect: (path: string) => void
  onNewNote?: (parentPath: string) => void
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTreeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function activityIndicatorClass(activity: FileActivityRecord | undefined) {
  if (!activity) return ''
  return activity.kind === 'attention' ? 'tree-indicator-attention' : 'tree-indicator-artifact'
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'md':
    case 'mdx':
      return (
        <svg className="tree-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
          <path d="M5 5h6M5 8h6M5 11h3" />
        </svg>
      )
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return (
        <svg className="tree-file-icon tree-file-icon-config" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M4 4l4 4-4 4M8 12h4" />
        </svg>
      )
    case 'py':
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'sh':
    case 'sql':
    case 'css':
    case 'html':
      return (
        <svg className="tree-file-icon tree-file-icon-code" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M5.5 4L2.5 8l3 4M10.5 4l3 4-3 4" />
        </svg>
      )
    default:
      return (
        <svg className="tree-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
        </svg>
      )
  }
}

function countFiles(node: TreeNode): number {
  if (node.kind === 'file') return 1
  return (node.children ?? []).reduce((sum, child) => sum + countFiles(child), 0)
}

/* ------------------------------------------------------------------ */
/*  Folder node                                                        */
/* ------------------------------------------------------------------ */

interface FolderNodeProps {
  node: TreeNode
  depth: number
  selectedPath: string
  recentActivity: Record<string, FileActivityRecord>
  watchedFolders: Record<string, string[]>
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onNewNote?: (parentPath: string) => void
}

function FolderNode({
  node,
  depth,
  selectedPath,
  recentActivity,
  watchedFolders,
  expandedPaths,
  onToggle,
  onSelect,
  onNewNote,
}: FolderNodeProps) {
  const isOpen = expandedPaths.has(node.path)
  const watcherNames = watchedFolders[node.path] ?? []
  const fileCount = countFiles(node)
  const [hovered, setHovered] = useState(false)

  return (
    <div className="tree-folder" role="treeitem" aria-expanded={isOpen}>
      {/* Indent guides */}
      {depth > 0 && (
        <div className="tree-indent-guides" style={{ width: depth * 16 }}>
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="tree-indent-guide" style={{ left: i * 16 + 8 }} />
          ))}
        </div>
      )}
      <button
        type="button"
        className={`tree-folder-btn ${isOpen ? 'tree-folder-open' : ''} ${watcherNames.length > 0 ? 'tree-folder-watched' : ''}`.trim()}
        style={{ paddingLeft: depth * 16 + 6 }}
        onClick={() => onToggle(node.path)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <svg className={`tree-chevron ${isOpen ? 'tree-chevron-open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M3 2l4 3-4 3z" />
        </svg>
        <svg className="tree-folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {isOpen ? (
            <path d="M1.5 4.5V12a1.5 1.5 0 001.5 1.5h10l1.5-6H5.5L4 4.5H1.5z" />
          ) : (
            <path d="M1.5 3.5V12a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V5.5a1.5 1.5 0 00-1.5-1.5H8L6.5 2.5H3A1.5 1.5 0 001.5 3.5z" />
          )}
        </svg>
        <span className="tree-folder-label">{node.name || 'Vault'}</span>
        <span className="tree-folder-end">
          {watcherNames.length > 0 ? (
            <span className="tree-scope-badge" title={watcherNames.join(', ')}>
              <span className="tree-scope-dot" />
              {watcherNames.length === 1 ? watcherNames[0] : `${watcherNames.length} agents`}
            </span>
          ) : null}
          {hovered && onNewNote ? (
            <button
              type="button"
              className="tree-action-btn"
              title="New note here"
              onClick={(e) => { e.stopPropagation(); onNewNote(node.path) }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M6 2v8M2 6h8" />
              </svg>
            </button>
          ) : !watcherNames.length ? (
            <span className="tree-file-count">{fileCount}</span>
          ) : null}
        </span>
      </button>
      {isOpen && node.children ? (
        <div className="tree-folder-children" role="group">
          {node.children.map((child) =>
            child.kind === 'dir' ? (
              <FolderNode
                key={child.path || `${node.path}/${child.name}`}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                recentActivity={recentActivity}
                watchedFolders={watchedFolders}
                expandedPaths={expandedPaths}
                onToggle={onToggle}
                onSelect={onSelect}
                onNewNote={onNewNote}
              />
            ) : (
              <FileNode
                key={child.path || `${node.path}/${child.name}`}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                activity={recentActivity[child.path]}
                onSelect={onSelect}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  File node                                                          */
/* ------------------------------------------------------------------ */

interface FileNodeProps {
  node: TreeNode
  depth: number
  selectedPath: string
  activity?: FileActivityRecord
  onSelect: (path: string) => void
}

function FileNode({ node, depth, selectedPath, activity, onSelect }: FileNodeProps) {
  const isActive = node.path === selectedPath
  const ref = useRef<HTMLButtonElement>(null)

  // Scroll active file into view
  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])

  return (
    <button
      ref={ref}
      type="button"
      className={`tree-file ${isActive ? 'tree-file-active' : ''}`.trim()}
      style={{ paddingLeft: depth * 16 + 6 }}
      onClick={() => onSelect(node.path)}
    >
      {/* Indent guides */}
      {depth > 0 && (
        <div className="tree-indent-guides" style={{ width: depth * 16 }}>
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="tree-indent-guide" style={{ left: i * 16 + 8 }} />
          ))}
        </div>
      )}
      {fileIcon(node.name)}
      <span className="tree-file-name">{node.name}</span>
      <span className="tree-file-meta">
        {activity ? (
          <>
            <span className="tree-file-time">{formatTreeTime(activity.createdAt)}</span>
            <span className={`tree-indicator ${activityIndicatorClass(activity)}`.trim()} />
          </>
        ) : null}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Root component                                                     */
/* ------------------------------------------------------------------ */

export function FileTree({ nodes, selectedPath, recentActivity, watchedFolders, onSelect, onNewNote }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Start with all folders expanded
    const paths = new Set<string>()
    function walk(list: TreeNode[]) {
      for (const node of list) {
        if (node.kind === 'dir') {
          paths.add(node.path)
          if (node.children) walk(node.children)
        }
      }
    }
    walk(nodes)
    return paths
  })

  // Ensure the selected file's parent folders are expanded
  useEffect(() => {
    if (!selectedPath) return
    const parts = selectedPath.split('/')
    const parents: string[] = []
    for (let i = 1; i < parts.length; i++) {
      parents.push(parts.slice(0, i).join('/'))
    }
    setExpandedPaths((prev) => {
      let next = prev
      for (const p of parents) {
        if (!next.has(p)) {
          if (next === prev) next = new Set(prev)
          next.add(p)
        }
      }
      return next
    })
  }, [selectedPath])

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    setExpandedPaths(new Set())
  }, [])

  if (!nodes.length) {
    return (
      <div className="tree-empty-state">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.4">
          <rect x="5" y="4" width="22" height="24" rx="3" />
          <path d="M11 11h10M11 16h10M11 21h6" />
        </svg>
        <p>Your vault is empty.</p>
        <p className="tree-empty-hint">Create a note to get started.</p>
      </div>
    )
  }

  return (
    <div className="tree-root" role="tree">
      <div className="tree-toolbar">
        <button type="button" className="tree-collapse-btn" title="Collapse all" onClick={collapseAll}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M4 6l3-3 3 3M4 11l3-3 3 3" />
          </svg>
        </button>
      </div>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <FolderNode
            key={node.path || node.name}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            recentActivity={recentActivity}
            watchedFolders={watchedFolders}
            expandedPaths={expandedPaths}
            onToggle={handleToggle}
            onSelect={onSelect}
            onNewNote={onNewNote}
          />
        ) : (
          <FileNode
            key={node.path || node.name}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            activity={recentActivity[node.path]}
            onSelect={onSelect}
          />
        ),
      )}
    </div>
  )
}
