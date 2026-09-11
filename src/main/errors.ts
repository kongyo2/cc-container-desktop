import type { AppError } from '../shared/images.ts';

export type AppErrorCode =
  | 'APP_ERROR'
  | 'INVALID_INPUT'
  | 'STORE_UNREADABLE'
  | 'STORE_UNWRITABLE'
  | 'DOCKER_UNAVAILABLE'
  | 'DOCKER_ERROR'
  | 'LINUX_CONTAINERS_REQUIRED'
  | 'UNSUPPORTED_PLATFORM'
  | 'CATALOG_INVALID'
  | 'IMAGE_NOT_FOUND'
  | 'REGISTRY_AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'PULL_STALLED'
  | 'NO_SPACE'
  | 'DIGEST_MISMATCH'
  | 'RUNTIME_CONTRACT_MISMATCH'
  | 'REGISTRATION_WRITE_FAILED'
  | 'IMAGE_IN_USE'
  | 'IMAGE_NOT_REGISTERED'
  | 'IMAGE_UNAVAILABLE'
  | 'OPERATION_NOT_FOUND'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'ENVIRONMENT_MISSING'
  | 'ENVIRONMENT_ARCHIVED'
  | 'TASK_NOT_RUNNING'
  | 'FOREIGN_RESOURCE';

export class AppFailure extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppFailure';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppFailure) {
    return { code: error.code, message: describeError(error), retryable: error.retryable };
  }
  return { code: 'APP_ERROR', message: describeError(error), retryable: false };
}

export function isFailure(error: unknown, code: AppErrorCode): boolean {
  return error instanceof AppFailure && error.code === code;
}

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}

function errnoOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isNotFound(error: unknown): boolean {
  return statusCodeOf(error) === 404;
}

const CONNECTION_ERRNOS: readonly string[] = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPIPE', 'ECONNRESET', 'ENOTFOUND'];

export function isDaemonUnreachable(error: unknown): boolean {
  const errno = errnoOf(error);
  if (errno !== null && CONNECTION_ENOS_HAS(errno)) return true;
  const message = describeError(error);
  return /docker_engine|docker\.sock|connect ENOENT|connect ECONNREFUSED|EHOSTUNREACH|socket hang up/iu.test(message);
}

function CONNECTION_ENOS_HAS(errno: string): boolean {
  return CONNECTION_ERRNOS.includes(errno);
}

export type DockerContext = 'connect' | 'pull' | 'inspect' | 'create' | 'exec';

export function classifyDockerError(error: unknown, context: DockerContext): AppFailure {
  if (error instanceof AppFailure) return error;
  const message = describeError(error);
  const status = statusCodeOf(error);

  if (isDaemonUnreachable(error)) {
    return new AppFailure(
      'DOCKER_UNAVAILABLE',
      `Docker に接続できません。Docker Desktop を起動してください / Docker is unreachable; start Docker Desktop (${message})`,
      { retryable: true, cause: error },
    );
  }

  if (status === 429 || /toomanyrequests|too many requests|rate limit|pull rate/iu.test(message)) {
    return new AppFailure(
      'RATE_LIMITED',
      `Docker Hub の取得制限に達しました。しばらく待つか、docker login した状態で同じダイジェストを pull してから再試行してください / Docker Hub's pull limit was hit; wait, or docker login and pull the same digest yourself, then retry (${message})`,
      { retryable: false, cause: error },
    );
  }

  if (/no space left|disk quota|not enough space|insufficient space/iu.test(message)) {
    return new AppFailure(
      'NO_SPACE',
      `Docker 側の容量が足りません。Docker Desktop のディスク割り当てや不要なイメージを確認してください / Docker ran out of disk space; check Docker Desktop's disk allocation and unused images (${message})`,
      { retryable: false, cause: error },
    );
  }

  if (
    status === 401 ||
    status === 403 ||
    /pull access denied|unauthorized|authentication required|requested access to the resource is denied|denied: /iu.test(
      message,
    )
  ) {
    return new AppFailure(
      'REGISTRY_AUTH_REQUIRED',
      `レジストリが認証を要求しました。リポジトリが公開されているか確認してください / the registry demanded credentials; check that the repository is public (${message})`,
      { retryable: false, cause: error },
    );
  }

  if (
    /no matching manifest|does not match the specified platform|was found but its platform|unsupported platform|image operating system .* cannot be used/iu.test(
      message,
    )
  ) {
    return new AppFailure(
      'UNSUPPORTED_PLATFORM',
      `この Docker デーモンの OS / CPU 向けのイメージがありません / no image matches this Docker daemon's OS and CPU (${message})`,
      { retryable: false, cause: error },
    );
  }

  if (
    status === 404 ||
    (context !== 'exec' &&
      /manifest unknown|not found|no such image|does not exist|repository .* not found/iu.test(message))
  ) {
    return new AppFailure(
      'IMAGE_NOT_FOUND',
      `指定した参照がレジストリにありません。配布側の公開状態とカタログを確認してください / the reference does not exist on the registry; check the publication and the catalog (${message})`,
      { retryable: false, cause: error },
    );
  }

  if (
    /EAI_AGAIN|getaddrinfo|dial tcp|TLS handshake|certificate|x509|proxy|connection reset|i\/o timeout|timeout|unexpected EOF|EOF|network is unreachable|temporary failure|context deadline exceeded|ETIMEDOUT|read: connection/iu.test(
      message,
    )
  ) {
    return new AppFailure(
      'NETWORK_ERROR',
      `ネットワークエラーで取得できませんでした。接続と Docker Desktop のプロキシ設定を確認して再試行してください / a network error interrupted the transfer; check connectivity and Docker Desktop's proxy settings, then retry (${message})`,
      { retryable: true, cause: error },
    );
  }

  return new AppFailure(
    'DOCKER_ERROR',
    `Docker がエラーを返しました / Docker returned an error during ${context}: ${message}`,
    { retryable: true, cause: error },
  );
}
