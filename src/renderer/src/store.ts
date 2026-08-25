/** Renderer state: one snapshot of the world, plus the plumbing that refreshes it. */

import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';

import type { LogLine, Result, Snapshot, TerminalKind } from '../../shared/types.ts';

export type TabId = 'connect' | 'terminal' | 'files' | 'profiles' | 'image' | 'settings';

/** A terminal the Connect tab asked for, waiting for the Terminal tab to pick it up. */
export interface PendingTerminal {
  readonly kind: TerminalKind;
  /** Monotonic, so asking twice for the same kind still registers as two requests. */
  readonly nonce: number;
}

/** A log line with a stable identity, so React keys survive the ring buffer trimming. */
export interface LogEntry extends LogLine {
  readonly seq: number;
}

let logSeq = 0;

const LOG_LIMIT = 800;

export interface UiState {
  snapshot: Snapshot | null;
  tab: TabId;
  /** Label of the operation in flight, or `null`. Drives the global busy bar. */
  busy: string | null;
  error: string | null;
  toast: string | null;
  logs: LogEntry[];
  pendingTerminal: PendingTerminal | null;

  setTab: (tab: TabId) => void;
  setError: (error: string | null) => void;
  setToast: (toast: string | null) => void;
  appendLog: (line: LogLine) => void;
  clearLogs: () => void;
  /** Switches to the Terminal tab and asks it to open a session of `kind`. */
  requestTerminal: (kind: TerminalKind) => void;
  clearPendingTerminal: () => void;
  refresh: () => Promise<void>;
  /**
   * Runs an IPC call with the busy indicator up, surfacing failures as `error`.
   * Returns `null` when the call failed, so callers can bail without try/catch.
   */
  run: <T>(label: string, call: () => Promise<Result<T>>) => Promise<T | null>;
}

export const useApp: UseBoundStore<StoreApi<UiState>> = create<UiState>()((set, get) => ({
  snapshot: null,
  tab: 'connect',
  busy: null,
  error: null,
  toast: null,
  logs: [],
  pendingTerminal: null,

  setTab: (tab) => set({ tab }),
  setError: (error) => set({ error }),
  setToast: (toast) => set({ toast }),

  requestTerminal: (kind) =>
    set((state) => ({
      tab: 'terminal',
      pendingTerminal: { kind, nonce: (state.pendingTerminal?.nonce ?? 0) + 1 },
    })),
  clearPendingTerminal: () => set({ pendingTerminal: null }),

  appendLog: (line) =>
    set((state) => {
      logSeq += 1;
      const logs = [...state.logs, { ...line, seq: logSeq }];
      return { logs: logs.length > LOG_LIMIT ? logs.slice(logs.length - LOG_LIMIT) : logs };
    }),

  clearLogs: () => set({ logs: [] }),

  refresh: async () => {
    const result = await window.cc.snapshot();
    if (result.ok) set({ snapshot: result.value });
    else set({ error: result.error });
  },

  run: async (label, call) => {
    set({ busy: label, error: null });
    try {
      const result = await call();
      if (!result.ok) {
        set({ error: result.error });
        return null;
      }
      return result.value;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      set({ busy: null });
      await get().refresh();
    }
  },
}));
