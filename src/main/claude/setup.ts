import { normalizeScriptText } from '../../shared/environments.ts';
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

/** Generous, because a setup script may compile or `apt-get install` things. */
const SETUP_TIMEOUT_SECONDS = 1800;

const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

export interface SetupOutcome {
  /** False when the container had already run its setup script (the marker exists). */
  readonly ran: boolean;
  /** The script's exit code when it ran, null when there was nothing to run. */
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

/**
 * Runs the environment's setup script once per container: after the
 * workspace is in place (clone included) and before Claude Code is opened.
 * A container that already carries the done-marker is left alone, so a
 * plain stop/start does not rerun it while a recreate does. The marker is
 * only written on success, so a failed script gets another chance on the
 * next start.
 */
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
  await writeFileText(ref, CONTAINER_SETUP_SCRIPT, `${script}\n`, 0o755);
  logInfo('setup', `[${task.name}] セットアップスクリプトを実行します / running the setup script of "${label}"`);

  const result = await execCapture(
    ref,
    ['timeout', '-k', '10', String(SETUP_TIMEOUT_SECONDS), 'bash', '-l', CONTAINER_SETUP_SCRIPT],
    {
      workdir: CONTAINER_WORKSPACE,
      env: [`HOME=${CONTAINER_HOME}`, `USER=${CONTAINER_USER}`],
      onLine: (line, stream) => {
        const text = redactSecrets(line.replaceAll(ANSI, '')).trimEnd();
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
