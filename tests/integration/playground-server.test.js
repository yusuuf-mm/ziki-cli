import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir, write } from "../helpers/repo.js";
import { createPlaygroundServer } from "../../showcase/dev-server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOWCASE = path.resolve(HERE, "../../showcase");

async function startServerIn(t, base, options = {}) {
  const workspaceRoot = path.join(base, "workspace");
  const server = createPlaygroundServer({ workspaceRoot, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    cleanup(base);
  });
  return { base, workspaceRoot, server, url: `http://127.0.0.1:${port}` };
}

async function startServer(t, options = {}) {
  const base = tempDir("ziki-playground-test-");
  return startServerIn(t, base, options);
}

function post(url, endpoint, body = {}, headers = {}) {
  return fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function exists(workspace, relative) {
  return fs.existsSync(path.join(workspace, ...relative.split("/")));
}

test("health reports the backend, CLI, git, and the disposable workspace", async (t) => {
  const { url, workspaceRoot } = await startServer(t);

  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();

  assert.equal(health.backend, true);
  assert.equal(health.cli.available, true);
  assert.equal(health.git.available, true);
  assert.equal(path.resolve(health.workspace), path.resolve(workspaceRoot));
});

test("serves the static showcase from public/", async (t) => {
  const { url } = await startServer(t);

  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="playground"/);
  assert.match(html, /data-playground-action="plan"/);

  const script = await fetch(`${url}/script.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /api\/health/);
});

test("blocks static path traversal attempts", async (t) => {
  const { url } = await startServer(t);

  for (const target of ["/%2e%2e/package.json", "/%2e%2e%2fpackage.json", "/..%2fREADME.md"]) {
    const response = await fetch(`${url}${target}`);
    assert.notEqual(response.status, 200, `${target} must not be served`);
    const body = await response.text();
    assert.equal(body.includes('"name": "ziki-cli"'), false, `${target} leaked package.json`);
  }
});

test("exposes only the fixed demo endpoints", async (t) => {
  const { url } = await startServer(t);

  const exec = await post(url, "/api/exec", { command: "whoami" });
  assert.equal(exec.status, 404);

  const getStatus = await fetch(`${url}/api/status`);
  assert.equal(getStatus.status, 405);

  const unknown = await post(url, "/api/unknown");
  assert.equal(unknown.status, 404);
});

test("rejects cross-origin POST requests", async (t) => {
  const { url } = await startServer(t);

  const response = await post(url, "/api/status", {}, { origin: "http://evil.example" });
  assert.equal(response.status, 403);
});

test("rejects non-JSON, malformed, and oversized bodies", async (t) => {
  const { url } = await startServer(t);

  const text = await fetch(`${url}/api/status`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(text.status, 415);

  const malformed = await fetch(`${url}/api/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(malformed.status, 400);

  const oversized = await post(url, "/api/status", { pad: "x".repeat(20_000) });
  assert.equal(oversized.status, 413);
});

test("requires explicit approval before applying the plan", async (t) => {
  const { url, workspaceRoot } = await startServer(t);

  const missing = await post(url, "/api/init/apply", {});
  assert.equal(missing.status, 400);

  const denied = await post(url, "/api/init/apply", { approve: false });
  assert.equal(denied.status, 400);

  const wrongType = await post(url, "/api/init/apply", { approve: "yes" });
  assert.equal(wrongType.status, 400);

  assert.equal(exists(workspaceRoot, "ziki.json"), false, "nothing may be written without approval");
});

test("runs the real CLI through the full init → status → review flow", async (t) => {
  const { url, workspaceRoot } = await startServer(t);

  const initialStatus = await (await post(url, "/api/status")).json();
  assert.equal(initialStatus.exitCode, 0, initialStatus.stderr);
  assert.match(initialStatus.stdout, /ziki status/);
  assert.match(initialStatus.stdout, /branch/);
  assert.equal(path.resolve(initialStatus.workspace), path.resolve(workspaceRoot));

  const plan = await (await post(url, "/api/init/plan")).json();
  assert.equal(plan.exitCode, 0, plan.stderr);
  assert.match(plan.stdout, /ziki init \(plan\)/);
  assert.match(plan.stdout, /ziki\.json {2}\(new\)/);
  assert.match(plan.stdout, /\.claude\/skills\/ziki\/SKILL\.md/);
  assert.match(plan.stdout, /Summary: 4 files to create\./);
  assert.equal(exists(workspaceRoot, "ziki.json"), false, "plan mode must not write");

  const applied = await (await post(url, "/api/init/apply", { approve: true })).json();
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.equal(exists(workspaceRoot, "ziki.json"), true);
  assert.equal(exists(workspaceRoot, ".claude/skills/ziki/SKILL.md"), true);
  assert.equal(exists(workspaceRoot, ".claude/commands/ziki.md"), true);
  assert.equal(exists(workspaceRoot, ".opencode/commands/ziki.md"), true);

  const statusAfter = await (await post(url, "/api/status")).json();
  assert.equal(statusAfter.exitCode, 0, statusAfter.stderr);
  assert.match(statusAfter.stdout, /claude-skill/);
  assert.match(statusAfter.stdout, /claude-command/);
  assert.match(statusAfter.stdout, /opencode-command/);

  const review = await (await post(url, "/api/review")).json();
  assert.equal(review.exitCode, 0, review.stderr);
  assert.match(review.stdout, /ziki review/);
  assert.match(review.stdout, /ziki\.json/);
  assert.match(review.stdout, /read-only: no files were written/);

  const reset = await (await post(url, "/api/reset")).json();
  assert.equal(reset.ok, true, reset.error);
  assert.equal(exists(workspaceRoot, "ziki.json"), false);
  assert.equal(exists(workspaceRoot, ".claude/skills/ziki/SKILL.md"), false);
  assert.equal(exists(workspaceRoot, "src/app.js"), true, "fixture should be recreated");

  const statusAfterReset = await (await post(url, "/api/status")).json();
  assert.equal(statusAfterReset.exitCode, 0, statusAfterReset.stderr);
  assert.match(statusAfterReset.stdout, /worktree {2}clean/);
});

test("ignores client-supplied paths and never leaves the demo workspace", async (t) => {
  const { url, workspaceRoot } = await startServer(t);

  const response = await post(url, "/api/status", {
    path: "C:\\Windows",
    cwd: "/",
    workspace: "/",
  });
  const doc = await response.json();

  assert.equal(doc.exitCode, 0, doc.stderr);
  assert.equal(path.resolve(doc.workspace), path.resolve(workspaceRoot));
  assert.equal(doc.stdout.includes(workspaceRoot), true, "status must run in the demo workspace");
});

test("reports a missing CLI and refuses operations safely", async (t) => {
  const base = tempDir("ziki-playground-test-");
  const { url } = await startServerIn(t, base, {
    cliEntry: path.join(base, "does-not-exist.js"),
  });

  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.cli.available, false);

  const status = await post(url, "/api/status");
  assert.equal(status.status, 503);
  const payload = await status.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /entry point was not found/);
  assert.equal(payload.workspace, path.join(base, "workspace"));
});

