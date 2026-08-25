# Claude Code Container Workbench

An Electron app for Windows 11 that runs Claude Code inside a Docker container, with the endpoint, model and API key swappable per use case. Nothing — not Node, not Claude Code — gets installed on the host.

[日本語](README.md)

![Connect tab](docs/screenshot-connect.png)

![Extensions](docs/screenshot-extensions.png)

## Requirements

Docker Desktop, running. Node.js 22+ only if you are building the app yourself.

## Using it

On the Connect tab: **Build** → **Start** → **Start / reattach Claude Code**.

- **Profiles** — base URL, models, API key. The base URL is a prefix, so leave `/v1` off (OpenRouter is `https://openrouter.ai/api`); the resolved URL is shown under the field. Keys live in the OS encrypted store, DPAPI on Windows.
- **Extensions** — MCP servers, marketplaces, plugins and skills, written into the container on every apply. Only the keys the app created are managed, so a server you added with `claude mcp add` inside the container is left alone.
- **Files** — edit anything in the container, and **Export workspace** to get work out (there is no GitHub CLI in the image, by design).
- **Image** — edit the `Dockerfile`, `setup.sh` (once, at build time) and `post-create.sh` (every start) in the UI.
- **New session** — throws the container and its home volume away and rebuilds. The image stays, so it takes seconds.

Closing a tab leaves Claude Code running in its tmux session; the same button reattaches.

### About skills

Skills are written to `~/.claude/skills/<name>/SKILL.md`. The directory comes from the frontmatter `name` — so does the `/command` — which is why there is no separate name field. `name` and `description` are both required; a skill that misses either is not written, and the reason is shown next to it. Fields only Claude Code understands, like `when_to_use`, are written but warned about, because a claude.ai upload or the Skills API rejects them.

## Verification

Four suites under `tests/e2e/`, all against a real Docker daemon and a real endpoint. Nothing is mocked.

| Suite           | What it covers                                                                                                                     | Checks |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `workbench.mjs` | image → container → provisioning → a live `claude -p` answer → tmux reattach                                                       | 29     |
| `deep.mjs`      | real typing, no-container behaviour, corrupt JSON, CJK filenames, permission bits, export, reset, extensions, the data-loss guards | 143    |
| `live.mjs`      | tool use, model aliases, the GUI terminal, conversation survival across a reattach, MCP and skills reaching the model              | 23     |
| `packaged.mjs`  | launches the `electron-builder` output and checks it resolves from `resourcesPath`                                                 | 9      |

```bash
CC_E2E_API_KEY=sk-or-v1-... npm run e2e:all        # prefix with xvfb-run -a on headless Linux
CC_E2E_API_KEY=sk-or-v1-... npm run e2e:packaged   # needs npm run pack:dir first
```

All 204 checks pass against OpenRouter + `stealth/ox-alpha`: no onboarding screen ever appears, the model reads and writes files with its own tools, actually calls an MCP tool, actually uses an injected skill, and still remembers the conversation after a reattach. The other presets (Anthropic, Moonshot, Z.ai, DeepSeek, MiniMax) are untested and labelled as such in the UI.

## Development

```bash
npm install && npm run dev
npm run check      # format, lint, typecheck, dependency types, build
npm run dist:win   # Windows x64 installer into release/
```

```
src/main/      Electron main: docker/ claude/ config/ reset.ts
src/preload/   contextBridge, sandboxed
src/renderer/  React 19 + xterm.js + CodeMirror 6
src/shared/    types, IPC contract, i18n, SKILL.md validation
docker/        Dockerfile, setup.sh, post-create.sh
```

The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. It reaches neither the Docker socket nor the host filesystem directly, though it can drive the container through IPC.

CI runs format, lint, typecheck, build and a packaged launch on every push and PR. The suites that spend real tokens are manual-trigger only, as is the release workflow.

## Troubleshooting

- **A model error** — almost always the base URL. Drop the `/v1`.
- **"Docker not found"** — start Docker Desktop; check `docker version` works.
- **A skill will not load** — look for an error on it in the Extensions tab; `name` and `description` are both required.
- **An MCP server will not connect** — press Check status for what `claude mcp list` reports. For `stdio`, the command must exist inside the container; for `http`, the container must be able to reach the URL.
- **A rebuilt image is not being used** — remove the container on the Connect tab and start it again.
