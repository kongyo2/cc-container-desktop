import type { Language } from './types.ts';

export interface BaseImageTool {
  readonly category: Readonly<Record<Language, string>>;
  readonly included: Readonly<Record<Language, string>>;
}

/**
 * What the fixed base image carries. Mirrors docker/Dockerfile; keep the two
 * in step when a runtime is added or dropped.
 */
export const BASE_IMAGE_TOOLS: readonly BaseImageTool[] = [
  {
    category: { ja: 'Python', en: 'Python' },
    included: {
      ja: 'Python 3.x、pip、poetry、uv、black、mypy、pytest、ruff',
      en: 'Python 3.x with pip, poetry, uv, black, mypy, pytest, ruff',
    },
  },
  {
    category: { ja: 'Node.js', en: 'Node.js' },
    included: {
      ja: '20、21、22 (npm、yarn、pnpm、bun、eslint、prettier、chromedriver)',
      en: '20, 21, and 22, with npm, yarn, pnpm, bun, eslint, prettier, chromedriver',
    },
  },
  {
    category: { ja: 'Ruby', en: 'Ruby' },
    included: { ja: '3.1、3.2、3.3 (gem、bundler、rbenv)', en: '3.1, 3.2, 3.3 with gem, bundler, rbenv' },
  },
  {
    category: { ja: 'PHP', en: 'PHP' },
    included: { ja: '8.3 と Composer', en: '8.3 with Composer' },
  },
  {
    category: { ja: 'Java', en: 'Java' },
    included: { ja: 'OpenJDK 21、Maven、Gradle', en: 'OpenJDK 21 with Maven and Gradle' },
  },
  {
    category: { ja: 'Go', en: 'Go' },
    included: { ja: 'Go (モジュール対応)', en: 'Go with module support' },
  },
  {
    category: { ja: 'Rust', en: 'Rust' },
    included: { ja: 'rustc と cargo', en: 'rustc and cargo' },
  },
  {
    category: { ja: 'C/C++', en: 'C/C++' },
    included: { ja: 'GCC、Clang、cmake、ninja、conan', en: 'GCC, Clang, cmake, ninja, conan' },
  },
  {
    category: { ja: 'Docker', en: 'Docker' },
    included: { ja: 'docker、dockerd、docker compose', en: 'docker, dockerd, docker compose' },
  },
  {
    category: { ja: 'データベース', en: 'Databases' },
    included: { ja: 'PostgreSQL 16、Redis 7.0', en: 'PostgreSQL 16, Redis 7.0' },
  },
  {
    category: { ja: 'ユーティリティ', en: 'Utilities' },
    included: {
      ja: 'git、gh、jq、yq、ripgrep、tmux、vim、nano',
      en: 'git, gh, jq, yq, ripgrep, tmux, vim, nano',
    },
  },
];

export const NODE_PREFIXES: readonly string[] = ['/opt/node20', '/opt/node21', '/opt/node22'];

export const DEFAULT_NODE_PREFIX = '/opt/node22';
