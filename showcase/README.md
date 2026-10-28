# Ziki project page

A light, project-centered experience for Yusuf Musa and the Ziki CLI. Visitors can switch or add project names, manage a local roster of agents by person and role, and explore sample output for `status`, `init`, and `review`. Project and agent edits are saved only in browser storage.

The page has two clearly separated halves:

- **Sample mode** (the command tabs and terminal) replays illustrative output. It never executes anything and says so.
- **Local playground** runs the repository's real `bin/ziki.js` through the local dev server against a disposable demo repository under your system temp directory. It is only available when you start the server yourself; the deployed Vercel page stays a read-only static showcase and shows setup instructions instead.

## Run locally

Requires Node.js 20 or newer and Git. From this directory:

```sh
npm start
```

Open `http://localhost:3000`. The server binds to `127.0.0.1` by default.

### Try the playground

1. Click **Local playground** (top right) to jump to the panel.
2. **Run status** — real `ziki status` output for the demo repository.
3. **Plan init** — real `ziki init` plan; nothing is written.
4. **Approve & apply** — asks for confirmation, then runs `ziki init --apply --yes` with the CLI's normal rules. Existing or changed files would still require the CLI's own `--confirm` flags; the playground never adds them automatically.
5. **Run review** — real `ziki review` output, read-only.
6. **Reset demo** — confirms, then recreates the disposable workspace.

The panel shows the demo workspace path. That directory lives in the system temp folder (for example `$TMPDIR/ziki-playground` or `%TEMP%\ziki-playground`), is created for this demo only, and is safe to delete. The server accepts no filesystem path from the browser and exposes only the fixed demo operations.

## Deploy to Vercel

Import the repository in Vercel and set the project root to `showcase`. Vercel serves the static files from `public`; no build command is needed. The local Node server is named `dev-server.js` so Vercel does not mistake it for a production server entry point. The API endpoints exist only while `npm start` is running locally; on the hosted page the playground detects the missing backend and explains how to run it.

CLI behavior is described in the parent repository's README and schema documentation. The sample terminal accepts only the three documented command names and returns illustrative output; it never executes them.
