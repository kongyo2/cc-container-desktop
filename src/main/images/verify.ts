import VERIFY_SCRIPT from '../../../docker/scripts/verify-runtime.sh?raw';
import {
  IMAGE_INFO_PROJECT,
  IMAGE_PROJECT_LABEL_VALUE,
  normalizeRepository,
  RUNTIME_CONTRACT,
} from '../../shared/images.ts';
import type { CatalogTool, ImagePlatform, ImageVariant } from '../../shared/images.ts';
import {
  CONTAINER_IMAGE_INFO,
  CONTAINER_SCRIPT_DIR,
  CONTAINER_USER,
  CONTAINER_WORKSPACE,
  IMAGE_CONTRACT_LABEL,
  IMAGE_PROJECT_LABEL,
  IMAGE_RELEASE_LABEL,
  IMAGE_VARIANT_LABEL,
  INSTANCE_LABEL,
  MANAGED_LABEL,
  OCI_REVISION_LABEL,
  OPERATION_LABEL,
  ROLE_LABEL,
  verifyContainerName,
} from '../../shared/presets.ts';
import { dataInstanceId } from '../config/store.ts';
import { execCapture } from '../docker/container.ts';
import type { ContainerRef } from '../docker/container.ts';
import { docker, listContainersByLabels } from '../docker/engine.ts';
import type { ImageInspect } from '../docker/engine.ts';
import { AppFailure, classifyDockerError, describeError, isNotFound } from '../errors.ts';
import { logInfo, logWarn } from '../logger.ts';
import { parseImageInfo, parseVerifyOutput } from './verifyReport.ts';
import type { ImageInfo } from './verifyReport.ts';

export interface ExpectedImage {
  readonly repository: string;
  readonly pinnedDigest: string | null;
  readonly platform: ImagePlatform;
  readonly variant: ImageVariant;
  readonly release: string;
}

function mismatch(message: string): AppFailure {
  return new AppFailure(
    'RUNTIME_CONTRACT_MISMATCH',
    `イメージが実行契約を満たさないので登録しません / the image does not meet the runtime contract and was not registered: ${message}`,
  );
}

const ARCH_OF_PLATFORM: Readonly<Record<ImagePlatform, readonly string[]>> = {
  'linux/amd64': ['amd64', 'x86_64'],
  'linux/arm64': ['arm64', 'aarch64'],
};

export function repoDigestOf(inspect: ImageInspect, repository: string): string | null {
  const wanted = normalizeRepository(repository);
  for (const entry of inspect.repoDigests) {
    const at = entry.indexOf('@');
    if (at === -1) continue;
    if (normalizeRepository(entry.slice(0, at)) === wanted) return entry.slice(at + 1);
  }
  return null;
}

