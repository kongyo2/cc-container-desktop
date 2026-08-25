import { parse as parseYaml } from 'yaml';

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license: string;
  readonly compatibility: string;
  readonly allowedTools: string;
}

export interface SkillValidation {
  readonly name: string;
  readonly description: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

const CLAUDE_CODE_FIELDS = new Set([
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
]);

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;

export function splitFrontmatter(body: string): { frontmatter: string | null; content: string } {
  const normalized = body.replace(/^﻿/u, '');
  if (!normalized.startsWith('---')) return { frontmatter: null, content: normalized };

  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(normalized);
  if (match === null) return { frontmatter: null, content: normalized };
  return { frontmatter: match[1] ?? '', content: normalized.slice(match[0].length) };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function charLength(value: string): number {
  return [...value].length;
}

export function nameProblem(name: string): string | null {
  if (name === '') return 'name が空です / name is empty';
  if (charLength(name) > MAX_NAME) {
    return `name は ${MAX_NAME} 文字までです / name is longer than ${MAX_NAME} characters`;
  }
  if (name !== name.toLowerCase()) return 'name は小文字のみです / name must be lowercase';
  if (!NAME_PATTERN.test(name)) {
    return 'name は英小文字・数字・ハイフンのみ。先頭/末尾のハイフンと連続ハイフンは不可 / lowercase letters, digits and single hyphens only, not at either end';
  }
  return null;
}

export function normalizeSkillPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('\\')) return null;
  if (trimmed.includes('\0')) return null;

  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;

  const normalized = parts.join('/');
  if (normalized.toUpperCase() === 'SKILL.MD') return null;
  return normalized;
}

export function isSafeSkillPath(path: string): boolean {
  return normalizeSkillPath(path) !== null;
}

export function validateSkill(body: string, files: readonly SkillFile[] = []): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { frontmatter, content } = splitFrontmatter(body);
  if (frontmatter === null) {
    return {
      name: '',
      description: '',
      errors: ['--- で囲んだ YAML frontmatter が必要です / a SKILL.md needs YAML frontmatter fenced by ---'],
      warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (error) {
    return {
      name: '',
      description: '',
      errors: [`frontmatter の YAML が壊れています / invalid YAML: ${error instanceof Error ? error.message : ''}`],
      warnings,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      name: '',
      description: '',
      errors: ['frontmatter はキーと値の対応でなければなりません / frontmatter must be a mapping'],
      warnings,
    };
  }

  const fields = parsed as Record<string, unknown>;
  const rawName = fields['name'];
  const name = asString(rawName);
  const description = asString(fields['description']);

  const problem =
    rawName !== undefined && typeof rawName !== 'string'
      ? 'name は文字列にしてください（引用符で囲む）/ name must be a string — quote it'
      : nameProblem(name);
  if (problem !== null) errors.push(problem);

  if (description === '') {
    errors.push('description は必須です / description is required');
  } else if (charLength(description) > MAX_DESCRIPTION) {
    errors.push(
      `description は ${MAX_DESCRIPTION} 文字までです / description is longer than ${MAX_DESCRIPTION} characters`,
    );
  } else if (charLength(description) < 20) {
    warnings.push(
      'description が短すぎます。何をするか、いつ使うかを書いてください / too short to match a task against; say what it does and when to use it',
    );
  }

  const compatibility = asString(fields['compatibility']);
  if (charLength(compatibility) > MAX_COMPATIBILITY) {
    errors.push(`compatibility は ${MAX_COMPATIBILITY} 文字までです / compatibility is too long`);
  }

  const metadata = fields['metadata'];
  if (metadata !== undefined) {
    const isStringMap =
      typeof metadata === 'object' &&
      metadata !== null &&
      !Array.isArray(metadata) &&
      Object.values(metadata as Record<string, unknown>).every((value) => typeof value === 'string');
    if (!isStringMap) {
      warnings.push('metadata は文字列だけの対応表にしてください / metadata should map string keys to string values');
    }
  }

  if (content.trim() === '') {
    warnings.push('本文が空です / the body is empty, so the skill has no instructions');
  }

  const beyondSpec = Object.keys(fields).filter((key) => !SPEC_FIELDS.has(key));
  const claudeCodeOnly = beyondSpec.filter((key) => CLAUDE_CODE_FIELDS.has(key));
  const unknown = beyondSpec.filter((key) => !CLAUDE_CODE_FIELDS.has(key));

  if (claudeCodeOnly.length > 0) {
    warnings.push(
      `${claudeCodeOnly.join(', ')}: Claude Code 専用のフィールドです。claude.ai へのアップロードや Skills API ではエラーになります / Claude Code-only fields; a claude.ai upload or the Skills API rejects these`,
    );
  }
  if (unknown.length > 0) {
    warnings.push(`${unknown.join(', ')}: 認識できないフィールドです / unrecognized frontmatter field`);
  }

  const seen = new Set<string>();
  for (const file of files) {
    const normalized = normalizeSkillPath(file.path);
    if (normalized === null) {
      errors.push(`${file.path}: スキル内の相対パスにしてください / must be a relative path inside the skill`);
      continue;
    }
    if (seen.has(normalized)) {
      errors.push(`${normalized}: 同じパスのファイルが 2 つあります / two bundled files share this path`);
      continue;
    }
    seen.add(normalized);
  }

  return {
    name: problem === null ? name : '',
    description,
    errors,
    warnings,
  };
}

export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: Say what this skill does and when Claude should reach for it, with the words someone would actually use.
---

# ${name}

Write the instructions here. Keep this file under 500 lines and move long
reference material into references/ beside it.
`;
}
