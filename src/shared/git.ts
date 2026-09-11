import { isHttpUrl, parseUrl } from './url.ts';

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/u;

const MAX_REF_LENGTH = 200;

export function cloneUrlProblem(input: string): string | null {
  const url = input.trim();
  if (url === '') return 'Git の URL が空です / the git URL is empty';
  if (url.startsWith('-')) return 'URL が - で始まっています / a URL starting with "-" would be read as an option';
  const parsed = parseUrl(url);
  if (parsed === null) return `${url}: URL の形式が不正です / not a valid URL`;
  if (!isHttpUrl(parsed)) {
    return `${url}: https:// の公開リポジトリだけ clone できます / only public http(s) repositories can be cloned`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `${parsed.host}: URL に認証情報は入れられません / credentials in the URL are not allowed`;
  }
  if (parsed.hostname === '') return `${url}: ホスト名がありません / the URL has no host`;
  if (parsed.search !== '' || parsed.hash !== '') {
    return `${parsed.host}: URL に ? や # 以降は付けられません / a clone URL cannot carry a query or fragment`;
  }
  return null;
}

export function displayCloneUrl(input: string): string {
  const parsed = parseUrl(input.trim());
  return parsed === null ? '(invalid URL)' : `${parsed.origin}${parsed.pathname}`;
}

export function cloneRefProblem(input: string): string | null {
  const ref = input.trim();
  if (ref === '') return null;
  if (ref.length > MAX_REF_LENGTH) return 'ブランチ名が長すぎます / the branch name is too long';
  if (!REF_PATTERN.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/')) {
    return `${ref}: ブランチ名に使えない文字が含まれています / not a valid branch or tag name`;
  }
  return null;
}

export function assertCloneTarget(url: string, ref: string): void {
  const problem = cloneUrlProblem(url) ?? cloneRefProblem(ref);
  if (problem !== null) throw new Error(problem);
}

export function repoNameFromUrl(input: string): string {
  const parsed = parseUrl(input.trim());
  if (parsed === null) return 'repo';
  const last = parsed.pathname.replace(/\/+$/u, '').split('/').pop() ?? '';
  const name = last.replace(/\.git$/iu, '').replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  return name === '' || name === '.' || name === '..' ? 'repo' : name;
}
