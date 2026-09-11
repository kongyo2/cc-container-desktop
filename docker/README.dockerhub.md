# CC Workbench — Claude Code runtime images for CC Container Desktop

Pre-built Linux images that [CC Container Desktop](https://github.com/kongyo2/cc-container-desktop) runs Claude Code in. The app downloads one of them from this repository, verifies it, registers it, and creates one container per task from it. Nothing is installed on the host.

[CC Container Desktop](https://github.com/kongyo2/cc-container-desktop) が Claude Code を動かすために使う、ビルド済みの Linux イメージです。アプリの「イメージ」画面から取得・検証・登録し、タスクごとのコンテナを作ります。

## Variants / パターン

Every variant shares the same foundation (`base`) and the same runtime contract, so the app works identically on all of them. Pick by what your repository needs.

| Tag prefix | For                                     | On top of the foundation                                                                        |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `base`     | shell, git, small edits                 | — (Ubuntu 24.04, Node.js 24, Claude Code, git, GitHub CLI, tmux, ripgrep, fd, jq, yq, gcc/make) |
| `web` ★    | JavaScript / TypeScript, Node.js apps   | pnpm, Yarn, Bun, TypeScript, ESLint, Prettier                                                   |
| `python`   | Python apps, scripts, data work         | Python 3 (venv / pip), uv, Poetry, pytest, Ruff, mypy, Black                                    |
| `go`       | Go services and CLIs                    | Go toolchain                                                                                    |
| `rust`     | Rust crates and services                | rustc / cargo, rustfmt, clippy, OpenSSL headers                                                 |
| `jvm`      | Java / Kotlin                           | OpenJDK 21, Maven, Gradle                                                                       |
| `ruby`     | Ruby / Rails                            | Ruby, Bundler, native-extension libraries                                                       |
| `full`     | polyglot repositories                   | everything above plus PHP / Composer, Clang / CMake / Ninja / Conan, PostgreSQL 16, Redis, SQLite, Docker CLI / Compose / Buildx |

★ `web` is what the app recommends first.

## Tags and digests / タグとダイジェスト

- Official tags are `<variant>-<release>`, where `<release>` is a calendar version such as `2026.09.1`: `web-2026.09.1`, `python-2026.09.1`, …
- Official tags are never rewritten. A fix ships as a new release (`2026.09.2`).
- Every tag is a multi-platform index for `linux/amd64` and `linux/arm64`.
- The app never pulls by tag: its bundled catalog pins the platform manifest digest of every variant, and the registration it keeps on disk stores that digest. Tags exist for humans.
- No `latest` tag is published. The recommended variant is decided by the app's catalog.
- Candidate tags (`candidate-…`) are build artifacts of the publish workflow and are not meant to be used.

To see what a tag resolves to:

```
docker buildx imagetools inspect kongyo2/cc-workbench:web-2026.09.1
```

## Using an image with the app / アプリでの使い方

1. Start Docker Desktop (Linux containers).
2. In CC Container Desktop, open **Images** and press **Download and register** on a variant.
3. Create an environment that uses the image, then create a task from that environment.

The images contain no API keys, no personal settings and no work history. Endpoints, models and API keys are set per task through the app's profiles.

## Using an image by hand / 手動で使う

```
docker pull --platform linux/amd64 kongyo2/cc-workbench@sha256:<digest from the catalog>
docker run --rm -it --init -v my-home:/home/claude kongyo2/cc-workbench:web-2026.09.1 bash -l
```

- The container runs as `claude` (uid/gid 1000) with `HOME=/home/claude` and the workspace at `/home/claude/workspace`. Mount a volume at `/home/claude` to keep work between runs.
- The default command is `sleep infinity`; the app execs into the container. Pass `--init` (the app sets `HostConfig.Init`) so a proper PID 1 reaps children.
- Tool binaries live outside the home directory (`/opt/node`, `/opt/pytools`, `/usr/local/go`, `/opt/rustup`, `/opt/ruby`, …), so a mounted home volume never hides them.
- `/opt/cc/image-info.json` records the variant, release, runtime contract, source revision and the versions of every installed tool; `/opt/cc/apt-packages.txt` lists the apt packages.
- `full` includes the Docker CLI but no daemon. Point `DOCKER_HOST` at a daemon you control if you need it.
- PostgreSQL and Redis in `full` are installed but not running: `sudo service postgresql start` / `sudo service redis-server start`.

## Updates / 更新

A new Claude Code or toolchain version is distributed as a new release of every variant. Existing tasks keep running on the image they were created from; in the app, switch the environment to the new registration and use **Recreate** on the tasks that should move (the home volume is kept).

## Provenance / 由来

Images are built by the [publish workflow](https://github.com/kongyo2/cc-container-desktop/blob/main/.github/workflows/publish-images.yml) from the `docker/` directory of the tagged source revision, with every download pinned by checksum in `docker/image-versions.lock.json`, and pushed with SBOM and provenance attestations. The OCI labels `org.opencontainers.image.source`, `.revision` and `.version` on every image name the source commit and release.

When reporting a problem, include the variant and release (`cat /opt/cc/image-info.json`) in the issue.
