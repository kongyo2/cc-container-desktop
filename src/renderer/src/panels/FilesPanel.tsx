/**
 * In-container file browser and editor.
 *
 * This is the "poke at the internals like Dev Containers" surface: the same
 * files Claude Code reads, editable in place, without leaving the app.
 */

import {
  ArrowUp,
  File as FileIcon,
  FolderOpen,
  FolderPlus,
  Link as LinkIcon,
  RefreshCw,
  Save,
  Upload,
} from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { CONTAINER_HOME, CONTAINER_WORKSPACE } from '../../../shared/presets.ts';
import type { FileEntry } from '../../../shared/types.ts';
import { CodeEditor } from '../components/CodeEditor.tsx';
import type { EditorLanguage } from '../components/CodeEditor.tsx';
import { formatBytes } from '../components/ui.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

const QUICK_LINKS: ReadonlyArray<{ label: string; path: string; isFile: boolean }> = [
  { label: 'settings.json', path: `${CONTAINER_HOME}/.claude/settings.json`, isFile: true },
  { label: '.claude.json', path: `${CONTAINER_HOME}/.claude.json`, isFile: true },
  { label: 'CLAUDE.md', path: `${CONTAINER_WORKSPACE}/CLAUDE.md`, isFile: true },
  { label: 'workspace', path: CONTAINER_WORKSPACE, isFile: false },
  { label: '.claude', path: `${CONTAINER_HOME}/.claude`, isFile: false },
  { label: '~', path: CONTAINER_HOME, isFile: false },
];

function editorLanguage(path: string): EditorLanguage {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.sh') || path.endsWith('.bash') || path.endsWith('.cjs') || path.endsWith('.js')) return 'shell';
  return 'plain';
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '/';
  return trimmed.slice(0, index);
}

export function FilesPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const running = useApp((state) => state.snapshot?.container.running === true);
  const setError = useApp((state) => state.setError);
  const setToast = useApp((state) => state.setToast);
  const run = useApp((state) => state.run);

  const [dir, setDir] = useState(CONTAINER_WORKSPACE);
  const [pathInput, setPathInput] = useState(CONTAINER_WORKSPACE);
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Navigation is a state change; the effect below is what actually lists the directory. */
  const navigate = (path: string): void => {
    setDir(path);
    setPathInput(path);
  };

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.cc.fsList(dir);
    if (result.ok) setEntries(result.value);
    else setError(result.error);
  }, [dir, setError]);

  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await window.cc.fsList(dir);
      if (cancelled) return;
      if (result.ok) setEntries(result.value);
      else setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [running, dir, setError]);

  const openFile = useCallback(
    async (path: string) => {
      const result = await window.cc.fsRead(path);
      setSelected(path);
      setDirty(false);
      if (result.ok) {
        setContent(result.value);
        setLoadError(null);
        return;
      }
      setContent('');
      setLoadError(
        result.error === 'FILE_BINARY'
          ? t('filesBinary')
          : result.error === 'FILE_TOO_LARGE'
            ? pick(language, 'ファイルが大きすぎます (2 MB 超)。', 'File is larger than 2 MB.')
            : result.error,
      );
    },
    [language, t],
  );

  const save = async (): Promise<void> => {
    if (selected === null) return;
    const result = await window.cc.fsWrite({ path: selected, content });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDirty(false);
    setToast(`${t('filesSaved')}: ${selected}`);
  };

  if (!running) {
    return (
      <div className="content">
        <p className="empty">{t('terminalNeedsContainer')}</p>
      </div>
    );
  }

  return (
    <div className="files">
      <div className="browser">
        <div className="quick-links">
          {QUICK_LINKS.map((link) => (
            <button
              key={link.path}
              className="btn ghost sm"
              onClick={() => {
                if (link.isFile) void openFile(link.path);
                else navigate(link.path);
              }}
              type="button"
            >
              {link.label}
            </button>
          ))}
        </div>

        <div className="path">
          <button className="btn ghost sm" onClick={() => navigate(parentOf(dir))} type="button" title={t('filesUp')}>
            <ArrowUp size={14} />
          </button>
          <input
            value={pathInput}
            spellCheck={false}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate(pathInput);
            }}
          />
          <button className="btn ghost sm" onClick={() => navigate(pathInput)} type="button" title={t('filesRefresh')}>
            <RefreshCw size={14} />
          </button>
          <button
            className="btn ghost sm"
            title={t('filesNewDir')}
            onClick={() => {
              const name = window.prompt(t('filesPathPrompt'));
              if (name === null || name.trim() === '') return;
              void (async () => {
                const result = await window.cc.fsMkdir(`${dir}/${name.trim()}`);
                if (!result.ok) setError(result.error);
                await reload();
              })();
            }}
            type="button"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        <div className="list">
          {entries.length === 0 ? <p className="empty">{t('filesEmptyDir')}</p> : null}
          {entries.map((entry) => (
            <div
              key={entry.path}
              className={`entry ${entry.path === selected ? 'selected' : ''}`}
              onClick={() => {
                if (entry.kind === 'dir') navigate(entry.path);
                else void openFile(entry.path);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                if (entry.kind === 'dir') navigate(entry.path);
                else void openFile(entry.path);
              }}
            >
              {entry.kind === 'dir' ? (
                <FolderOpen size={14} />
              ) : entry.kind === 'link' ? (
                <LinkIcon size={14} />
              ) : (
                <FileIcon size={14} />
              )}
              <span className="name">{entry.name}</span>
              <span className="size">{entry.kind === 'dir' ? '' : formatBytes(entry.size)}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
          <button
            className="btn sm"
            onClick={() => {
              void (async () => {
                const target = await run('export', () => window.cc.workspaceExport());
                if (target !== null && target !== '') setToast(`${t('filesExportDone')}: ${target}`);
              })();
            }}
            type="button"
          >
            <Upload size={13} /> {t('filesExport')}
          </button>
        </div>
      </div>

      <div className="editor">
        <div className="bar">
          <span className="fname">{selected ?? t('commonNone')}</span>
          {dirty ? <span className="tag">●</span> : null}
          <button
            className="btn sm"
            disabled={selected === null || loadError !== null}
            onClick={() => void save()}
            type="button"
          >
            <Save size={13} /> {t('filesSave')}
          </button>
          <button
            className="btn ghost sm"
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) void openFile(selected);
            }}
            type="button"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="mount">
          {loadError !== null ? (
            <p className="empty">{loadError}</p>
          ) : selected === null ? (
            <p className="empty">
              {pick(language, '左のファイルを選ぶと編集できます。', 'Pick a file on the left to edit it.')}
            </p>
          ) : (
            <CodeEditor
              value={content}
              language={editorLanguage(selected)}
              onChange={(next) => {
                setContent(next);
                setDirty(true);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
