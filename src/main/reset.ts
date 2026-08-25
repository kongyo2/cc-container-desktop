import type { ResetRequest } from '../shared/ipc.ts';
import type { ResetSummary } from '../shared/types.ts';
import { provisionContainer } from './claude/provision.ts';
import { getConfig, saveConfig } from './config/store.ts';
import { inspectContainer, removeContainer, startContainer } from './docker/container.ts';
import { exportWorkspace } from './docker/files.ts';
import { buildImage } from './docker/image.ts';
import { closeAllTerminals } from './docker/terminal.ts';
import { describeError, logInfo, logWarn } from './logger.ts';

async function exportFirst(destination: string | null): Promise<string | null> {
  if (destination === null || destination === '') {
    logWarn(
      'app',
      '取り出し先が未設定なのでエクスポートを飛ばします / no export directory configured, skipping the pre-reset export',
    );
    return null;
  }

  const state = await inspectContainer();
  if (!state.running) {
    logWarn('app', 'コンテナが動いていないのでエクスポートを飛ばします / container not running, nothing to export');
    return null;
  }

  logInfo('app', `リセット前にワークスペースを取り出します / exporting the workspace before the reset`);
  return exportWorkspace(destination);
}

export async function resetContainer(request: ResetRequest, destination: string | null): Promise<ResetSummary> {
  const config = getConfig();

  const exportedTo = request.exportFirst ? await exportFirst(destination) : null;
  if (exportedTo !== null && destination !== null) {
    saveConfig({ ...getConfig(), lastExportDir: destination });
  }

  closeAllTerminals();

  logInfo('app', `リセットします / resetting: container=${config.containerName} volume=${config.volumeName}`);
  await removeContainer(true);

  if (request.rebuildImage) {
    await buildImage(config.imageTag, false);
  }

  await startContainer();

  try {
    await provisionContainer();
  } catch (error) {
    logWarn('app', `設定の書き込みに失敗しました / provisioning failed after the reset: ${describeError(error)}`);
  }

  const state = await inspectContainer();
  logInfo('app', `新しいセッションを開始しました / fresh session ready: ${state.name}`);

  return { exportedTo, rebuiltImage: request.rebuildImage, containerName: state.name };
}
