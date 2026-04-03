import { useRef, useEffect } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  extensions?: Extension[];
  readOnly?: boolean;
  height?: string;
  className?: string;
}

export default function CodeEditor({
  value,
  onChange,
  extensions = [],
  readOnly = true,
  height,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create editor once
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && onChangeRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const theme = EditorView.theme({
      '&': {
        fontSize: '13px',
        ...(height ? { height } : {}),
      },
      '.cm-scroller': {
        fontFamily: "'Monaco', 'Menlo', 'Consolas', monospace",
        ...(height ? { overflow: 'auto' } : {}),
      },
      '.cm-gutters': {
        background: '#f3f4f6',
        borderRight: '1px solid #e5e7eb',
        color: '#9ca3af',
      },
      '.cm-activeLineGutter': {
        background: '#e5e7eb',
      },
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of(defaultKeymap),
        theme,
        updateListener,
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        ...extensions,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, ...extensions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync value changes without recreating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className={className} />;
}
