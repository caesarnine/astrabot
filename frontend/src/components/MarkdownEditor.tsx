import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  HighlightStyle,
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'

/* ------------------------------------------------------------------ */
/*  Astra theme — warm palette matching the app design system          */
/* ------------------------------------------------------------------ */

const astraHighlighting = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.6em', color: '#1a1c19', fontFamily: 'Georgia, "Iowan Old Style", serif' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.35em', color: '#1a1c19', fontFamily: 'Georgia, "Iowan Old Style", serif' },
  { tag: tags.heading3, fontWeight: '600', fontSize: '1.15em', color: '#1a1c19', fontFamily: 'Georgia, "Iowan Old Style", serif' },
  { tag: tags.heading4, fontWeight: '600', fontSize: '1.05em', color: '#2a2d28' },
  { tag: tags.heading5, fontWeight: '600', color: '#2a2d28' },
  { tag: tags.heading6, fontWeight: '600', color: '#4a4d48' },
  { tag: tags.strong, fontWeight: '600', color: '#1a1c19' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#1a1c19' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#9a9d97' },
  { tag: tags.link, color: '#1b7a68', textDecoration: 'underline' },
  { tag: tags.url, color: '#1b7a68', opacity: '0.7' },
  { tag: tags.monospace, fontFamily: '"SF Mono", "Fira Code", Menlo, monospace', fontSize: '0.9em', color: '#6b4c8a' },
  { tag: tags.quote, color: '#6b6e68', fontStyle: 'italic' },
  { tag: tags.list, color: '#1b7a68' },
  { tag: tags.processingInstruction, color: '#9a9d97' },
  { tag: tags.meta, color: '#9a9d97' },
  { tag: tags.comment, color: '#9a9d97' },
  { tag: tags.keyword, color: '#1b7a68' },
  { tag: tags.string, color: '#6b4c8a' },
  { tag: tags.number, color: '#a07420' },
  { tag: tags.bool, color: '#a07420' },
  { tag: tags.null, color: '#9a9d97' },
  { tag: tags.punctuation, color: '#9a9d97' },
  { tag: tags.variableName, color: '#2a6b8a' },
  { tag: tags.typeName, color: '#1b7a68' },
  { tag: tags.className, color: '#1b7a68' },
  { tag: tags.function(tags.variableName), color: '#6b4c8a' },
  { tag: tags.propertyName, color: '#2a6b8a' },
  { tag: tags.operator, color: '#6b6e68' },
  { tag: tags.definition(tags.variableName), color: '#2a6b8a' },
])

const astraTheme = EditorView.theme({
  '&': {
    flex: '1',
    minHeight: '0',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    background: 'white',
  },
  '.cm-content': {
    padding: '20px 28px 80px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    fontSize: '14px',
    lineHeight: '1.75',
    caretColor: '#1b7a68',
    maxWidth: '800px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#1b7a68',
    borderLeftWidth: '2px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(27, 122, 104, 0.025)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(27, 122, 104, 0.12) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(27, 122, 104, 0.15) !important',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-placeholder': {
    color: '#9a9d97',
    fontStyle: 'italic',
  },
  '.cm-line': {
    padding: '0 2px',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(27, 122, 104, 0.15)',
    borderRadius: '2px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(160, 116, 32, 0.2)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(160, 116, 32, 0.4)',
  },
  '.cm-panels': {
    backgroundColor: '#faf9f7',
    borderBottom: '1px solid rgba(0,0,0,0.08)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid rgba(0,0,0,0.08)',
    borderBottom: 'none',
  },
  '.cm-panel.cm-search': {
    padding: '8px 12px',
  },
  '.cm-panel.cm-search input': {
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '4px',
    padding: '4px 8px',
    fontSize: '13px',
  },
  '.cm-panel.cm-search button': {
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '4px',
    padding: '4px 8px',
    fontSize: '12px',
    background: 'white',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search label': {
    fontSize: '12px',
  },
  '.cm-tooltip': {
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
    backgroundColor: 'white',
  },
})

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  editable?: boolean
  placeholder?: string
}

export function MarkdownEditor({ value, onChange, editable = true, placeholder = '' }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const externalUpdate = useRef(false)
  const readOnlyCompartment = useRef(new Compartment())

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Create the editor once on mount
  useEffect(() => {
    if (!containerRef.current) return

    const extensions = [
      astraTheme,
      syntaxHighlighting(astraHighlighting),
      highlightActiveLine(),
      highlightSpecialChars(),
      highlightSelectionMatches(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      history(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      readOnlyCompartment.current.of(EditorState.readOnly.of(!editable)),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !externalUpdate.current) {
          onChangeRef.current(update.state.doc.toString())
        }
      }),
      cmPlaceholder(placeholder || 'Start writing...'),
    ]

    const state = EditorState.create({ doc: value, extensions })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync external value changes (document switch, reload after save)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentDoc = view.state.doc.toString()
    if (currentDoc !== value) {
      externalUpdate.current = true
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      })
      externalUpdate.current = false
    }
  }, [value])

  // Sync editable / read-only state
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(!editable),
      ),
    })
  }, [editable])

  return <div ref={containerRef} className="cm-editor-wrap" />
}
