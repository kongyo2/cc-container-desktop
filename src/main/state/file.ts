import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { AppFailure, describeError } from '../errors.ts';
import { logError, logWarn } from '../logger.ts';
import { brokenCopyPath } from '../paths.ts';

export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function readJsonFile(
  path: string,
): { readonly exists: false } | { readonly exists: true; readonly value: unknown } {
  if (!existsSync(path)) return { exists: false };
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (error) {
    throw new Error(`JSON として読めません / not readable as JSON: ${describeError(error)}`, { cause: error });
  }
}

export function keepAside(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = brokenCopyPath(path);
  try {
    copyFileSync(path, backup);
    return backup;
  } catch (error) {
    logWarn('app', `退避に失敗しました / could not back up ${path}: ${describeError(error)}`);
    return null;
  }
}

export type ParseOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

export interface StateFileOptions<T> {
  readonly path: () => string;
  readonly label: string;
  readonly parse: (raw: unknown) => ParseOutcome<T>;
  readonly initial: () => T;
  readonly serialize: (value: T) => unknown;
  readonly persistInitial: boolean;
}

/**
 * One strictly-validated JSON file under state-v1/. A file that exists but
 * cannot be read stays untouched: reads return the in-memory initial value,
 * writes refuse, and the problem is reported to the UI until the file is
 * fixed or removed.
 */
export class StateFile<T> {
  private cache: T | null = null;
  private failure: string | null = null;
  private readonly options: StateFileOptions<T>;

  constructor(options: StateFileOptions<T>) {
    this.options = options;
  }

  get problem(): string | null {
    this.get();
    return this.failure;
  }

  get(): T {
    if (this.cache !== null) return this.cache;
    const path = this.options.path();
    let read: { readonly exists: false } | { readonly exists: true; readonly value: unknown };
    try {
      read = readJsonFile(path);
    } catch (error) {
      this.markBroken(path, describeError(error));
      this.cache = this.options.initial();
      return this.cache;
    }
    if (!read.exists) {
      this.cache = this.options.initial();
      if (this.options.persistInitial) this.write(this.cache);
      return this.cache;
    }
    const parsed = this.options.parse(read.value);
    if (!parsed.ok) {
      this.markBroken(path, parsed.problem);
      this.cache = this.options.initial();
      return this.cache;
    }
    this.cache = parsed.value;
    return this.cache;
  }

  set(value: T): T {
    this.get();
    if (this.failure !== null) {
      throw new AppFailure(
        'STORE_UNWRITABLE',
        `${this.options.label} を読めなかったので更新を止めています。ファイルを直すか削除してから再起動してください / ${this.options.label} could not be read, so it is not being updated; fix or remove the file and restart (${this.failure})`,
      );
    }
    this.write(value);
    this.cache = value;
    return value;
  }

  private write(value: T): void {
    writeAtomic(this.options.path(), `${JSON.stringify(this.options.serialize(value), null, 2)}\n`);
  }

  private markBroken(path: string, problem: string): void {
    this.failure = `${path}: ${problem}`;
    const backup = keepAside(path);
    logError(
      'app',
      `${this.options.label} を読めません。このファイルは更新しません / ${this.options.label} is unreadable and will not be modified: ${problem}` +
        (backup === null ? '' : ` — 退避先 / copy kept at ${backup}`),
    );
  }
}