/** Checks the inspect of a pulled image against what the catalog promised, before any container is started. */
export function checkImageMetadata(inspect: ImageInspect, expected: ExpectedImage): void {
  if ((inspect.os ?? '').toLowerCase() !== 'linux') {
    throw new AppFailure(
      'UNSUPPORTED_PLATFORM',
      `イメージの OS が ${inspect.os ?? '?'} です / the image OS is ${inspect.os ?? '?'}`,
    );
  }
  const architecture = (inspect.architecture ?? '').toLowerCase();
  if (!ARCH_OF_PLATFORM[expected.platform].includes(architecture)) {
    throw new AppFailure(
      'UNSUPPORTED_PLATFORM',
      `イメージの CPU が ${architecture} で、この Docker (${expected.platform}) と一致しません / the image is built for ${architecture}, not ${expected.platform}`,
    );
  }
  if (expected.pinnedDigest !== null) {
    const found = inspect.repoDigests.some((entry) => entry.endsWith(`@${expected.pinnedDigest}`));
    if (!found) {
      throw new AppFailure(
        'DIGEST_MISMATCH',
        `取得したイメージが固定ダイジェスト ${expected.pinnedDigest} として解決できません / the pulled image does not resolve to the pinned digest ${expected.pinnedDigest}`,
      );
    }
  }
  const labels = inspect.labels;
  if (labels[IMAGE_PROJECT_LABEL] !== IMAGE_PROJECT_LABEL_VALUE) {
    throw mismatch(`label ${IMAGE_PROJECT_LABEL} is ${labels[IMAGE_PROJECT_LABEL] ?? '(missing)'}`);
  }
  if (labels[IMAGE_VARIANT_LABEL] !== expected.variant) {
    throw mismatch(
      `label ${IMAGE_VARIANT_LABEL} is ${labels[IMAGE_VARIANT_LABEL] ?? '(missing)'}, expected ${expected.variant}`,
    );
  }
  if (labels[IMAGE_RELEASE_LABEL] !== expected.release) {
    throw mismatch(
      `label ${IMAGE_RELEASE_LABEL} is ${labels[IMAGE_RELEASE_LABEL] ?? '(missing)'}, expected ${expected.release}`,
    );
  }
  if (labels[IMAGE_CONTRACT_LABEL] !== String(RUNTIME_CONTRACT)) {
    throw mismatch(
      `label ${IMAGE_CONTRACT_LABEL} is ${labels[IMAGE_CONTRACT_LABEL] ?? '(missing)'}, expected ${RUNTIME_CONTRACT}`,
    );
  }
  const user = inspect.user ?? '';
  if (!['claude', '1000', '1000:1000', 'claude:claude'].includes(user)) {
    throw mismatch(`the image runs as '${user}', not claude`);
  }
  if (inspect.workingDir !== CONTAINER_WORKSPACE) {
    throw mismatch(`the working directory is '${inspect.workingDir ?? ''}', not ${CONTAINER_WORKSPACE}`);
  }
}

export function sourceRevisionOf(inspect: ImageInspect): string | null {
  const value = inspect.labels[OCI_REVISION_LABEL];
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/u.test(value) ? value : null;
}

export interface ContractResult {
  readonly checksPassed: number;
  readonly imageInfo: ImageInfo;
}

const VERIFY_TIMEOUT_MS = 90_000;

function verifyLabels(operationId: string): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [ROLE_LABEL]: 'verify',
    [INSTANCE_LABEL]: dataInstanceId(),
    [OPERATION_LABEL]: operationId,
  };
}

async function removeQuietly(name: string): Promise<void> {
  try {
    await docker().getContainer(name).remove({ force: true, v: true });
  } catch (error) {
    if (!isNotFound(error)) {
      logWarn(
        'image',
        `検証用コンテナを片付けられませんでした / could not remove the verification container ${name}: ${describeError(error)}`,
      );
    }
  }
}

/**
 * Runs the runtime contract inside a throwaway container created from the
 * verified local image id: no network, no volumes, no secrets, the same
 * user and init settings a task gets. The container is always removed.
 */
