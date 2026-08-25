import type { McpServerConfig } from './types.ts';

const RESERVED_MCP_NAMES = new Set([
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'claude-preview',
  'claude-browser',
]);

export function validateMcpServer(server: McpServerConfig): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(server.name)) {
    return `${server.name || '(名前なし)'}: 名前に使えるのは英数字とハイフン、アンダースコアだけです / only letters, digits, "-" and "_" are allowed in a server name`;
  }
  if (RESERVED_MCP_NAMES.has(server.name.toLowerCase().replaceAll('_', '-'))) {
    return `${server.name}: この名前は Claude Code の組み込みサーバ用に予約されています / this name is reserved for a built-in server`;
  }
  if (server.transport === 'stdio') {
    if (server.command.trim() === '') return `${server.name}: command が空です / command is empty`;
    return null;
  }
  if (server.url.trim() === '') return `${server.name}: URL が空です / url is empty`;
  let parsed: URL;
  try {
    parsed = new URL(server.url.trim());
  } catch {
    return `${server.name}: URL の形式が不正です / url is not a valid URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${server.name}: URL は http:// か https:// にしてください / url must be http or https`;
  }
  return null;
}
