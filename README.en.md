# Claude Code Container Workbench

An Electron app for Windows 11 that runs Claude Code inside Docker. Work is organised as tasks: every task gets its own container and home volume, and picks a profile (endpoint, model, API key) of its own. Nothing — not Node, not Claude Code — gets installed on the host.

[日本語](README.md)

## How it works

1. Start Docker Desktop and build the container image on the Image page (once).
2. Set up an endpoint and API key on the Profiles page.
3. Press "+" at the top of the sidebar to create a task, starting from an empty workspace or a public git repository.
4. "Claude Code" on the task page drops you into a tmux session inside the container. Closing the tab or the app leaves Claude Code running; the same button reattaches.
5. Drop files or folders onto the task page (or use the import buttons) to copy them into the workspace, and "Export" to write the workspace out to a host folder.

## Where things live

| What                        | Where                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Workspace, settings, history | One Docker volume per task, `cc-task-<id>-home`, mounted at `/home/claude`                              |
| Container                   | `cc-task-<id>`; stopping keeps the volume, only deleting the task removes it                             |
| Image                       | Shared by every task. After a rebuild, tasks show "image updated" and "Recreate" moves them over, volume intact |
| App config and task list    | `%APPDATA%\cc-container-desktop\config.json` / `tasks.json`; API keys in `secrets.json` via the OS encrypted store |

Deleting a task removes its container and volume. With "Export the workspace before deleting" checked, a single item that cannot be exported stops the delete.

## Development

```
npm ci
npm run dev        # development mode
npm run check      # format / lint / typecheck / build
npm run e2e:deep   # needs Docker, no API key; runs in a scratch userData with e2e- prefixed tasks
npm run e2e        # needs Docker and CC_E2E_API_KEY
```
