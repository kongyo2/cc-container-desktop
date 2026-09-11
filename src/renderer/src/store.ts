import type { StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';

import type { LogLine, Result, Snapshot, TaskView, TerminalKind } from '../../shared/types.ts';

export type View = 'tasks' | 'newTask' | 'profiles' | 'extensions' | 'environments' | 'log' | 'settings';

export interface TerminalTab {
  readonly key: string;
  readonly taskId: string;
  readonly kind: TerminalKind;
  readonly id: string | null;
  readonly exited: boolean;
}

export interface LogEntry extends LogLine {
  readonly seq: number;
}

let logSeq = 0;
let tabSeq = 0;

const LOG_LIMIT = 800;

export interface UiState {
  snapshot: Snapshot | null;
  view: View;
  selectedTaskId: string | null;
  busy: string | null;
  error: string | null;
  toast: string | null;
  logs: LogEntry[];
  tabs: TerminalTab[];
  activeTab: Record<string, string>;

  setView: (view: View) => void;
  selectTask: (id: string) => void;
  setError: (error: string | null) => void;
  setToast: (toast: string | null) => void;
  appendLog: (line: LogLine) => void;
  clearLogs: () => void;
  openTab: (taskId: string, kind: TerminalKind) => void;
  closeTab: (key: string) => void;
  activateTab: (taskId: string, key: string) => void;
  markTabOpened: (key: string, id: string) => void;
  markTabExited: (key: string) => void;
  dropTaskTabs: (taskId: string) => void;
  refresh: () => Promise<void>;
  run: <T>(label: string, call: () => Promise<Result<T>>) => Promise<T | null>;
}

export function tabsOfTask(tabs: readonly TerminalTab[], taskId: string | null): TerminalTab[] {
  return tabs.filter((tab) => tab.taskId === taskId);
}

function nextActive(
  tabs: readonly TerminalTab[],
  active: Record<string, string>,
  taskId: string,
): Record<string, string> {
  const remaining = tabsOfTask(tabs, taskId);
  const current = active[taskId];
  if (current !== undefined && remaining.some((tab) => tab.key === current)) return active;
  const next = { ...active };
  const last = remaining[remaining.length - 1];
  if (last === undefined) delete next[taskId];
  else next[taskId] = last.key;
  return next;
}

function reconcileSelection(snapshot: Snapshot, selectedTaskId: string | null): string | null {
  if (selectedTaskId !== null && snapshot.tasks.some((view) => view.task.id === selectedTaskId)) return selectedTaskId;
  return snapshot.tasks[0]?.task.id ?? null;
}

export const useApp: UseBoundStore<StoreApi<UiState>> = create<UiState>()((set, get) => ({
  snapshot: null,
  view: 'tasks',
  selectedTaskId: null,
  busy: null,
  error: null,
  toast: null,
  logs: [],
  tabs: [],
  activeTab: {},

  setView: (view) => set({ view }),
  selectTask: (id) => set({ selectedTaskId: id, view: 'tasks' }),
  setError: (error) => set({ error }),
  setToast: (toast) => set({ toast }),

  appendLog: (line) =>
    set((state) => {
      logSeq += 1;
      const logs = [...state.logs, { ...line, seq: logSeq }];
      return { logs: logs.length > LOG_LIMIT ? logs.slice(logs.length - LOG_LIMIT) : logs };
    }),

  clearLogs: () => set({ logs: [] }),

  openTab: (taskId, kind) =>
    set((state) => {
      tabSeq += 1;
      const key = `t${tabSeq}`;
      return {
        tabs: [...state.tabs, { key, taskId, kind, id: null, exited: false }],
        activeTab: { ...state.activeTab, [taskId]: key },
        selectedTaskId: taskId,
        view: 'tasks',
      };
    }),

  closeTab: (key) =>
    set((state) => {
      const closing = state.tabs.find((tab) => tab.key === key);
      if (closing === undefined) return {};
      const tabs = state.tabs.filter((tab) => tab.key !== key);
      return { tabs, activeTab: nextActive(tabs, state.activeTab, closing.taskId) };
    }),

  activateTab: (taskId, key) => set((state) => ({ activeTab: { ...state.activeTab, [taskId]: key } })),

  markTabOpened: (key, id) =>
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, id } : tab)) })),

  markTabExited: (key) =>
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, exited: true } : tab)) })),

  dropTaskTabs: (taskId) =>
    set((state) => {
      const activeTab = { ...state.activeTab };
      delete activeTab[taskId];
      return { tabs: state.tabs.filter((tab) => tab.taskId !== taskId), activeTab };
    }),

  refresh: async () => {
    const result = await window.cc.snapshot();
    if (result.ok) {
      set((state) => ({
        snapshot: result.value,
        selectedTaskId: reconcileSelection(result.value, state.selectedTaskId),
      }));
    } else {
      set({ error: result.error });
    }
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

export function selectedTaskView(state: UiState): TaskView | null {
  if (state.snapshot === null || state.selectedTaskId === null) return null;
  return state.snapshot.tasks.find((view) => view.task.id === state.selectedTaskId) ?? null;
}
