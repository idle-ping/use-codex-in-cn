# Multi-user runtime and Codex account modes

## Purpose

Allow several users to use one Codex WebUI deployment while each user receives an independent filesystem root and sees only their own projects and Sessions. The deployment must support two Codex account modes selected through server settings:

- `shared`: all users use one server-managed Codex credential and share its quota.
- `per-user`: each user is assigned an independent Codex credential and quota.

The default rollout mode is `shared`. Changing the account mode is an administrator operation and never comes from the browser.

## Current limitations

The current server is effectively single-user:

- Authentication is a single password or access token and does not produce a user identity.
- One Codex app-server connection and one `CODEX_HOME` are shared by all clients.
- Session notifications are broadcast to every connected browser.
- Project visibility, conversation history, goals, queues, attachments and caches are process-wide.
- File browsing, terminal, review and workspace APIs validate against global roots.

Adding a login form without changing these boundaries would allow cross-user Session and filesystem exposure.

## User and storage model

Each user has a stable internal ID and an assigned root:

```text
/srv/codex-webui/users/<user-id>/
  workspace/       # projects visible to the user
  codex-home/      # Codex sessions and history
  uploads/         # user attachments
  tmp/             # user temporary files
  metadata/        # project visibility and user settings
```

The browser never chooses the root. The server resolves every project, attachment, terminal and review path beneath the authenticated user's root after `realpath` resolution. Symlink escapes, `..` escapes and arbitrary absolute paths are rejected.

The existing single-user data is migrated into an administrator or first-user directory. Migration is explicit and must not silently expose the old shared directory to every new user.

The repository provides `bun run migrate:single-user`. It requires
`CODEX_WEBUI_MIGRATION_PASSWORD` and a target `--username`; source paths may be
overridden with `--source-home` and `--source-workspace`. The command copies
Codex state, workspace files and uploads, materializes symlinks inside the new
root, writes a mode `0600` migration marker, and leaves the source untouched so
the migration can be audited or rolled back.

## Runtime isolation

Introduce a `UserRuntime` boundary keyed by authenticated `userId`. A runtime owns:

- Codex app-server connection or process.
- `CODEX_HOME` and session root.
- Conversation history cache and revision state.
- Project visibility store.
- Goal and queue recovery state.
- Attachment, file, image and review roots.
- Connected browser clients and pending Codex requests.

Notifications and server requests are delivered only to clients attached to the owning runtime. A browser-supplied `threadId`, `cwd` or project path is checked against the authenticated runtime before use.

The implementation uses one Codex app-server worker per user. It gives clear
process and credential boundaries. A shared WebUI control process supervises
workers, routes RPC through the authenticated user context, and filters thread
notifications, approvals and SSE/WS streams by user.

## Codex account modes

### Shared account

The control plane keeps one Codex credential in server-managed secret storage. Each user still gets an isolated `UserRuntime`, `CODEX_HOME` and filesystem root. The credential is injected into the user's worker and is never sent to the browser.

This mode has one shared quota, shared model availability and shared provider concurrency. It is the first rollout target.

### Per-user account

Each user has an encrypted credential reference. The worker loads only that user's credential and reports account status and limits to that user. Login, logout, token refresh and credential revocation are user-scoped.

The runtime and filesystem design stays the same; only credential selection changes. This keeps the account mode switch behind one runtime interface instead of spreading account logic through the UI.

The worker accepts a server-managed shared credential reference (or the
existing server `CODEX_HOME/auth.json` as the default source) and copies it into
the worker's private `CODEX_HOME`. Per-user mode intentionally does not copy a
shared credential; each worker uses its own Codex login state.

## Authentication and authorization

The password session must contain an authenticated user ID. Every HTTP request, WebSocket, SSE stream, terminal connection and RPC request resolves that identity server-side.

Authorization checks are required before:

- Returning `thread/list`, `thread/read` or history data.
- Starting, resuming, forking, deleting or steering a Session.
- Reading or searching files.
- Uploading or downloading attachments.
- Opening a terminal.
- Applying a review patch.
- Reading or changing project visibility, Goal and queue state.

The browser stores no Codex credential and cannot select another user runtime.

## Settings

Administrator settings should expose:

- Multi-user enabled/disabled.
- User account management.
- User root base directory.
- Codex account mode: `shared` or `per-user`.
- Shared credential reference, when applicable.
- Per-user credential assignment, when applicable.
- Per-user disk and concurrency quotas.

Changing account mode affects newly created workers first. Existing workers are drained and restarted before the mode is considered active.

## Rollout phases

1. Add user identity and server-side authorization context while keeping single-user behavior behind a default user.
2. Create the user root and path authorization layer.
3. Extract `UserRuntime` from global Codex, history, project, goal, queue and attachment state.
4. Route notifications and pending requests by runtime.
5. Run the shared-account mode with one worker per user.
6. Add encrypted per-user credential references and the per-user account mode.
7. Migrate existing data and add operational quotas, cleanup and audit logging.

## Acceptance criteria

- User A cannot list, open, search, download or modify User B's projects, files or Sessions.
- A notification, approval request or queue update for User A never appears in User B's browser.
- Both account modes work without changing the browser API.
- A worker restart affects only that user's runtime.
- Symlink and path traversal tests pass for file, terminal, attachment and review endpoints.
- Existing single-user data remains accessible only to its assigned user after migration.
