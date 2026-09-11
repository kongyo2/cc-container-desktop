import type { Language } from './types.ts';

export const IMAGE_VARIANTS = ['base', 'web', 'python', 'go', 'rust', 'jvm', 'ruby', 'full'] as const;

export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;

export type ImagePlatform = (typeof IMAGE_PLATFORMS)[number];

export const DIGEST_PATTERN: RegExp = /^sha256:[0-9a-f]{64}$/u;

export const RELEASE_PATTERN: RegExp = /^\d{4}\.(?:0[1-9]|1[0-2])\.\d{1,3}$/u;

export const REGISTERED_IMAGE_ID_PATTERN: RegExp = /^img_[0-9a-f]{24}$/u;

export const TAG_PATTERN: RegExp = /^[\w][\w.-]{0,127}$/u;

const PATH_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/u;

export type LocalizedText = Readonly<Record<Language, string>>;

export interface CatalogTool {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly highlight: boolean;
}

export interface CatalogPlatform {
  readonly platform: ImagePlatform;
  readonly manifestDigest: string | null;
  readonly compressedLayerBytes: number | null;
}

export interface ImageCatalogEntry {
  readonly id: string;
  readonly variant: ImageVariant;
  readonly release: string;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly description: LocalizedText;
  readonly recommended: boolean;
  readonly inherits: ImageVariant | null;
  readonly repository: string;
  readonly tag: string;
  readonly indexDigest: string | null;
  readonly platforms: readonly CatalogPlatform[];
  readonly sourceRevision: string | null;
  readonly publishedAt: string | null;
  readonly tools: readonly CatalogTool[];
}

export interface ImageCatalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly repository: string;
  readonly entries: readonly ImageCatalogEntry[];
}

export interface RegisteredImage {
  readonly id: string;
  readonly catalogEntryId: string | null;
  readonly variant: ImageVariant | null;
  readonly release: string | null;
  readonly title: LocalizedText;
  readonly repository: string;
  readonly tag: string | null;
  readonly pinnedDigest: string | null;
  readonly platform: ImagePlatform;
  readonly tools: readonly CatalogTool[];
  readonly registeredAt: string;
}

export type ImageAvailability =
  | { readonly kind: 'ready'; readonly localImageId: string; readonly localSizeBytes: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'incompatible'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface RegisteredImageView {
  readonly image: RegisteredImage;
  readonly availability: ImageAvailability;
  readonly environmentIds: readonly string[];
  readonly appliedTaskIds: readonly string[];
  readonly inCatalog: boolean;
}

export type ImageOperationKind = 'download' | 'custom' | 'repair';

export type ImageOperationPhase =
  'queued' | 'checking' | 'pulling' | 'registering' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

const TERMINAL_PHASES: readonly ImageOperationPhase[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function isTerminalPhase(phase: ImageOperationPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ImageOperationTarget {
  readonly title: LocalizedText;
  readonly repository: string;
  readonly tag: string | null;
  readonly pinnedDigest: string | null;
  readonly platform: ImagePlatform | null;
}

export interface LayerProgress {
  readonly id: string;
  readonly status: string;
  readonly current: number;
  readonly total: number | null;
  readonly done: boolean;
}

export interface ImageOperation {
  readonly id: string;
  readonly kind: ImageOperationKind;
  readonly sequence: number;
  readonly targetKey: string;
  readonly catalogEntryId: string | null;
  readonly registeredImageId: string | null;
  readonly target: ImageOperationTarget;
  readonly phase: ImageOperationPhase;
  readonly step: string;
  readonly cancelRequested: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly pulled: boolean;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly completedLayers: number;
  readonly totalLayers: number;
  readonly layers: readonly LayerProgress[];
  readonly error: AppError | null;
}

export function catalogEntryId(variant: ImageVariant, release: string): string {
  return `${variant}@${release}`;
}

export function officialTag(variant: ImageVariant, release: string): string {
  return `${variant}-${release}`;
}

const DOCKER_HUB_HOSTS: readonly string[] = ['docker.io', 'index.docker.io', 'registry-1.docker.io'];

function looksLikeHost(component: string): boolean {
  return component.includes('.') || component.includes(':') || component === 'localhost';
}

export function normalizeRepository(input: string): string {
  let text = input.trim().toLowerCase();
  const at = text.indexOf('@');
  if (at !== -1) text = text.slice(0, at);
  const lastSlash = text.lastIndexOf('/');
  const lastColon = text.lastIndexOf(':');
  if (lastColon > lastSlash) text = text.slice(0, lastColon);
  text = text.replace(/\/+$/u, '');
  if (text === '') return '';

  const segments = text.split('/');
  const head = segments[0] ?? '';
  if (!looksLikeHost(head)) {
    const path = segments.length === 1 ? `library/${head}` : segments.join('/');
    return `docker.io/${path}`;
  }
  const host = DOCKER_HUB_HOSTS.includes(head) ? 'docker.io' : head;
  const rest = segments.slice(1);
  if (host === 'docker.io' && rest.length === 1) return `docker.io/library/${rest[0] ?? ''}`;
  return `${host}/${rest.join('/')}`;
}

export function repositoryDisplay(repository: string): string {
  const canonical = normalizeRepository(repository);
  if (!canonical.startsWith('docker.io/')) return canonical;
  const path = canonical.slice('docker.io/'.length);
  return path.startsWith('library/') ? path.slice('library/'.length) : path;
}

export function dockerHubUrl(repository: string): string | null {
  const canonical = normalizeRepository(repository);
  if (!canonical.startsWith('docker.io/')) return null;
  const path = canonical.slice('docker.io/'.length);
  return path.startsWith('library/')
    ? `https://hub.docker.com/_/${path.slice('library/'.length)}`
    : `https://hub.docker.com/r/${path}`;
}

export function digestReference(repository: string, digest: string): string {
  return `${repositoryDisplay(repository)}@${digest}`;
}

function tagReference(repository: string, tag: string): string {
  return `${repositoryDisplay(repository)}:${tag}`;
}

export function imageReference(repository: string, digest: string | null, tag: string | null): string {
  return digest === null ? tagReference(repository, tag ?? 'latest') : digestReference(repository, digest);
}

export function pullCommand(
  repository: string,
  digest: string | null,
  tag: string | null,
  platform: ImagePlatform,
): string {
  return `docker pull --platform ${platform} ${imageReference(repository, digest, tag)}`;
}

export interface ImageReference {
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string | null;
}

export function parseImageReference(input: string): ImageReference | null {
  const text = input.trim();
  if (text === '' || /\s/u.test(text)) return null;

  let rest = text;
  let digest: string | null = null;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1).toLowerCase();
    rest = rest.slice(0, at);
    if (!DIGEST_PATTERN.test(digest)) return null;
  }

  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!TAG_PATTERN.test(tag)) return null;
  }

  const name = rest.toLowerCase();
  if (name === '' || name.length > 255) return null;
  const [head, ...path] = name.split('/');
  if (head === undefined) return null;
  const hostFirst = looksLikeHost(head);
  if (hostFirst ? !HOST_PATTERN.test(head) : !PATH_COMPONENT_PATTERN.test(head)) return null;
  if (hostFirst && path.length === 0) return null;
  if (!path.every((component) => PATH_COMPONENT_PATTERN.test(component))) return null;

  return { repository: normalizeRepository(name), tag: tag ?? (digest === null ? 'latest' : null), digest };
}

