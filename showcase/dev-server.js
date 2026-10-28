import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

/**
 * Local playground server for the Ziki showcase.
 *
 * - Serves the static showcase from `public/`.
 * - Exposes a small, fixed set of demo endpoints that invoke the real
 *   `bin/ziki.js` against one disposable demo repository under the system
 *   temporary directory. There is no generic command endpoint and no
 *   user-supplied path anywhere in the API.
 * - Binds to 127.0.0.1 by default. The hosted Vercel build serves `public/`
 *   only, so the browser UI detects the missing backend and shows local
 *   setup instructions instead of failing silently.
 */

const SHOWCASE_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_PUBLIC_ROOT = path.resolve(SHOWCASE_ROOT, "public");
const DEFAULT_CLI_ENTRY = path.resolve(SHOWCASE_ROOT, "..", "bin", "ziki.js");
const DEFAULT_WORKSPACE = path.resolve(os.tmpdir(), "ziki-playground");
const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const FIXTURE_FILES = {
  "package.json": `${JSON.stringify(
    {
      name: "ziki-playground-demo",
      private: true,
      scripts: { test: "node --test" },
    },
    null,
    2,
  )}\n`,
  "README.md": "# Ziki playground demo\n\nA disposable repository created by the local playground.\n",
  "src/app.js": "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The playground may only ever touch a workspace created under the system
 * temporary directory. This guard runs at server creation; there is no HTTP
 * input that can change the workspace.
 */
function assertSafeWorkspace(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!isInside(tmpRoot, resolved)) {
    throw new Error(
      `refusing to use a playground workspace outside the system temp directory: ${resolved}`,
    );
  }
  if (resolved === path.resolve(os.homedir())) {
    throw new Error("refusing to use the home directory as a playground workspace");
  }
  return resolved;
}

