import { z } from 'zod';

import {
  catalogEntryId,
  DIGEST_PATTERN,
  IMAGE_PLATFORMS,
  IMAGE_VARIANTS,
  normalizeRepository,
  officialTag,
  RELEASE_PATTERN,
} from '../../shared/images.ts';
import type { ImageCatalog, ImageCatalogEntry } from '../../shared/images.ts';

const localizedSchema = z.strictObject({ ja: z.string().min(1), en: z.string().min(1) });

const toolSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().min(1),
  version: z.string(),
  highlight: z.boolean(),
});

const platformSchema = z.strictObject({
  platform: z.enum(IMAGE_PLATFORMS),
  manifestDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  compressedLayerBytes: z.number().int().nonnegative().nullable(),
});

const entrySchema = z.strictObject({
  id: z.string().min(1),
  variant: z.enum(IMAGE_VARIANTS),
  release: z.string().regex(RELEASE_PATTERN),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  recommended: z.boolean(),
  inherits: z.enum(IMAGE_VARIANTS).nullable(),
  repository: z.string().min(1),
  tag: z.string().min(1),
  indexDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  platforms: z.array(platformSchema),
  sourceRevision: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/u)
    .nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  tools: z.array(toolSchema),
});

const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  repository: z.string().min(1),
  entries: z.array(entrySchema).min(1),
});

export class CatalogInvalidError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`配布カタログが不正です / the image catalog is invalid: ${problems.join('; ')}`);
    this.name = 'CatalogInvalidError';
    this.problems = problems;
  }
}

function entryProblems(entry: z.infer<typeof entrySchema>, repository: string): string[] {
  const problems: string[] = [];
  const expectedId = catalogEntryId(entry.variant, entry.release);
  if (entry.id !== expectedId) problems.push(`${entry.id}: id must be ${expectedId}`);
  const expectedTag = officialTag(entry.variant, entry.release);
  if (entry.tag !== expectedTag) problems.push(`${entry.id}: tag must be ${expectedTag}`);
  if (normalizeRepository(entry.repository) !== repository) {
    problems.push(`${entry.id}: repository ${entry.repository} is not the catalog repository ${repository}`);
  }
  if (entry.inherits === entry.variant) problems.push(`${entry.id}: a variant cannot inherit itself`);

  const platforms = new Set<string>();
  for (const platform of entry.platforms) {
    if (platforms.has(platform.platform)) problems.push(`${entry.id}: platform ${platform.platform} listed twice`);
    platforms.add(platform.platform);
    if (platform.manifestDigest === null && platform.compressedLayerBytes !== null) {
      problems.push(`${entry.id}: ${platform.platform} has a size without a digest`);
    }
  }
  if (entry.platforms.length === 0) problems.push(`${entry.id}: lists no platform`);

  const tools = new Set<string>();
  for (const tool of entry.tools) {
    if (tools.has(tool.id)) problems.push(`${entry.id}: tool ${tool.id} listed twice`);
    tools.add(tool.id);
  }
  return problems;
}

export function catalogProblems(raw: unknown): readonly string[] {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const repository = normalizeRepository(parsed.data.repository);
  const problems: string[] = [];
  if (repository !== parsed.data.repository) {
    problems.push(`repository must be written in canonical form: ${repository}`);
  }
  const ids = new Set<string>();
  const recommended = parsed.data.entries.filter((entry) => entry.recommended).length;
  if (recommended !== 1) problems.push(`exactly one entry must be recommended (found ${recommended})`);
  for (const entry of parsed.data.entries) {
    if (ids.has(entry.id)) problems.push(`${entry.id}: listed twice`);
    ids.add(entry.id);
    problems.push(...entryProblems(entry, repository));
  }
  return problems;
}

export function parseCatalog(raw: unknown): ImageCatalog {
  const problems = catalogProblems(raw);
  if (problems.length > 0) throw new CatalogInvalidError(problems);
  const parsed = catalogSchema.parse(raw);
  const entries: ImageCatalogEntry[] = parsed.entries.map((entry) => ({
    ...entry,
    repository: normalizeRepository(entry.repository),
  }));
  return { schemaVersion: 1, generatedAt: parsed.generatedAt, repository: parsed.repository, entries };
}
