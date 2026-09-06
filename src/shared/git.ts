const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/u;

const MAX_REF_LENGTH = 200;

/** Public https clone URLs only: anything that would need a credential or a shell escape is refused. */
export function cloneUrlProblem(input: string): string | null {
  const url = input.trim();
  if (url === '') return 'Git の URL が空です / the git URL is empty';
  if (url.startsWith('-')) return 'URL が - で始まっています / a URL starting with "-" would be read as an option';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url}: URL の形式が不正です / not a valid URL`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${url}: https:// の公開リポジトリだけ clone できます / only public http(s) repositories can be cloned`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `${parsed.host}: URL に認証情報は入れられません / credentials in the URL are not allowed`;
  }
  if (parsed.hostname === '') return `${url}: ホスト名がありません / the URL has no host`;
  return null;
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

export function repoNameFromUrl(input: string): string {
  let path = '';
  try {
    path = new URL(input.trim()).pathname;
  } catch {
    return 'repo';
  }
  const last = path.replace(/\/+$/u, '').split('/').pop() ?? '';
  const name = last.replace(/\.git$/iu, '').replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  return name === '' || name === '.' || name === '..' ? 'repo' : name;
}
