import type { FileActivityRecord, TreeNode } from '../types'

interface FileTreeProps {
  nodes: TreeNode[]
  selectedPath: string
  recentActivity: Record<string, FileActivityRecord>
  watchedFolders: Record<string, string[]>
  onSelect: (path: string) => void
}

interface FileTreeNodeProps extends FileTreeProps {
  node: TreeNode
}

function formatTreeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) {
    return 'now'
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m`
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h`
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function activityClass(activity: FileActivityRecord | undefined) {
  if (!activity) {
    return ''
  }
  if (activity.kind === 'attention') {
    return 'tree-indicator-attention'
  }
  return 'tree-indicator-artifact'
}

function FileTreeNode({ node, selectedPath, recentActivity, watchedFolders, onSelect }: FileTreeNodeProps) {
  const activity = recentActivity[node.path]
  const watcherNames = watchedFolders[node.path] ?? []

  if (node.kind === 'dir') {
    return (
      <details open className="tree-folder">
        <summary>
          <span className="tree-folder-label">{node.name || 'Vault'}</span>
          {watcherNames.length > 0 ? (
            <span className="tree-scope-pill" title={watcherNames.join(', ')}>
              {watcherNames.length}
            </span>
          ) : null}
        </summary>
        {node.children?.map((child) => (
          <FileTreeNode
            key={child.path || `${node.path}/${child.name}`}
            node={child}
            selectedPath={selectedPath}
            recentActivity={recentActivity}
            watchedFolders={watchedFolders}
            onSelect={onSelect}
            nodes={[]}
          />
        ))}
      </details>
    )
  }

  return (
    <button
      type="button"
      className={`tree-file ${node.path === selectedPath ? 'active' : ''}`.trim()}
      onClick={() => onSelect(node.path)}
    >
      <span className="tree-file-name">{node.name}</span>
      <span className="tree-file-meta">
        {activity ? <span className={`tree-indicator ${activityClass(activity)}`.trim()} /> : null}
        {activity ? <span className="tree-file-time">{formatTreeTime(activity.createdAt)}</span> : null}
      </span>
    </button>
  )
}

export function FileTree({ nodes, selectedPath, recentActivity, watchedFolders, onSelect }: FileTreeProps) {
  if (!nodes.length) {
    return <div className="empty-state tree-empty">Vault is empty.</div>
  }

  return (
    <>
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path || node.name}
          node={node}
          selectedPath={selectedPath}
          recentActivity={recentActivity}
          watchedFolders={watchedFolders}
          onSelect={onSelect}
          nodes={nodes}
        />
      ))}
    </>
  )
}
