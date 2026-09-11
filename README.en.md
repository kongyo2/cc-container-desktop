# Claude Code Container Workbench

An Electron app for Windows 11 that runs Claude Code inside Docker. Work is organised as tasks: every task gets its own container and home volume. Containers are created from pre-built images distributed on Docker Hub, and an environment (image + variables + setup script) decides which image a task uses. Endpoints, models and API keys are profiles assigned per task. Nothing — not Node, not Claude Code — is installed on the host, and nothing is built locally.

[日本語](README.md)

## How it works

1. Start Docker Desktop (Linux containers).
2. On the **Images** page pick the variant you need and press **Download and register**. The image is pulled, verified and recorded; the card turns "Registered". Web is the recommended first pick.
3. Press **Create an environment with this image** on the card (or "Create environment" on the Environments page). An environment is a name, an image, variables in `.env` form, and a bash setup script that runs once right after a task's container is created.
4. Set up an endpoint and API key on the Profiles page (not needed to download images).
5. Press "+" at the top of the sidebar to create a task: pick an environment, then start from an empty workspace or a public git repository.
6. "Claude Code" on the task page drops you into a tmux session inside the container. Closing the tab or the app leaves Claude Code running; the same button reattaches.
7. Drop files or folders onto the task page (or use the import buttons) to copy them into the workspace, and "Export" to write the workspace out to a host folder.

## Images

Every image shares one foundation (Ubuntu 24.04, Node.js 24, Claude Code, git, GitHub CLI, tmux, ripgrep, fd, jq, yq, gcc/make) and one runtime contract, so the app behaves the same on all of them. Pick one of eight variants by what your repository needs.

| Variant  | For                                             | On top of the foundation                                                                                                     |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `base`   | shell, git, small edits; bring your own tooling | nothing                                                                                                                      |
| `web` ★  | JavaScript / TypeScript, front-end, Node apps   | pnpm, Yarn, Bun, TypeScript, ESLint, Prettier                                                                                |
| `python` | Python apps, scripts, data work                 | Python 3 (venv / pip), uv, Poetry, pytest, Ruff, mypy, Black                                                                 |
| `go`     | Go services and CLIs                            | Go toolchain                                                                                                                 |
| `rust`   | Rust crates and services                        | rustc / cargo, rustfmt, clippy, OpenSSL headers                                                                              |
| `jvm`    | Java / Kotlin                                   | OpenJDK 21, Maven, Gradle                                                                                                    |
| `ruby`   | Ruby / Rails                                    | Ruby, Bundler, native-extension libraries                                                                                    |
| `full`   | polyglot repositories                           | all of the above plus PHP / Composer, Clang / CMake / Ninja / Conan, PostgreSQL 16, Redis, SQLite, Docker CLI / Compose / Buildx |

★ The variant the app recommends first.

- Images are published to the Docker Hub repository `kongyo2/cc-workbench` for `linux/amd64` and `linux/arm64`. Official tags are `<variant>-<release>` (for example `web-2026.09.1`) and are never rewritten; a fix ships as a new release.
- The app does not pull by tag. Its bundled catalog (`src/shared/imageCatalog.json`) pins the platform manifest digest of every variant, and the registration it keeps on disk stores that digest, so a moved tag never changes what a task runs. A release whose digest is not in the catalog yet is pulled by tag, and the digest that actually arrives is pinned at registration.
- A pulled image is verified before it is registered: OS / CPU, labels, the `claude` user (1000:1000), `/home/claude/workspace`, Node.js and Claude Code, tmux and the rest of the shared runtime contract are checked in a throwaway container without network access. A failure leaves nothing registered.
- The catalog and the registered list stay readable while Docker is down. Windows container mode and unsupported CPUs are reported instead of attempted.
- "Unregister" only removes the app's ledger entry; the image itself stays in Docker. A registration referenced by an environment or a task cannot be removed.
- New Claude Code or toolchain versions ship as a new image release, and the catalog is updated together with the app. Existing tasks are never switched automatically.

## Environments

An environment is a name, an image, variables in `.env` form, and a setup script.

