import { environmentEnvEntries, normalizeScriptText } from '../../shared/environments.ts';
import {
  CONTAINER_GID,
  CONTAINER_HOME,
  CONTAINER_SETUP_MARKER,
  CONTAINER_SETUP_SCRIPT,
  CONTAINER_UID,
  CONTAINER_USER,
  CONTAINER_WORKSPACE,
} from '../../shared/presets.ts';
import type { Task } from '../../shared/types.ts';
import { execCapture, execChecked, refOf } from '../docker/container.ts';
import type { ContainerRef } from '../docker/container.ts';
import { ROOT_OWNER, writeFileText } from '../docker/files.ts';
import { environmentFor } from '../config/store.ts';
import { logInfo, logWarn, redactSecrets } from '../logger.ts';

const SETUP_TIMEOUT_SECONDS = 1800;

const SETUP_ENV: readonly string[] = [
  `HOME=${CONTAINER_HOME}`,
  'USER=root',
  'LOGNAME=root',
  'DEBIAN_FRONTEND=noninteractive',
];

const HOME_OWNER = `${CONTAINER_UID}:${CONTAINER_GID}`;

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

async function reclaimHome(ref: ContainerRef): Promise<void> {
  const result = await execCapture(
    ref,
    [
      'find',
      CONTAINER_HOME,
      '-xdev',
      '(',
      '!',
      '-user',
      String(CONTAINER_UID),
      '-o',
      '!',
      '-group',
      String(CONTAINER_GID),
      ')',
      '-exec',
      'chown',
      '-h',
      HOME_OWNER,
      '{}',
      '+',
    ],
    { workdir: '/', asRoot: true },
  );
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() === '' ? `exit ${result.exitCode}` : result.stderr.trim();
  logWarn(
    'setup',
    `セットアップスクリプトが作ったファイルを ${CONTAINER_USER} の持ち物に戻せませんでした / could not hand the files the setup script created back to ${CONTAINER_USER}: ${detail}`,
  );
}

export async function runSetupIfPending(task: Task): Promise<SetupOutcome> {
  if (await setupDone(task)) return { ran: false, exitCode: null };

  const environment = environmentFor(task.environmentId);
  const script = environment === null ? '' : normalizeScriptText(environment.setupScript).trim();
  if (script === '') {
    await markSetupDone(task);
    return { ran: false, exitCode: null };
  }

  const ref = refOf(task);
  const label = environment?.name ?? '';
  const secrets = sensitiveValues(environmentEnvEntries(environment));
  await writeFileText(ref, CONTAINER_SETUP_SCRIPT, `${script}\n`, 0o700, ROOT_OWNER);
  logInfo(
    'setup',
    `[${task.name}] セットアップスクリプトを root で実行します / running the setup script of "${label}" as root`,
  );

  const result = await execCapture(
    ref,
    ['timeout', '-k', '10', String(SETUP_TIMEOUT_SECONDS), 'bash', '-l', CONTAINER_SETUP_SCRIPT],
    {
      asRoot: true,
      workdir: CONTAINER_WORKSPACE,
      env: SETUP_ENV,
      onLine: (line, stream) => {
        const text = redactSecrets(maskValues(line.replaceAll(ANSI, ''), secrets)).trimEnd();
        if (text === '') return;
        if (stream === 'stderr' && /^(fatal|error)\b/iu.test(text)) logWarn('setup', text);
        else logInfo('setup', text);
      },
    },
  );

  await reclaimHome(ref);

  if (result.exitCode === 0) {
    await markSetupDone(task);
    logInfo('setup', `[${task.name}] セットアップスクリプトが完了しました / setup script finished`);
  } else {
    logWarn('setup', `[${task.name}] ${setupFailureMessage(result.exitCode)}`);
  }
  return { ran: true, exitCode: result.exitCode };
}
