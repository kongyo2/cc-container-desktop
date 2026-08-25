import type { ResetRequest } from '../shared/ipc.ts';
import type { ResetSummary } from '../shared/types.ts';
import { provisionContainer } from './claude/provision.ts';
import { getConfig, saveConfig } from './config/store.ts';
import {
  inspectContainer,
  removeContainer,
  startContainer,
  startExistingContainer,
  volumeExists,
} from './docker/container.ts';
import { inspectImage } from './docker/engine.ts';
import { exportWorkspace } from './docker/files.ts';
import { buildImage } from './docker/image.ts';
import { closeAllTerminals } from './docker/terminal.ts';
import { describeError, logInfo, logWarn } from './logger.ts';

interface Exported {
  readonly path: string;
  readonly files: number;
  readonly skipped: number;
}

async function exportFirst(destination: string | null): Promise<Exported> {
  if (destination === null || destination === '') {
    throw new Error(
      '取り出し先が決まっていないので中止しました。「ファイル」タブで一度取り出すか、先に取り出す設定を外してください / no export folder is set, so nothing was destroyed — export once from the Files tab, or turn off "export first"',
    );
  }

  const state = await inspectContainer();
  const volume = state.homeVolume ?? getConfig().volumeName;
  if (!state.exists && !(await volumeExists(volume))) {
    logWarn(
      'app',
      'コンテナもボリュームも無いので取り出しはありません / there is no container and no home volume to export from',
    );
    return { path: '', files: 0, skipped: 0 };
  }
  if (!state.running) {
    logInfo('app', '取り出しのためにコンテナを起動します / starting the container so the workspace can be exported');
    await startExistingContainer();
  }

  logInfo('app', 'リセット前にワークスペースを取り出します / exporting the workspace before the reset');
  const result = await exportWorkspace(destination);
  return { path: result.path, files: result.files, skipped: result.skipped.length };
}

export async function resetContainer(request: ResetRequest, destination: string | null): Promise<ResetSummary> {
  const config = getConfig();

  const exported = request.exportFirst ? await exportFirst(destination) : null;
  if (exported !== null && exported.path !== '' && destination !== null) {
    saveConfig({ ...getConfig(), lastExportDir: destination });
  }

  if (request.rebuildImage) {
    await buildImage(config.imageTag, true);
  }
  if (!(await inspectImage(config.imageTag)).exists) {
    throw new Error(
      `${config.imageTag} がまだビルドされていないので、何も消していません。「接続」タブでビルドしてください / ${config.imageTag} has not been built, so nothing was destroyed — build it on the Connect tab first`,
    );
  }

  closeAllTerminals();

  const before = await inspectContainer();
  logInfo(
    'app',
    `リセットします / resetting: container=${config.containerName} volume=${before.homeVolume ?? config.volumeName}`,
  );
  await removeContainer(true);

  await startContainer();

  let provisionError: string | null = null;
  try {
    await provisionContainer();
  } catch (error) {
    provisionError = describeError(error);
    logWarn('app', `設定の書き込みに失敗しました / provisioning failed after the reset: ${provisionError}`);
  }

  const state = await inspectContainer();
  logInfo('app', `新しいセッションを開始しました / fresh session ready: ${state.name}`);

  return {
    exportedTo: exported === null || exported.path === '' ? null : exported.path,
    exportedFiles: exported === null ? 0 : exported.files,
    exportSkipped: exported === null ? 0 : exported.skipped,
    rebuiltImage: request.rebuildImage,
    containerName: state.name,
    provisionError,
  };
}
