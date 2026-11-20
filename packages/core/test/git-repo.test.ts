import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildRepoView,
  formatRelativeTime,
  inspectGitRepo,
  isPathInsideOrEqual,
  parseGitLogNameOnly,
  parseGitLsTree,
  resolveSafeAbsolutePath,
  resolveSafeRelativeDir,
  type PathApi,
} from "../src/git-repo.js";

const posix = path.posix as PathApi;
const win32 = path.win32 as PathApi;
const now = new Date("2026-11-19T22:00:00.000Z");

test("resolveSafeAbsolutePath accepts absolute and home paths and rejects flags or relative ones", () => {
  assert.equal(resolveSafeAbsolutePath("/workspace/review/nexus", "/home/jeff", posix), "/workspace/review/nexus");
  assert.equal(resolveSafeAbsolutePath("~/projects/nexus", "/home/jeff", posix), "/home/jeff/projects/nexus");
  assert.equal(resolveSafeAbsolutePath("projects/nexus", "/home/jeff", posix), null);
  assert.equal(resolveSafeAbsolutePath("-C", "/home/jeff", posix), null);
  assert.equal(resolveSafeAbsolutePath("/tmp/\0evil", "/home/jeff", posix), null);
  assert.equal(resolveSafeAbsolutePath("C:\\work\\nexus", "C:\\Users\\jeff", win32)?.toLowerCase(), "c:\\work\\nexus");
  assert.equal(resolveSafeAbsolutePath("~\\work", "C:\\Users\\jeff", win32)?.toLowerCase(), "c:\\users\\jeff\\work");
});

test("resolveSafeRelativeDir allows repo-relative folders and rejects traversal or flags", () => {
  assert.equal(resolveSafeRelativeDir(undefined, posix), "");
  assert.equal(resolveSafeRelativeDir("src/core", posix), "src/core");
  assert.equal(resolveSafeRelativeDir("./src", posix), "src");
  assert.equal(resolveSafeRelativeDir("../secret", posix), null);
  assert.equal(resolveSafeRelativeDir("src/../../etc", posix), null);
  assert.equal(resolveSafeRelativeDir("/etc", posix), null);
  assert.equal(resolveSafeRelativeDir("-n", posix), null);
  assert.equal(resolveSafeRelativeDir("foo/-bar", posix), null);
  assert.equal(resolveSafeRelativeDir("C:\\Windows", win32), null);
});

test("isPathInsideOrEqual treats descendants as inside and other drives as outside", () => {
  assert.equal(isPathInsideOrEqual("/repo/src", "/repo", posix), true);
  assert.equal(isPathInsideOrEqual("/repo", "/repo", posix), true);
  assert.equal(isPathInsideOrEqual("/repo-other", "/repo", posix), false);
  assert.equal(isPathInsideOrEqual("/etc", "/repo", posix), false);
  assert.equal(isPathInsideOrEqual("D:\\work", "C:\\work", win32), false);
  assert.equal(isPathInsideOrEqual("C:\\work\\nexus", "C:\\work", win32), true);
});

test("formatRelativeTime uses short English phrases", () => {
  assert.equal(formatRelativeTime("2026-11-19T21:58:00.000Z", now), "2 min ago");
  assert.equal(formatRelativeTime("2026-11-19T21:00:00.000Z", now), "1 hour ago");
  assert.equal(formatRelativeTime("2026-11-18T22:00:00.000Z", now), "1 day ago");
});

test("parseGitLogNameOnly groups files under each commit", () => {
  const commits = parseGitLogNameOnly([
    "aaaaaaaa\tjeff\t2026-11-19T21:58:00-06:00\tfeat: per-window SnapBack",
    "src/core/snapback.ts",
    "src/ui/restore.tsx",
    "",
    "bbbbbbbb\tjeff\t2026-11-19T21:42:00-06:00\tui: restore hint on parked tiles",
    "apps/desktop/src/renderer.ts",
    "",
  ].join("\n"));
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.subject, "feat: per-window SnapBack");
  assert.deepEqual(commits[0]?.files, ["src/core/snapback.ts", "src/ui/restore.tsx"]);
  assert.equal(commits[1]?.author, "jeff");
});