export async function runContractChecks(
  localImageId: string,
  expected: ExpectedImage,
  operationId: string,
  signal: AbortSignal,
): Promise<ContractResult> {
  const name = verifyContainerName(operationId);
  await removeQuietly(name);
  const ref: ContainerRef = { taskId: `verify:${operationId}`, containerName: name, volumeName: '' };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const onAbort = (): void => {
    void removeQuietly(name);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      await docker().createContainer({
        name,
        Image: localImageId,
        Hostname: 'cc-verify',
        User: CONTAINER_USER,
        WorkingDir: CONTAINER_WORKSPACE,
        Tty: false,
        OpenStdin: false,
        Env: ['TERM=xterm-256color', 'LANG=C.UTF-8', 'DISABLE_AUTOUPDATER=1'],
        Labels: verifyLabels(operationId),
        Cmd: ['sleep', 'infinity'],
        HostConfig: { NetworkMode: 'none', Init: true, AutoRemove: false },
      });
      await docker().getContainer(name).start();
    } catch (error) {
      throw classifyDockerError(error, 'create');
    }
    if (signal.aborted) throw new AppFailure('CANCELLED', '検証を中止しました / verification cancelled');

    timer = setTimeout(() => {
      timedOut = true;
      void removeQuietly(name);
    }, VERIFY_TIMEOUT_MS);

    const contract = await execCapture(ref, ['bash', '-s'], {
      workdir: CONTAINER_WORKSPACE,
      stdin: VERIFY_SCRIPT,
      env: [
        `CC_EXPECT_VARIANT=${expected.variant}`,
        `CC_EXPECT_RELEASE=${expected.release}`,
        `CC_EXPECT_CONTRACT=${RUNTIME_CONTRACT}`,
        `HOME=/home/${CONTAINER_USER}`,
        'DISABLE_AUTOUPDATER=1',
        'LANG=C.UTF-8',
      ],
    });
    if (timedOut) {
      throw new AppFailure(
        'RUNTIME_CONTRACT_MISMATCH',
        `検証が ${VERIFY_TIMEOUT_MS / 1000} 秒で終わりませんでした / verification did not finish within ${VERIFY_TIMEOUT_MS / 1000}s`,
        { retryable: true },
      );
    }
    if (signal.aborted) throw new AppFailure('CANCELLED', '検証を中止しました / verification cancelled');

    const report = parseVerifyOutput(contract.stdout);
    if (!report.complete || contract.exitCode !== 0 || report.failed.length > 0) {
      const detail =
        report.failed.length > 0
          ? report.failed.join('; ')
          : `exit ${contract.exitCode}: ${(contract.stderr || contract.stdout).trim().slice(-400)}`;
      throw mismatch(detail);
    }

    const optCc = await execCapture(
      ref,
      ['bash', '-c', `test -d "$1" && touch "$1/.cc-verify" && rm -f "$1/.cc-verify"`, 'check', CONTAINER_SCRIPT_DIR],
      { workdir: '/', asRoot: true },
    );
    if (optCc.exitCode !== 0) throw mismatch(`${CONTAINER_SCRIPT_DIR} is not a directory root can write to`);

    const infoText = await execCapture(ref, ['cat', CONTAINER_IMAGE_INFO], { workdir: '/' });
    const imageInfo = infoText.exitCode === 0 ? parseImageInfo(infoText.stdout) : null;
    if (imageInfo === null) throw mismatch(`${CONTAINER_IMAGE_INFO} is missing or not JSON`);
    if (imageInfo.project !== IMAGE_INFO_PROJECT) throw mismatch(`image-info project is '${imageInfo.project}'`);
    if (imageInfo.variant !== expected.variant || imageInfo.release !== expected.release) {
      throw mismatch(
        `image-info says ${imageInfo.variant}@${imageInfo.release}, expected ${expected.variant}@${expected.release}`,
      );
    }
    if (imageInfo.runtimeContract !== RUNTIME_CONTRACT) {
      throw mismatch(`image-info runtime contract is ${imageInfo.runtimeContract}`);
    }

    logInfo('image', `実行契約を確認しました / runtime contract verified: ${report.passed.length} checks passed`);
    return { checksPassed: report.passed.length + 1, imageInfo };
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    if (signal.aborted) throw new AppFailure('CANCELLED', '検証を中止しました / verification cancelled');
    throw classifyDockerError(error, 'exec');
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await removeQuietly(name);
  }
}

/** Merges the versions the image reports into the catalog's tool list, so the ledger shows what really shipped. */
export function toolsWithMeasuredVersions(tools: readonly CatalogTool[], info: ImageInfo): readonly CatalogTool[] {
  return tools.map((tool) => {
    const measured = info.tools[tool.id];
    return typeof measured === 'string' && measured !== '' ? { ...tool, version: measured } : tool;
  });
}

/** Removes verification containers this data instance left behind (a crash mid-verify). */
export async function cleanupVerifyContainers(): Promise<number> {
  const leftovers = await listContainersByLabels([
    `${MANAGED_LABEL}=true`,
    `${ROLE_LABEL}=verify`,
    `${INSTANCE_LABEL}=${dataInstanceId()}`,
  ]);
  /* oxlint-disable no-await-in-loop -- removals share one daemon connection; keep them sequential */
  for (const container of leftovers) {
    await removeQuietly(container.id);
  }
  /* oxlint-enable no-await-in-loop */
  if (leftovers.length > 0) {
    logInfo(
      'image',
      `残っていた検証用コンテナを片付けました / removed ${leftovers.length} leftover verification container(s)`,
    );
  }
  return leftovers.length;
}
