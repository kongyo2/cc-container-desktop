/**
 * Ambient declarations for the renderer.
 *
 * No top-level `import`/`export` here on purpose: that keeps this a global
 * script file, which is the only place `interface Window` merges with the DOM
 * lib and `declare module '*.css'` counts as an ambient module rather than an
 * augmentation of a module that does not exist.
 */

interface Window {
  /** Injected by the preload script's `contextBridge.exposeInMainWorld('cc', …)`. */
  readonly cc: import('../../shared/ipc.ts').Api;
}

declare module '*.css' {
  const content: string;
  export default content;
}