test("buildRepoView lists the selected folder with last-commit metadata and activity", () => {
  const view = buildRepoView({
    repoRoot: "/workspace/nexus",
    branch: "main",
    relativeDir: "src/core",
    files: ["src/core/snapback.ts", "src/core/restore.tsx", "src/core/workspace.ts", "README.md", "package.json"],
    commits: parseGitLogNameOnly([
      "aaaaaaaa\tjeff\t2026-11-19T21:58:00.000Z\tfeat: per-window SnapBack",
      "src/core/snapback.ts",
      "",
      "bbbbbbbb\tjeff\t2026-11-19T21:56:00.000Z\tfeat: add restore hint to parked tiles",
      "src/core/restore.tsx",
      "",
      "cccccccc\tjeff\t2026-11-19T21:42:00.000Z\trefactor: simplify workspace session bookkeeping",
      "src/core/workspace.ts",
      "",
    ].join("\n")),
    now,
    pathApi: posix,
  });
  assert.equal(view.repoName, "nexus");
  assert.deepEqual(view.path, ["nexus", "src", "core"]);
  assert.deepEqual(view.files.map((row) => row.name), ["restore.tsx", "snapback.ts", "workspace.ts"]);
  assert.equal(view.files[1]?.lastCommit?.subject, "feat: per-window SnapBack");
  assert.equal(view.files[1]?.lastCommit?.relative, "2 min ago");
  assert.equal(view.activity[0]?.subject, "feat: per-window SnapBack");
  assert.equal(view.tree[0]?.name, "nexus");
  assert.ok(view.tree[0]?.children?.some((child) => child.name === "src" && child.children?.some((inner) => inner.name === "core")));
});

test("inspectGitRepo runs only allow-listed git args and blocks paths outside the allowed roots", async () => {
  const files = parseGitLsTree("README.md\nsrc/core/snapback.ts\n");
  assert.deepEqual(files, ["README.md", "src/core/snapback.ts"]);
  const calls: string[][] = [];
  const ok = await inspectGitRepo({
    cwd: "/allowed/nexus/src",
    relativeDir: "src/core",
    allowedRoots: ["/allowed/nexus"],
    homeDir: "/home/jeff",
    now,
    pathApi: posix,
    runGit: async (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/allowed/nexus\n";
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "ls-tree") return "src/core/snapback.ts\n";
      return "aaaaaaaa\tjeff\t2026-11-19T21:58:00.000Z\tfeat: per-window SnapBack\nsrc/core/snapback.ts\n";
    },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.view.repoName, "nexus");
    assert.equal(ok.view.files[0]?.name, "snapback.ts");
  }
  assert.deepEqual(calls.map((call) => call.slice(1)), [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["ls-tree", "-r", "--name-only", "HEAD"],
    ["log", "-n", "40", "--date=iso-strict", "--pretty=format:%H%x09%an%x09%ad%x09%s", "--name-only"],
  ]);

  const blocked = await inspectGitRepo({
    cwd: "/etc",
    allowedRoots: ["/allowed/nexus"],
    homeDir: "/home/jeff",
    pathApi: posix,
    runGit: async () => {
      throw new Error("should not run git");
    },
  });
  assert.deepEqual(blocked, { ok: false, error: "not-allowed", message: "working directory is outside the allowed roots" });

  const traversal = await inspectGitRepo({
    cwd: "/allowed/nexus",
    relativeDir: "../secret",
    allowedRoots: ["/allowed/nexus"],
    homeDir: "/home/jeff",
    pathApi: posix,
    runGit: async () => {
      throw new Error("should not run git");
    },
  });
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.error, "invalid-path");
});