test("surfaces non-zero CLI exits instead of claiming success", async (t) => {
  const base = tempDir("ziki-playground-test-");
  write(base, "fake-cli.js", 'process.stderr.write("intentional failure\\n"); process.exit(7);\n');
  const { url } = await startServerIn(t, base, {
    cliEntry: path.join(base, "fake-cli.js"),
  });

  const response = await post(url, "/api/status");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.exitCode, 7);
  assert.match(payload.stderr, /intentional failure/);
});

test("times out a hanging CLI process", async (t) => {
  const base = tempDir("ziki-playground-test-");
  write(base, "slow-cli.js", "setTimeout(() => {}, 10_000);\n");
  const { url } = await startServerIn(t, base, {
    cliEntry: path.join(base, "slow-cli.js"),
    timeoutMs: 200,
  });

  const response = await post(url, "/api/status");
  assert.equal(response.status, 504);
  const payload = await response.json();
  assert.equal(payload.timedOut, true);
  assert.equal(payload.ok, false);
});

test("refuses to use a workspace outside the system temp directory", () => {
  assert.throws(
    () => createPlaygroundServer({ workspaceRoot: path.resolve(SHOWCASE, "workspace") }),
    /outside the system temp directory/,
  );
  assert.throws(
    () => createPlaygroundServer({ workspaceRoot: os.homedir() }),
    /outside the system temp directory/,
  );
});

test("the hosted showcase stays static and independent of the server", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(SHOWCASE, "vercel.json"), "utf8"));
  assert.equal(vercel.outputDirectory, "public");
  assert.equal(vercel.buildCommand, null);
  assert.equal(vercel.framework, null);

  const script = fs.readFileSync(path.join(SHOWCASE, "public", "script.js"), "utf8");
  assert.match(script, /api\/health/, "page must probe for the local backend");
  assert.match(script, /npm start/, "page must show local setup instructions");
  assert.match(script, /not available on this hosted page/);

  const html = fs.readFileSync(path.join(SHOWCASE, "public", "index.html"), "utf8");
  assert.match(html, /id="playground-note"/);
  assert.equal(html.includes("/api/exec"), false, "no generic execution endpoint may be referenced");
});
