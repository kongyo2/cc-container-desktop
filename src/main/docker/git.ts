import { cloneRefProblem, cloneUrlProblem, repoNameFromUrl } from '../../shared/git.ts';
import { CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import { logInfo, logWarn } from '../logger.ts';
import { execCapture } from './container.ts';
import type { ContainerRef } from './container.ts';

async function workspaceIsEmpty(ref: ContainerRef): Promise<boolean> {
  const result = await execCapture(ref, ['bash', '-c', 'ls -A -- "$1" | head -n 1', 'ls', CONTAINER_WORKSPACE], {
    workdir: '/',
  });
  return result.exitCode === 0 && result.stdout.trim() === '';
}

/** Clones a public repository into the workspace: into its root when empty, otherwise into a folder named after the repository. */
export async function cloneIntoWorkspace(ref: ContainerRef, url: string, gitRef: string): Promise<string> {
  const cleanUrl = url.trim();
  const cleanRef = gitRef.trim();
  const problem = cloneUrlProblem(cleanUrl) ?? cloneRefProblem(cleanRef);
  if (problem !== null) throw new Error(problem);

  const target = (await workspaceIsEmpty(ref))
    ? CONTAINER_WORKSPACE
    : `${CONTAINER_WORKSPACE}/${repoNameFromUrl(cleanUrl)}`;
  logInfo('app', `clone します / cloning ${cleanUrl}${cleanRef === '' ? '' : ` @ ${cleanRef}`} → ${target}`);

  const argv = [
    'git',
    '-c',
    'credential.helper=',
    'clone',
    '--progress',
    ...(cleanRef === '' ? [] : ['--branch', cleanRef]),
    '--',
    cleanUrl,
    target,
  ];
  const result = await execCapture(ref, argv, {
    workdir: '/',
    env: ['GIT_TERMINAL_PROMPT=0', 'GIT_ASKPASS=/bin/false', 'GCM_INTERACTIVE=never'],
    onLine: (line, stream) => {
      if (stream === 'stderr' && /^(fatal|error):/iu.test(line)) logWarn('app', `git: ${line}`);
      else logInfo('app', `git: ${line}`);
    },
  });
  if (result.exitCode !== 0) {
    const tail = `${result.stderr}${result.stdout}`.trim().split('\n').slice(-3).join(' ');
    throw new Error(
      `clone に失敗しました / git clone failed (exit ${result.exitCode})${tail === '' ? '' : `: ${tail}`}`,
    );
  }
  return target;
}
