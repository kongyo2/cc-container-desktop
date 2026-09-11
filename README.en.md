# Claude Code Container Workbench

An Electron app for Windows 11 that runs Claude Code inside Docker. Work is organised as tasks: every task gets its own container and home volume, created from one fixed base image, and picks an environment (variables plus a setup script) and a profile (endpoint, model, API key) of its own. Nothing — not Node, not Claude Code — gets installed on the host.

[日本語](README.md)

## How it works

1. Start Docker Desktop and build the base image on the Environments page (once; it installs every toolchain, so it takes tens of minutes).
2. Set up an endpoint and API key on the Profiles page.
3. Optionally create environments on the Environments page: a name, variables in `.env` form, and a bash setup script that runs once, right after a task's container is created. A fresh install comes with one ("環境1").
4. Press "+" at the top of the sidebar to create a task: pick an environment, then start from an empty workspace or a public git repository.
5. "Claude Code" on the task page drops you into a tmux session inside the container. Closing the tab or the app leaves Claude Code running; the same button reattaches.
6. Drop files or folders onto the task page (or use the import buttons) to copy them into the workspace, and "Export" to write the workspace out to a host folder.

## The base image

Every task is created from the same fixed image. Its contents come from the bundled `docker/Dockerfile` and are not edited from the app; it mirrors the Claude Code cloud environment.

| Category      | Included                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| **Python**    | Python 3.x with pip, poetry, uv, black, mypy, pytest, ruff                 |
| **Node.js**   | 20, 21, and 22, with npm, yarn, pnpm, bun, eslint, prettier, chromedriver  |
| **Ruby**      | 3.1, 3.2, 3.3 with gem, bundler, rbenv                                     |
| **PHP**       | 8.3 with Composer                                                          |
| **Java**      | OpenJDK 21 with Maven and Gradle                                           |
| **Go**        | Go with module support                                                     |
| **Rust**      | rustc and cargo                                                            |
| **C/C++**     | GCC, Clang, cmake, ninja, conan                                            |
| **Docker**    | docker, dockerd, docker compose                                            |
| **Databases** | PostgreSQL 16, Redis 7.0                                                   |
| **Utilities** | git, gh, jq, yq, ripgrep, tmux, vim, nano                                  |

Node.js versions are installed at `/opt/node20`, `/opt/node21`, and `/opt/node22`, with 22 on `PATH` by default. To work with a different version, ask Claude to prepend that version's `bin` directory, such as `/opt/node20/bin`, to `PATH`. PostgreSQL and Redis are started with `sudo service postgresql start` / `sudo service redis-server start`. The Docker daemon cannot run inside the container.

"Update Claude Code" reinstalls only the layer that holds Claude Code and the global npm tools.

## Environments

An environment is a name, variables in `.env` form, and a setup script.

- The variables are set when the task's container is created and reach every process inside it (shells, Claude Code, its tools). `HOME`, `USER`, `TERM`, `COLORTERM` and `LANG` are set by the app and cannot be given here.
- Variables are stored in plain text in `config.json` and are visible through `docker inspect`. Keep API keys and other secrets out of them; a profile's API key field (the OS encrypted store) is the place for those. A "session" in the dialog means a task's container.
- The setup script runs once, right after the container is created — after the clone, before Claude Code is opened — in the workspace, as the `claude` user. Stop/start does not rerun it; "Recreate" does. A failed script gets another attempt on the next start.
- Changes to an environment apply to new containers. Tasks that already have one show "environment updated"; "Recreate" applies the change while keeping the home volume.
- Environments can be archived. An archived environment cannot be picked for new tasks, but tasks that have it keep working. Only an environment no task uses can be deleted.

## Where things live

| What                         | Where                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Workspace, settings, history | One Docker volume per task, `cc-task-<id>-home`, mounted at `/home/claude`                                     |
| Container                    | `cc-task-<id>`; stopping keeps the volume, only deleting the task removes it                                    |
| Image                        | Shared by every task. After a rebuild, tasks show "image updated" and "Recreate" moves them over, volume intact |
| App config and task list     | `%APPDATA%\cc-container-desktop\config.json` (environments included) / `tasks.json`; API keys in `secrets.json` via the OS encrypted store |

Deleting a task removes its container and volume. With "Export the workspace before deleting" checked, a single item that cannot be exported stops the delete.

### Coming from v0.3 or earlier

The editable Dockerfile, setup.sh and post-create.sh of v0.3 are no longer used (they are left behind in `%APPDATA%\cc-container-desktop\docker`). Whatever setup.sh installed is either part of the base image now or belongs in an environment's setup script. Tasks created with v0.3 show "environment updated"; "Recreate" moves them onto the new base image and their environment.

## Development

```
npm ci
npm run dev        # development mode
npm run check      # format / lint / typecheck / build
npm run e2e:deep   # needs Docker, no API key; runs in a scratch userData with e2e- prefixed tasks
npm run e2e        # needs Docker and CC_E2E_API_KEY
```
