/**
 * VS Code interop.
 *
 * Two independent things live here:
 *
 *  - Attaching VS Code to the *running* container, which is what the Dev
 *    Containers extension's "Attach to Running Container" does. The URI it uses
 *    is `vscode-remote://attached-container+<hex>/<path>`, where `<hex>` is the
 *    hex-encoded JSON `{"containerName":"/<name>"}`.
 *  - Writing a `.devcontainer/` folder, for driving the same image from VS Code
 *    without this app in the loop.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTAINER_USER, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { VscodeAttachResult } from '../../shared/ipc.ts';
import { getConfig } from '../config/store.ts';
import { describeError, logInfo, logWarn } from '../logger.ts';
import { ensureImageSources } from '../docker/image.ts';
import { dockerfilePath, postCreatePath } from '../paths.ts';

export function attachedContainerUri(containerName: string, path: string): string {
  const payload = JSON.stringify({ containerName: `/${containerName}` });
  return `vscode-remote://attached-container+${Buffer.from(payload, 'utf8').toString('hex')}${path}`;
}

/**
 * Opens the container in VS Code.
 *
 * The URI is returned whether or not the spawn worked: on a machine where `code`
 * is not on PATH the user can still paste it into VS Code's "Open Folder from
 * URI", and a silent failure would leave them with nothing.
 */
export async function openInVscode(): Promise<VscodeAttachResult> {
  const config = getConfig();
  const uri = attachedContainerUri(config.containerName, CONTAINER_WORKSPACE);

  const launched = await new Promise<boolean>((resolve) => {
    try {
      // `shell: true` is what makes this work on Windows, where `code` is a .cmd
      // shim that CreateProcess cannot execute directly.
      const child = spawn('code', ['--folder-uri', uri], {
        shell: true,
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

  if (launched) logInfo('app', `VS Code を起動しました / launched VS Code: ${uri}`);
  else
    logWarn(
      'app',
      'VS Code の起動に失敗しました。URI をコピーして使ってください / could not launch VS Code; copy the URI instead',
    );

  return {
    launched,
    uri,
    hint: launched
      ? 'VS Code で Dev Containers 拡張が必要です / the Dev Containers extension is required in VS Code'
      : '`code` が PATH にありません。URI をコピーしてください / `code` is not on PATH; copy the URI',
  };
}

function devcontainerJson(): string {
  const config = getConfig();
  const definition = {
    name: 'cc-workbench',
    build: { dockerfile: 'Dockerfile' },
    remoteUser: CONTAINER_USER,
    // Replace the default host bind with the same named volume the app uses, so
    // both entry points see one workspace.
    workspaceMount: `source=${config.volumeName},target=/home/claude,type=volume`,
    workspaceFolder: CONTAINER_WORKSPACE,
    postCreateCommand: 'bash .devcontainer/post-create.sh',
    containerEnv: { TERM: 'xterm-256color' },
    customizations: {
      vscode: {
        extensions: ['anthropic.claude-code'],
        settings: { 'terminal.integrated.defaultProfile.linux': 'bash' },
      },
    },
  };
  return `${JSON.stringify(definition, null, 2)}\n`;
}

/** Writes `.devcontainer/{devcontainer.json,Dockerfile,post-create.sh}` under `hostDir`. */
export function writeDevcontainer(hostDir: string): string {
  ensureImageSources();
  const dir = join(hostDir, '.devcontainer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'devcontainer.json'), devcontainerJson(), 'utf8');
  try {
    copyFileSync(dockerfilePath(), join(dir, 'Dockerfile'));
    copyFileSync(postCreatePath(), join(dir, 'post-create.sh'));
  } catch (error) {
    logWarn('app', `イメージソースをコピーできませんでした / could not copy image sources: ${describeError(error)}`);
  }
  logInfo('app', `devcontainer.json を書き出しました / wrote devcontainer files to ${dir}`);
  return dir;
}