/** Run one process with fixed arguments, no shell, and a hard timeout. */
function runProcess(command, args, { cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (error) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "", timedOut: false, error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_OUTPUT_CHARS ? next.slice(0, MAX_OUTPUT_CHARS) : next;
    };

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close handler still settles the promise.
      }
    }, timeoutMs);

    const finish = ({ exitCode, error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        stdout,
        stderr,
        timedOut,
        error: error ?? null,
      });
    };

    child.on("error", (error) => finish({ error }));
    child.on("close", (code) => finish({ exitCode: code }));
  });
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      } else {
        // Keep draining so the response can be delivered after the upload
        // finishes; the request is rejected once the stream ends.
        tooLarge = true;
      }
    });

    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        const error = new Error("request body is too large");
        error.status = 413;
        fail(error);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        settled = true;
        resolvePromise({ value: {}, raw: "" });
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.toLowerCase().startsWith("application/json")) {
        const error = new Error("request body must be JSON");
        error.status = 415;
        fail(error);
        return;
      }
      try {
        const value = JSON.parse(raw);
        settled = true;
        resolvePromise({ value, raw });
      } catch {
        const error = new Error("request body is not valid JSON");
        error.status = 400;
        fail(error);
      }
    });

    req.on("error", (error) => fail(error));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/** Reject cross-site POSTs; the server is same-origin for the local page. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    const host = String(req.headers.host ?? "");
    const localHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host === host &&
      localHostnames.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function createPlaygroundServer({
  workspaceRoot = DEFAULT_WORKSPACE,
  cliEntry = DEFAULT_CLI_ENTRY,
  publicRoot = DEFAULT_PUBLIC_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const workspace = assertSafeWorkspace(workspaceRoot);
  const resolvedPublicRoot = path.resolve(publicRoot);
  const resolvedCliEntry = path.resolve(cliEntry);

  let workspaceReady = null;
  let queue = Promise.resolve();

  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  async function git(cwd, args) {
    const result = await runProcess("git", args, { cwd, timeoutMs: 15_000 });
    if (result.error || result.exitCode !== 0) {
      throw new Error(
        `git ${args[0] ?? ""} failed: ${result.stderr.trim() || result.error?.message || "unknown error"}`,
      );
    }
    return result;
  }

  async function createFixture() {
    await mkdir(workspace, { recursive: true });
    await git(workspace, ["init", "-q"]);
    await git(workspace, ["config", "user.email", "playground@example.invalid"]);
    await git(workspace, ["config", "user.name", "Ziki Playground"]);

    for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
      const target = path.resolve(workspace, relative);
      if (!isInside(workspace, target)) {
        throw new Error(`internal error: fixture path escaped the workspace: ${relative}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }

    await git(workspace, ["add", "."]);
    await git(workspace, ["commit", "-q", "-m", "playground fixture"]);
    return workspace;
  }

  async function ensureWorkspace() {
    if (!workspaceReady) {
      workspaceReady = (async () => {
        if (existsSync(path.join(workspace, ".git"))) {
          return workspace;
        }
        await rm(workspace, { recursive: true, force: true });
        return createFixture();
      })().catch((error) => {
        workspaceReady = null;
        throw error;
      });
    }
    return workspaceReady;
  }

  async function resetWorkspace() {
    await rm(workspace, { recursive: true, force: true });
    workspaceReady = null;
    return ensureWorkspace();
  }

  async function runCli(args) {
    if (!existsSync(resolvedCliEntry)) {
      return { unavailable: true };
    }
    const cwd = await ensureWorkspace();
    return runProcess(process.execPath, [resolvedCliEntry, ...args], {
      cwd,
      timeoutMs,
    });
  }

  function cliPayload(result) {
    if (result.unavailable) {
      return {
        status: 503,
        payload: {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          workspace,
          error: `The ziki-cli entry point was not found at ${resolvedCliEntry}.`,
        },
      };
    }
    const payload = {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      workspace,
    };
    if (result.error) {
      payload.error = result.error.message;
    }
    if (result.timedOut) {
      return { status: 504, payload };
    }
    return { status: 200, payload };
  }

  async function handleApi(req, res, pathname) {
    if (req.method === "GET" && pathname === "/api/health") {
      const cliAvailable = existsSync(resolvedCliEntry);
      const gitCheck = await runProcess("git", ["--version"], {
        cwd: os.tmpdir(),
        timeoutMs: 5_000,
      });
      sendJson(res, 200, {
        backend: true,
        node: process.version,
        workspace,
        cli: { path: resolvedCliEntry, available: cliAvailable },
        git: {
          available: gitCheck.exitCode === 0,
          version: gitCheck.stdout.trim() || null,
        },
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "cross-origin requests are not allowed" });
      return;
    }

    let body;
    try {
      body = (await readJsonBody(req)).value;
    } catch (error) {
      sendJson(res, error.status ?? 400, { ok: false, error: error.message });
      return;
    }

    const operations = {
      "/api/status": () => runCli(["status"]),
      "/api/init/plan": () => runCli(["init"]),
      "/api/review": () => runCli(["review"]),
      "/api/init/apply": () => runCli(["init", "--apply", "--yes"]),
      "/api/reset": async () => {
        await resetWorkspace();
        return {
          exitCode: 0,
          stdout: "Demo workspace reset to its initial fixture.\n",
          stderr: "",
          timedOut: false,
          error: null,
        };
      },
    };

    const operation = operations[pathname];
    if (!operation) {
      sendJson(res, 404, { ok: false, error: "unknown endpoint" });
      return;
    }

    if (pathname === "/api/init/apply" && body.approve !== true) {
      sendJson(res, 400, {
        ok: false,
        error: "explicit approval required: send { \"approve\": true } after showing the plan",
      });
      return;
    }

    try {
      const result = await serialize(operation);
      const { status, payload } = cliPayload(result);
      sendJson(res, status, payload);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        workspace,
        error: error.message,
      });
    }
  }

  async function serveStatic(req, res, pathname) {
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(resolvedPublicRoot, requested);
    if (!isInside(resolvedPublicRoot, file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        sendJson(res, 400, { ok: false, error: "malformed request path" });
        return;
      }

      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      await serveStatic(req, res, pathname);
    } catch {
      sendJson(res, 500, { ok: false, error: "internal error" });
    }
  });

  server.zikiWorkspace = workspace;
  server.zikiCliEntry = resolvedCliEntry;
  return server;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const server = createPlaygroundServer();
  server.listen(port, host, () => {
    console.log(`Ziki playground on http://${host}:${port}`);
    console.log(`Demo workspace: ${server.zikiWorkspace}`);
    console.log("Disposable workspace. Reset it from the page; Ctrl+C stops the server.");
  });
}
