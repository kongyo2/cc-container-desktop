import { exportFolderName } from '../../shared/tasks.ts';
import type { ExportSummary, ImportSummary } from '../../shared/types.ts';
import { CHANNELS } from '../../shared/ipc.ts';
import type { RemoteRouter } from '../commands.ts';
import { extractWorkspaceArchive, packImportSource, resolveImportSource } from '../docker/files.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logInfo } from '../logger.ts';
import { importTaskArchive, streamTaskWorkspace } from '../tasks/service.ts';
import { controllerChannel, linkChannel } from './service.ts';

interface ExportMeta {
  readonly folderBase: string;
}

function folderBaseOf(meta: unknown): string {
  if (typeof meta === 'object' && meta !== null) {
    const named = (meta as Partial<ExportMeta>).folderBase;
    if (typeof named === 'string' && named !== '') return exportFolderName(named);
  }
  return 'task';
}

function destroy(stream: NodeJS.ReadableStream): void {
  (stream as { destroy?: () => void }).destroy?.();
}

export async function hostExportStream(taskId: string, transferId: string): Promise<null> {
  const channel = controllerChannel();
  await streamTaskWorkspace(taskId, async (archive, taskName) => {
    await channel.sendStream(transferId, { folderBase: taskName } satisfies ExportMeta, archive);
  });
  return null;
}

export async function hostImportStream(taskId: string, transferId: string): Promise<null> {
  const channel = controllerChannel();
  const incoming = channel.receiveStream(transferId);
  await importTaskArchive(taskId, incoming.stream);
  return null;
}

export async function pullWorkspace(router: RemoteRouter, taskId: string, destination: string): Promise<ExportSummary> {
  const channel = linkChannel();
  const transferId = channel.newTransferId();
  const incoming = channel.receiveStream(transferId);
  let finished = false;
  const call = router.call(CHANNELS.taskExportStream, [taskId, transferId], null).then(
    (value: unknown) => {
      finished = true;
      return value;
    },
    (error: unknown) => {
      finished = true;
      destroy(incoming.stream);
      throw error;
    },
  );

  try {
    const meta = await Promise.race([
      incoming.meta,
      call.then((): unknown => {
        throw new AppFailure(
          'REMOTE_ERROR',
          'リモートが何も送ってきませんでした / the remote instance finished without sending the workspace',
        );
      }),
    ]);
    const summary = await extractWorkspaceArchive(incoming.stream, destination, folderBaseOf(meta));
    await call;
    logInfo('app', `リモートから取り出しました / pulled the workspace from the remote instance to ${summary.path}`);
    return summary;
  } catch (error) {
    if (!finished) channel.abortStream(transferId, describeError(error));
    channel.cancelIncoming(transferId, describeError(error));
    await call.catch(() => undefined);
    throw error;
  }
}

export async function pushImports(
  router: RemoteRouter,
  taskId: string,
  paths: readonly string[],
): Promise<ImportSummary> {
  const sources: string[] = [];
  let entries = 0;

  /* oxlint-disable no-await-in-loop -- one archive at a time keeps the memory bounded */
  for (const raw of paths) {
    const source = resolveImportSource(raw);
    const packed = packImportSource(source);
    const channel = linkChannel();
    const transferId = channel.newTransferId();
    const sending = channel.sendStream(transferId, { name: source.name }, packed.archive);
    try {
      await router.call(CHANNELS.taskImportStream, [taskId, transferId], null);
    } catch (error) {
      channel.cancelOutgoing(transferId, describeError(error));
      destroy(packed.archive);
      await sending.catch(() => undefined);
      throw error;
    }
    await sending;
    entries += packed.entries();
    sources.push(source.origin);
    logInfo('app', `リモートに取り込みました / sent into the remote workspace: ${source.origin}`);
  }
  /* oxlint-enable no-await-in-loop */

  return { entries, sources };
}
