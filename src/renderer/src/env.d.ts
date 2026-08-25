interface Window {
  readonly cc: import('../../shared/ipc.ts').Api;
}

declare module '*.css' {
  const content: string;
  export default content;
}
