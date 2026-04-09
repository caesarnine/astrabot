import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownPreviewProps {
  value: string
}

export function MarkdownPreview({ value }: MarkdownPreviewProps) {
  if (!value.trim()) {
    return <p className="preview-empty">Nothing to preview.</p>
  }

  return (
    <div className="markdown-preview-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  )
}