export function imageReferenceProblem(input: string, language: Language): string | null {
  if (parseImageReference(input) !== null) return null;
  return language === 'ja'
    ? 'docker pull に渡せる形で指定してください (例: ghcr.io/owner/image:tag、owner/image@sha256:…)'
    : 'Enter it the way docker pull takes it (e.g. ghcr.io/owner/image:tag or owner/image@sha256:…)';
}

const ARCHITECTURES: Readonly<Record<string, ImagePlatform>> = {
  amd64: 'linux/amd64',
  x86_64: 'linux/amd64',
  'x86-64': 'linux/amd64',
  arm64: 'linux/arm64',
  aarch64: 'linux/arm64',
  'arm64/v8': 'linux/arm64',
};

export function platformFromDaemon(osType: string | null, architecture: string | null): ImagePlatform | null {
  if (osType === null || osType.toLowerCase() !== 'linux' || architecture === null) return null;
  return ARCHITECTURES[architecture.trim().toLowerCase()] ?? null;
}

export function catalogPlatform(entry: ImageCatalogEntry, platform: ImagePlatform | null): CatalogPlatform | null {
  if (platform === null) return null;
  return entry.platforms.find((candidate) => candidate.platform === platform) ?? null;
}

export function registrationIdentity(digest: string | null, tag: string | null): string {
  return digest === null ? `tag:${tag ?? 'latest'}` : digest;
}

export function imageTargetKey(
  repository: string,
  digest: string | null,
  tag: string | null,
  platform: ImagePlatform,
): string {
  return `${normalizeRepository(repository)}|${registrationIdentity(digest, tag)}|${platform}`;
}

export function entryById(catalog: ImageCatalog, id: string | null): ImageCatalogEntry | null {
  if (id === null) return null;
  return catalog.entries.find((entry) => entry.id === id) ?? null;
}

export function highlightTools(tools: readonly CatalogTool[]): readonly CatalogTool[] {
  return tools.filter((tool) => tool.highlight);
}

export function toolLabel(tool: CatalogTool): string {
  return tool.version === '' ? tool.name : `${tool.name} ${tool.version}`;
}

export function imageDisplayName(
  image: { readonly title: LocalizedText; readonly release: string | null },
  language: Language,
): string {
  return image.release === null ? image.title[language] : `${image.title[language]} / ${image.release}`;
}

export function operationProgress(operation: ImageOperation): number | null {
  if (operation.phase === 'succeeded') return 1;
  if (operation.phase !== 'pulling') return null;
  if (operation.totalBytes !== null && operation.totalBytes > 0) {
    return Math.min(1, operation.downloadedBytes / operation.totalBytes);
  }
  if (operation.totalLayers > 0) return Math.min(1, operation.completedLayers / operation.totalLayers);
  return null;
}

export function registeredImageById(
  images: readonly RegisteredImageView[],
  id: string | null,
): RegisteredImageView | null {
  if (id === null) return null;
  return images.find((view) => view.image.id === id) ?? null;
}

function availableRegisteredImages(images: readonly RegisteredImageView[]): readonly RegisteredImageView[] {
  return images.filter((view) => view.availability.kind === 'ready');
}

export function preferredRegisteredImage(images: readonly RegisteredImageView[]): RegisteredImageView | null {
  const ready = availableRegisteredImages(images);
  return ready.find((view) => view.image.variant === 'web') ?? ready[0] ?? images[0] ?? null;
}
