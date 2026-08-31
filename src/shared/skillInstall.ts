import type { SkillInstallConfig } from './types.ts';

export const SKILL_CLI = 'skills@latest';

export const SKILL_AGENT = 'claude-code';

export function skillNames(entry: SkillInstallConfig): readonly string[] {
  return entry.skills.map((name) => name.trim()).filter((name) => name !== '');
}

export function skillInstallProblem(entry: SkillInstallConfig): string | null {
  const source = entry.source.trim();
  if (source === '') return 'ソースが空です / the source is empty';
  if (/\s/u.test(source)) return `${source}: ソースに空白は使えません / a source cannot contain whitespace`;
  if (source.startsWith('-')) {
    return `${source}: ソースが - で始まっています / a source starting with "-" would be read as an option`;
  }
  for (const name of skillNames(entry)) {
    if (name.startsWith('-')) {
      return `${name}: スキル名が - で始まっています / a skill name starting with "-" would be read as an option`;
    }
  }
  return null;
}

export function skillInstallArgv(entry: SkillInstallConfig): readonly string[] {
  return [
    'npx',
    '-y',
    SKILL_CLI,
    'add',
    entry.source.trim(),
    ...skillNames(entry).flatMap((name) => ['-s', name]),
    '-g',
    '-a',
    SKILL_AGENT,
    '-y',
  ];
}

export function formatArgv(argv: readonly string[]): string {
  return argv.map((word) => (/[\s"']/u.test(word) ? JSON.stringify(word) : word)).join(' ');
}

export function skillInstallCommand(entry: SkillInstallConfig): string {
  return formatArgv(skillInstallArgv(entry));
}
