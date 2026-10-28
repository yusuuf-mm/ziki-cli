# Ziki project page

A light, project-centered experience for Yusuf Musa and the Ziki CLI. Visitors can switch or add project names, manage a local roster of agents by person and role, and explore sample output for `status`, `init`, and `review`. Project and agent edits are saved only in browser storage. The page does not connect to a repository, execute a shell command, or communicate with agents.

## Run locally

Requires Node.js 20 or newer. From this directory:

```sh
npm start
```

Open `http://localhost:3000`. The page has no runtime dependencies. Google Fonts are optional; the system font fallbacks work offline.

## Deploy to Vercel

Import the repository in Vercel and set the project root to `showcase`. No build command or output directory is needed. The included Node start script also supports a generic Node host.

CLI behavior is described in the parent repository's README and schema documentation. The terminal accepts only the three documented command names and returns illustrative output; it never executes them. This is a local prototype, not a live CLI integration.
