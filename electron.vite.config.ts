import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { UserConfig } from 'electron-vite';
import { resolve } from 'node:path';

// `__dirname` rather than `import.meta.dirname`: Vite's config loader bundles
// this file before evaluating it and shims `__dirname` in both output formats,
// while `import.meta` survives only in the ESM one.
const root = __dirname;

// The annotation is required by `isolatedDeclarations`, which cannot infer the
// type of a default-exported call expression.
const config: UserConfig = defineConfig({
  main: {
    // dockerode and friends stay external. They are ordinary Node dependencies
    // that electron-builder ships in node_modules, and bundling them buys
    // nothing while breaking their own dynamic requires.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
});

export default config;
