const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface EnvParse {
  readonly env: Record<string, string>;
  readonly problems: readonly string[];
}

function lineEndFrom(source: string, from: number): number {
  const newline = source.indexOf('\n', from);
  return newline === -1 ? source.length : newline;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === '\n') count += 1;
  }
  return count;
}

interface Quoted {
  readonly value: string;
  readonly end: number;
  readonly closed: boolean;
}

function readQuoted(source: string, start: number): Quoted {
  const quote = source[start];
  let index = start + 1;
  let value = '';

  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\\' && quote === '"' && index + 1 < source.length) {
      const escaped = source[index + 1] ?? '';
      const known = ESCAPES[escaped];
      value += known ?? (escaped === '\\' || escaped === '"' ? escaped : `\\${escaped}`);
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1, closed: true };
    value += char;
    index += 1;
  }
  return { value, end: index, closed: false };
}

function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '#') continue;
    if (index === 0) return '';
    const previous = value[index - 1];
    if (previous === ' ' || previous === '\t') return value.slice(0, index);
  }
  return value;
}

export function parseEnvText(text: string): EnvParse {
  const source = text.replaceAll('\r\n', '\n');
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const problems: string[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  let line = 1;

  while (cursor < source.length) {
    const lineEnd = lineEndFrom(source, cursor);
    const raw = source.slice(cursor, lineEnd);
    const stripped = raw.trimStart();

    if (stripped === '' || stripped.startsWith('#')) {
      cursor = lineEnd + 1;
      line += 1;
      continue;
    }

    let head = cursor + (raw.length - stripped.length);
    let body = stripped;
    const exported = /^export[ \t]+/u.exec(body);
    if (exported !== null) {
      head += exported[0].length;
      body = body.slice(exported[0].length);
    }

    const separator = body.indexOf('=');
    const name = separator === -1 ? '' : body.slice(0, separator).trim();

    if (separator === -1 || name === '') {
      problems.push(`${line} 行目: KEY=VALUE の形にしてください / line ${line} is not KEY=VALUE`);
      cursor = lineEnd + 1;
      line += 1;
      continue;
    }
    if (/\s/u.test(name)) {
      problems.push(`${name}: 名前に空白は使えません / a name cannot contain whitespace`);
      cursor = lineEnd + 1;
      line += 1;
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${name}: 同じ名前が 2 回あります。後の行が勝ちます / set twice; the later line wins`);
    }
    seen.add(name);

    let valueStart = head + separator + 1;
    while (source[valueStart] === ' ' || source[valueStart] === '\t') valueStart += 1;

    const opener = source[valueStart];
    if (opener !== '"' && opener !== "'") {
      env[name] = stripInlineComment(source.slice(valueStart, lineEnd)).trimEnd();
      cursor = lineEnd + 1;
      line += 1;
      continue;
    }

    const quoted = readQuoted(source, valueStart);
    if (!quoted.closed) {
      problems.push(`${name}: 引用符が閉じていません / the quote opened here is never closed`);
    }
    env[name] = quoted.value;

    line += countNewlines(source.slice(valueStart, quoted.end));
    const tailEnd = lineEndFrom(source, quoted.end);
    const tail = source.slice(quoted.end, tailEnd).trim();
    if (tail !== '' && !tail.startsWith('#')) {
      problems.push(
        `${name}: 閉じ引用符の後ろは読み飛ばします / everything after the closing quote is ignored: ${tail}`,
      );
    }
    cursor = tailEnd + 1;
    line += 1;
  }

  return { env: { ...env }, problems };
}

export function envNameProblems(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(env)
    .filter((name) => !NAME_PATTERN.test(name))
    .map(
      (name) =>
        `${name}: 環境変数の名前は英字かアンダースコアで始まり、英数字とアンダースコアだけです / an environment variable name starts with a letter or "_" and holds only letters, digits and "_"`,
    );
}

function quoteIfNeeded(value: string): string {
  if (value === '') return '';
  if (!/[\n\r"'#\\]/u.test(value) && value === value.trim()) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r')}"`;
}

export function formatEnvText(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${quoteIfNeeded(value)}`)
    .join('\n');
}
