export interface VerifyReport {
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly complete: boolean;
}

/** Parses the "ok <name>" / "fail <name>: why" / "RESULT p f" lines of verify-runtime.sh. */
export function parseVerifyOutput(output: string): VerifyReport {
  const passed: string[] = [];
  const failed: string[] = [];
  let complete = false;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('ok ')) passed.push(line.slice(3));
    else if (line.startsWith('fail ')) failed.push(line.slice(5));
    else if (/^RESULT \d+ \d+$/u.test(line)) complete = true;
  }
  return { passed, failed, complete };
}

export interface ImageInfo {
  readonly project: string;
  readonly variant: string;
  readonly release: string;
  readonly runtimeContract: number;
  readonly sourceRevision: string | null;
  readonly tools: Readonly<Record<string, string>>;
}

export function parseImageInfo(text: string): ImageInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const tools: Record<string, string> = {};
  const rawTools = record['tools'];
  if (typeof rawTools === 'object' && rawTools !== null && !Array.isArray(rawTools)) {
    for (const [key, value] of Object.entries(rawTools as Record<string, unknown>)) {
      if (typeof value === 'string') tools[key] = value;
    }
  }
  if (typeof record['variant'] !== 'string' || typeof record['release'] !== 'string') return null;
  return {
    project: typeof record['project'] === 'string' ? record['project'] : '',
    variant: record['variant'],
    release: record['release'],
    runtimeContract: typeof record['runtimeContract'] === 'number' ? record['runtimeContract'] : -1,
    sourceRevision: typeof record['sourceRevision'] === 'string' ? record['sourceRevision'] : null,
    tools,
  };
}
