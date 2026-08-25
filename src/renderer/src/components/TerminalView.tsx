import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

import type { TerminalKind } from '../../../shared/types.ts';
import { attachTerminal } from '../terminalBus.ts';

const THEME = {
  background: '#101013',
  foreground: '#ece9e4',
  cursor: '#d97757',
  selectionBackground: 'rgba(217, 119, 87, 0.32)',
  black: '#16161a',
  red: '#e0655f',
  green: '#5fb87a',
  yellow: '#d8b24c',
  blue: '#6f9ede',
  magenta: '#c08bd6',
  cyan: '#5fb5b8',
  white: '#d8d4ce',
  brightBlack: '#6d6a66',
  brightRed: '#f08b85',
  brightGreen: '#84d19b',
  brightYellow: '#e8ca72',
  brightBlue: '#93b7ea',
  brightMagenta: '#d2a8e2',
  brightCyan: '#84cccf',
  brightWhite: '#f5f2ed',
};

export interface TerminalViewProps {
  readonly kind: TerminalKind;
  readonly sessionName: string;
  readonly active: boolean;
  readonly onOpened: (id: string, sessionName: string) => void;
  readonly onExit: (exitCode: number | null) => void;
  readonly onError: (message: string) => void;
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<string | null>(null);

  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return undefined;

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 20000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void window.cc.openExternal(uri);
      }),
    );
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';

    term.open(mount);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}

    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let detach: (() => void) | null = null;
    let disposed = false;

    const pendingInput: string[] = [];

    void (async () => {
      const result = await window.cc.termOpen({
        kind: propsRef.current.kind,
        sessionName: propsRef.current.sessionName,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) return;
      if (!result.ok) {
        term.writeln(`\r\n[31m${result.error}[0m`);
        propsRef.current.onError(result.error);
        return;
      }
      idRef.current = result.value.id;
      propsRef.current.onOpened(result.value.id, result.value.sessionName);
      if (pendingInput.length > 0) {
        const buffered = pendingInput.join('');
        pendingInput.length = 0;
        void window.cc.termWrite(result.value.id, buffered);
      }
      detach = attachTerminal(
        result.value.id,
        (data) => term.write(data),
        (exit) => propsRef.current.onExit(exit.exitCode),
      );
    })();

    const inputDisposable = term.onData((data) => {
      const id = idRef.current;
      if (id === null) pendingInput.push(data);
      else void window.cc.termWrite(id, data);
    });

    const resize = (): void => {
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return;
      fit.fit();
      const id = idRef.current;
      if (id !== null) void window.cc.termResize(id, term.cols, term.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      disposed = true;
      observer.disconnect();
      inputDisposable.dispose();
      detach?.();
      const id = idRef.current;
      if (id !== null) void window.cc.termClose(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!props.active) return;
    const timer = window.setTimeout(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      const id = idRef.current;
      if (fit === null || term === null) return;
      fit.fit();
      if (id !== null) void window.cc.termResize(id, term.cols, term.rows);
      term.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [props.active]);

  return (
    <div className="term-body" style={{ display: props.active ? 'block' : 'none' }}>
      <div className="term-mount" ref={mountRef} />
    </div>
  );
}
