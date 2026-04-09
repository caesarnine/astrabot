import type { TreeNode } from '../types'

interface FileTreeProps {
  nodes: TreeNode[]
  selectedPath: string
  onSelect: (path: string) => void
}

interface FileTreeNodeProps {
  node: TreeNode
  selectedPath: string
  onSelect: (path: string) => void
}

function FileTreeNode({ node, selectedPath, onSelect }: FileTreeNodeProps) {
  if (node.kind === 'dir') {
    return (
      <details open>
        <summary>{node.name || 'Vault'}</summary>
        {node.children?.map((child) => (
          <FileTreeNode
            key={child.path || `${node.path}/${child.name}`}
            node={child}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </details>
    )
  }

  return (
    <button
      type="button"
      className={node.path === selectedPath ? 'active' : undefined}
      onClick={() => onSelect(node.path)}
    >
      {node.name}
    </button>
  )
}

export function FileTree({ nodes, selectedPath, onSelect }: FileTreeProps) {
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
          onSelect={onSelect}
        />
      ))}
    </>
  )
}
