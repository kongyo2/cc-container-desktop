import { CONTAINER_HOME } from '../../shared/presets.ts';
import { formatArgv, skillInstallArgv, skillInstallProblem } from '../../shared/skillInstall.ts';
import type { SkillInstallConfig } from '../../shared/types.ts';
import { execCapture } from '../docker/container.ts';
import { logInfo, logWarn } from '../logger.ts';

const LOG_TAIL_LINES = 24;

const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/gu;

const TOKEN_PARAM = /([?&](?:token|access_token|api_key|apikey|key|password)=)[^&\s]+/giu;

function redact(text: string): string {
  return text.replaceAll(USERINFO, '$1***@').replaceAll(TOKEN_PARAM, '$1***');
}

function logOutput(text: string, level: 'info' | 'warn'): void {
  const lines = redact(text)
    .replaceAll(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  for (const line of lines.slice(-LOG_TAIL_LINES)) {
    if (level === 'warn') logWarn('provision', line);
    else logInfo('provision', line);
  }
}

export interface SkillInstallResult {
  readonly installed: number;
  readonly failed: number;
  readonly warnings: readonly string[];
}

export async function installSkills(entries: readonly SkillInstallConfig[]): Promise<SkillInstallResult> {
  const warnings: string[] = [];
  const wanted: SkillInstallConfig[] = [];

  for (const entry of entries) {
    if (!entry.enabled) continue;
    const problem = skillInstallProblem(entry);
    if (problem === null) wanted.push(entry);
    else warnings.push(`skill: ${problem}`);
  }

  let installed = 0;
  let failed = 0;

  /* oxlint-disable no-await-in-loop -- one npm install at a time; they share a cache. */
  for (const entry of wanted) {
    const argv = skillInstallArgv(entry);
    logInfo('provision', redact(formatArgv(argv)));

    const result = await execCapture(argv, { workdir: CONTAINER_HOME, env: [`HOME=${CONTAINER_HOME}`] });
    logOutput(`${result.stdout}\n${result.stderr}`, result.exitCode === 0 ? 'info' : 'warn');

    if (result.exitCode === 0) {
      installed += 1;
      continue;
    }
    failed += 1;
    warnings.push(
      `skill ${redact(entry.source.trim())}: 導入に失敗しました / install failed (exit ${result.exitCode})`,
    );
  }
  /* oxlint-enable no-await-in-loop */

  return { installed, failed, warnings };
}
