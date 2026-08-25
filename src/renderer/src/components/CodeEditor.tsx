/** CodeMirror 6 wrapper used for `settings.json`, the Dockerfile and the post-create script. */

import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { Extension } from '@codemirror/state';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

export type EditorLanguage = 'json' | 'shell' | 'plain';

function languageExtensions(language: EditorLanguage): Extension[] {
  switch (language) {
    case 'json':
      return [json()];
    case 'shell':
      // No dedicated shell grammar is bundled; JS highlighting is close enough
      // for comments, strings and brackets without pulling in another package.
      return [javascript()];
    case 'plain':
      return [];
  }
}

export interface CodeEditorProps {
  readonly value: string;
  readonly language: EditorLanguage;
  readonly readOnly?: boolean;
  readonly onChange: (value: string) => void;
  readonly className?: string;
}

export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Latest-callback ref, refreshed after each render rather than during it, so
  // the editor is built once instead of on every keystroke.
  const onChangeRef = useRef(props.onChange);
  useEffect(() => {
    onChangeRef.current = props.onChange;
  });

  const { language, readOnly = false } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          oneDark,
          EditorView.lineWrapping,
          ...languageExtensions(language),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial document is intentionally not a dependency: re-creating the
    // view on every keystroke would reset the cursor. External replacements go
    // through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return <div className={props.className ?? 'cm-host'} ref={hostRef} />;
}