- The image is one of the registered, usable images (required). Changing an environment's image later marks its tasks with "image change ready to apply"; "Recreate" moves a task onto the new image while keeping the home volume.
- The variables are set when the task's container is created and reach every process inside it (shells, Claude Code, its tools). `HOME`, `USER`, `TERM`, `COLORTERM` and `LANG` are set by the app and cannot be given here.
- Variables are stored in plain text in `config.json` and are visible through `docker inspect`. Keep API keys and other secrets out of them; a profile's API key field (the OS encrypted store) is the place for those.
- The setup script runs once, right after the container is created — after the clone, before Claude Code is opened — in the workspace, as the `claude` user. Stop/start does not rerun it; "Recreate" does. A failed script gets another attempt on the next start.
- Changes to variables or the setup script apply to new containers. Tasks that already have one show "environment updated"; "Recreate" applies the change.
- Environments can be archived. An archived environment cannot be picked for new tasks, but tasks that have it keep working. Only an environment no task uses can be deleted.

## Where things live

| What                         | Where                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace, settings, history | One Docker volume per task, `cc-task-<id>-home`, mounted at `/home/claude`                                                                                     |
| Container                    | `cc-task-<id>`; stopping keeps the volume, only deleting the task removes it. The registered image and digest it was created from are recorded in its labels    |
| Images                       | Referenced in Docker by platform digest. The ledger is `images.json`, the download history `image-operations.json`                                              |
| App config and task list     | `%APPDATA%\cc-container-desktop\state-v1\config.json` (environments included) / `tasks.json`; API keys in `secrets.json` via the OS encrypted store. Open it from Settings |

- State files are read strictly in their current shape (`schemaVersion: 1`). An unreadable file is reported at startup and is not updated (never overwritten with empty data); a copy is kept as `*.broken-*`.
- Files from earlier versions (`config.json` / `tasks.json` / `secrets.json` outside `state-v1`, fixed-tag images) are not read. Data starts fresh in the new area.
- Deleting a task removes its container and volume. With "Export the workspace before deleting" checked, a single item that cannot be exported stops the delete.

## When Docker Hub rate-limits the download

Anonymous pulls from Docker Hub are rate limited. While limited, run `docker login` in a terminal, run the digest-pinned pull command from the card's "Details", then press the same button in the app: it verifies and registers the local image. The app never reads your credentials.

## Development

```
npm ci
npm run dev              # development mode
npm run check            # format / lint / typecheck / unit tests / catalog / build
npm test                 # unit tests for the pure functions, state transitions, stream parser and ledger (no Docker)
npm run e2e:images       # needs Docker, no API key; publishes base to a local registry and runs download → register → environment → task
npm run e2e:deep         # needs Docker, no API key
npm run e2e              # needs Docker and CC_E2E_API_KEY
```

### Building and publishing images

- `docker/Dockerfile` has one shared foundation (`core`) and eight final targets. Each stage copies only the scripts it runs, so fixing one variant's installer leaves `core` in the build cache. Versions are pinned in `docker/image-versions.lock.json`; `npm run lock:update` refreshes it with current upstream versions and checksums, separately from building.
- Local builds: `npm run images:build -- base` (or `npm run images:build` for all). Behind a TLS-inspecting proxy, pass the CA bundle as the BuildKit secret `build-ca-bundle`.
- Every image carries `/opt/cc/image-info.json` (variant, release, runtime contract, source revision, measured tool versions) and `/opt/cc/apt-packages.txt`. `docker/scripts/verify-runtime.sh` is the runtime contract; CI and the app's registration check run the same script.
- Publishing is the `publish-images` GitHub Actions workflow (workflow_dispatch). It builds variant × platform on native runners, pushes by digest, merges each variant into a candidate tag, pulls the candidates back from Docker Hub and runs the contract, promotes only verified indexes to the official tags, confirms anonymous pulls, then generates `imageCatalog.json` with the real digests and sizes and opens a pull request. Secrets: `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`; the repository comes from the variable `DOCKERHUB_REPOSITORY` (default `docker.io/kongyo2/cc-workbench`).
- `npm run catalog:verify` checks the catalog's shape; `npm run catalog:verify:online` also confirms every digest resolves anonymously on Docker Hub. The app's release workflow uses the latter as a gate.
- Development builds only: `CC_IMAGE_CATALOG_FILE` points the app at another catalog (for example a local registry). Packaged builds ignore it.
