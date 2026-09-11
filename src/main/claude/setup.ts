import { environmentEnvEntries, normalizeScriptText } from '../../shared/environments.ts';
import {
  CONTAINER_HOME,
  CONTAINER_SETUP_MARKER,
  CONTAINER_SETUP_SCRIPT,
  CONTAINER_USER,
  CONTAINER_WORKSPACE,
} from '../../shared/presets.ts';
import type { Task } from '../../shared/types.ts';
import { execCapture, execChecked, refOf } from '../docker/container.ts';
import { writeFileText } from '../docker/files.ts';
import { logInfo, logWarn, redactSecrets } from '../logger.ts';
import { taskEnvironment } from '../tasks/environment.ts';

const SETUP_TIMEOUT_SECONDS = 1800;

const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

const SENSITIVE_NAME = /key|token|secret|password|passwd|credential/iu;

function sensitiveValues(entries: readonly string[]): readonly string[] {
  return entries
    .map((entry) => {
      const separator = entry.indexOf('=');
      return { name: entry.slice(0, separator), value: entry.slice(separator + 1) };
    })
    .filter(({ name, value }) => SENSITIVE_NAME.test(name) && value.length >= 4)
    .map(({ value }) => value);
}

function maskValues(text: string, values: readonly string[]): string {
  return values.reduce((masked, value) => masked.split(value).join('***'), text);
}

export interface SetupOutcome {
  readonly ran: boolean;
  readonly exitCode: number | null;
}

export function setupFailureMessage(exitCode: number): string {
  const reason =
    exitCode === 124 || exitCode === 137
      ? `${SETUP_TIMEOUT_SECONDS} 秒で打ち切りました / timed out after ${SETUP_TIMEOUT_SECONDS}s`
      : `exit ${exitCode}`;
  return `セットアップスクリプトが失敗しました (${reason})。ログを確認してください。次の起動時にもう一度実行します / the setup script failed (${reason}); see the log. It runs again on the next start`;
}

async function setupDone(task: Task): Promise<boolean> {
  const result = await execCapture(refOf(task), ['test', '-e', CONTAINER_SETUP_MARKER], { workdir: '/' });
  return result.exitCode === 0;
}

async function markSetupDone(task: Task): Promise<void> {
  await execChecked(refOf(task), ['touch', CONTAINER_SETUP_MARKER], { workdir: '/', asRoot: true });
}

export async function runSetupIfPending(task: Task): Promise<SetupOutcome> {
  if (await setupDone(task)) return { ran: false, exitCode: null };

  const environment = taskEnvironment(task);
  const script = environment === null ? '' : normalizeScriptText(environment.setupScript).trim();
  if (script === '') {
    await markSetupDone(task);
    return { ran: false, exitCode: null };
  }

  const ref = refOf(task);
  const label = environment?.name ?? '';
  const secrets = sensitiveValues(environmentEnvEntries(environment));
  await writeFileText(ref, CONTAINER_SETUP_SCRIPT, `${script}\n`, 0o755);
  logInfo('setup', `[${task.name}] セットアップスクリプトを実行します / running the setup script of "${label}"`);

  const result = await execCapture(
    ref,
    ['timeout', '-k', '10', String(SETUP_TIMEOUT_SECONDS), 'bash', '-l', CONTAINER_SETUP_SCRIPT],
    {
      workdir: CONTAINER_WORKSPACE,
      env: [`HOME=${CONTAINER_HOME}`, `USER=${CONTAINER_USER}`],
      onLine: (line, stream) => {
        const text = redactSecrets(maskValues(line.replaceAll(ANSI, ''), secrets)).trimEnd();
        if (text === '') return;
        if (stream === 'stderr' && /^(fatal|error)\b/iu.test(text)) logWarn('setup', text);
        else logInfo('setup', text);
      },
    },
  );

  if (result.exitCode === 0) {
    await markSetupDone(task);
    logInfo('setup', `[${task.name}] セットアップスクリプトが完了しました / setup script finished`);
  } else {
    logWarn('setup', `[${task.name}] ${setupFailureMessage(result.exitCode)}`);
  }
  return { ran: true, exitCode: result.exitCode };
}
