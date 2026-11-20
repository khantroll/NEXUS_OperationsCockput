import path from "node:path";
import type { ParsedPath } from "node:path";

export type GitInspectErrorCode = "invalid-path" | "not-allowed" | "not-a-repo" | "git-unavailable" | "timeout";

export interface GitCommitSummary {
  sha: string;
  author: string;
  at: string;
  subject: string;
  relative: string;
}

export interface GitFileRow {
  name: string;
  kind: "file" | "dir";
  path: string;
  lastCommit?: GitCommitSummary;
}

export interface GitTreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: GitTreeNode[];
}

export interface GitRepoView {
  repoRoot: string;
  repoName: string;
  branch: string;
  path: string[];
  relativeDir: string;
  tree: GitTreeNode[];
  files: GitFileRow[];
  activity: GitCommitSummary[];
}

export type GitInspectResult =
  | { ok: true; view: GitRepoView }
  | { ok: false; error: GitInspectErrorCode; message: string };

export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const deltaSec = Math.round((now.getTime() - then.getTime()) / 1000);
  if (deltaSec < 45) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return deltaMin + " min ago";
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return deltaHr === 1 ? "1 hour ago" : deltaHr + " hours ago";
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaDay < 14) return deltaDay === 1 ? "1 day ago" : deltaDay + " days ago";
  return then.toISOString().slice(0, 10);
}

/** Injected so unit tests can exercise POSIX and Win32 rules without touching the disk. */
export interface PathApi {
  sep: string;
  isAbsolute(p: string): boolean;
  resolve(...parts: string[]): string;
  normalize(p: string): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  parse(p: string): ParsedPath;
}

export const GIT_INSPECT_COMMANDS = {
  toplevel: ["rev-parse", "--show-toplevel"],
  branch: ["rev-parse", "--abbrev-ref", "HEAD"],
  files: ["ls-tree", "-r", "--name-only", "HEAD"],
  log: ["log", "-n", "40", "--date=iso-strict", "--pretty=format:%H%x09%an%x09%ad%x09%s", "--name-only"],
} as const;

export function expandUserPath(input: string, homeDir: string, pathApi: PathApi = path): string {
  const trimmed = input.trim();
  if (trimmed === "~") return pathApi.resolve(homeDir);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return pathApi.resolve(pathApi.join(homeDir, trimmed.slice(2)));
  }
  return trimmed;
}

export function isUnsafePathInput(input: string): boolean {
  if (input.length === 0 || input.length > 4096) return true;
  if (input.startsWith("-")) return true;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function resolveSafeAbsolutePath(input: string, homeDir: string, pathApi: PathApi = path): string | null {
  if (isUnsafePathInput(input)) return null;
  const expanded = expandUserPath(input, homeDir, pathApi);
  if (isUnsafePathInput(expanded) || !pathApi.isAbsolute(expanded)) return null;
  const resolved = pathApi.resolve(expanded);
  if (!pathApi.isAbsolute(resolved) || resolved.startsWith("-")) return null;
  return resolved;
}

/** True when `child` is `parent` or a descendant of it. Different drive letters are never inside. */
export function isPathInsideOrEqual(child: string, parent: string, pathApi: PathApi = path): boolean {
  const left = pathApi.resolve(child);
  const right = pathApi.resolve(parent);
  if (left === right) return true;
  const relative = pathApi.relative(right, left);
  if (!relative || relative === ".." || relative.startsWith(".." + pathApi.sep)) return false;
  if (pathApi.isAbsolute(relative)) return false;
  return true;
}

export function resolveSafeRelativeDir(input: string | undefined, pathApi: PathApi = path): string | null {
  if (input === undefined || input === "" || input === ".") return "";
  if (isUnsafePathInput(input)) return null;
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (pathApi.isAbsolute(normalized) || pathApi.isAbsolute(input)) return null;
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  if (parts.some((part) => part === "." || part === ".." || part === "-" || part.startsWith("-"))) return null;
  return parts.join("/");
}

export function isFilesystemRoot(input: string, pathApi: PathApi = path): boolean {
  const parsed = pathApi.parse(pathApi.resolve(input));
  return parsed.root === pathApi.resolve(input) || parsed.dir === parsed.root && parsed.base === "";
}

export interface ParsedGitCommit {
  sha: string;
  author: string;
  at: string;
  subject: string;
  files: string[];
}

/** Parse `git log --name-only --pretty=format:%H\\t%an\\t%ad\\t%s`. */
export function parseGitLogNameOnly(output: string): ParsedGitCommit[] {
  const commits: ParsedGitCommit[] = [];
  let current: ParsedGitCommit | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) {
      current = null;
      continue;
    }
    if (line.includes("\t")) {
      const [sha, author, at, ...subjectParts] = line.split("\t");
      if (sha && author && at && /^[0-9a-f]{7,40}$/i.test(sha)) {
        current = { sha, author, at, subject: subjectParts.join("\t"), files: [] };
        commits.push(current);
        continue;
      }
    }
    if (current && !line.startsWith("-")) current.files.push(line.replace(/\\/g, "/"));
  }
  return commits;
}

export function parseGitLsTree(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\\/g, "/").trim())
    .filter((line) => line.length > 0 && !line.startsWith("-") && !line.includes("\0"));
}

function lastCommitByPath(commits: readonly ParsedGitCommit[], now: Date): Map<string, GitCommitSummary> {
  const map = new Map<string, GitCommitSummary>();
  for (const commit of commits) {
    const summary: GitCommitSummary = {
      sha: commit.sha,
      author: commit.author,
      at: commit.at,
      subject: commit.subject,
      relative: formatRelativeTime(commit.at, now),
    };
    for (const file of commit.files) {
      if (!map.has(file)) map.set(file, summary);
    }
  }
  return map;
}

function directoryCommit(files: readonly string[], prefix: string, commits: Map<string, GitCommitSummary>): GitCommitSummary | undefined {
  const needle = prefix === "" ? "" : prefix.endsWith("/") ? prefix : prefix + "/";
  let latest: GitCommitSummary | undefined;
  for (const [file, commit] of commits) {
    if (needle === "" || file.startsWith(needle) || file === prefix) {
      if (!latest || Date.parse(commit.at) > Date.parse(latest.at)) latest = commit;
    }
  }
  return latest;
}


function fileRow(name: string, kind: "file" | "dir", pathName: string, lastCommit?: GitCommitSummary): GitFileRow {
  return lastCommit === undefined ? { name, kind, path: pathName } : { name, kind, path: pathName, lastCommit };
}

export function buildRepoView(options: {
  repoRoot: string;
  branch: string;
  relativeDir: string;
  files: readonly string[];
  commits: readonly ParsedGitCommit[];
  now?: Date;
  pathApi?: PathApi;
}): GitRepoView {
  const pathApi = options.pathApi ?? path;
  const now = options.now ?? new Date();
  const relativeDir = options.relativeDir;
  const commitsByFile = lastCommitByPath(options.commits, now);
  const repoName = pathApi.basename(options.repoRoot) || "repo";
  const pathParts = relativeDir === "" ? [] : relativeDir.split("/");

  const treeChildren = (prefix: string): GitTreeNode[] => {
    const names = new Map<string, "file" | "dir">();
    const needle = prefix === "" ? "" : prefix + "/";
    for (const file of options.files) {
      if (needle && !file.startsWith(needle)) continue;
      const rest = needle ? file.slice(needle.length) : file;
      const [name, ...restParts] = rest.split("/");
      if (!name) continue;
      const kind = restParts.length > 0 ? "dir" : "file";
      if (kind === "file" && prefix !== "") continue;
      names.set(name, kind);
    }
    return [...names.entries()]
      .sort((a, b) => Number(b[1] === "dir") - Number(a[1] === "dir") || a[0].localeCompare(b[0]))
      .map(([name, kind]) => {
        const nodePath = prefix ? prefix + "/" + name : name;
        const node: GitTreeNode = { name, path: nodePath, kind };
        if (kind === "dir" && (relativeDir === nodePath || relativeDir.startsWith(nodePath + "/"))) {
          node.children = treeChildren(nodePath);
        }
        return node;
      });
  };

  const files: GitFileRow[] = [];
  const seen = new Set<string>();
  const needle = relativeDir === "" ? "" : relativeDir + "/";
  for (const file of options.files) {
    if (needle && !file.startsWith(needle) && file !== relativeDir) continue;
    if (!needle && file.includes("/")) {
      const top = file.split("/")[0];
      if (!top || seen.has(top + "/")) continue;
      seen.add(top + "/");
      const dirPath = top;
      files.push(fileRow(top, "dir", dirPath, directoryCommit(options.files, dirPath, commitsByFile)));
      continue;
    }
    const rest = needle ? file.slice(needle.length) : file;
    if (!rest || rest === "") continue;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const dirName = rest.slice(0, slash);
      const dirPath = relativeDir ? relativeDir + "/" + dirName : dirName;
      if (seen.has(dirPath)) continue;
      seen.add(dirPath);
      files.push(fileRow(dirName, "dir", dirPath, directoryCommit(options.files, dirPath, commitsByFile)));
      continue;
    }
    files.push(fileRow(rest, "file", file, commitsByFile.get(file)));
  }
  files.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));

  const activity: GitCommitSummary[] = options.commits.slice(0, 12).map((commit) => ({
    sha: commit.sha,
    author: commit.author,
    at: commit.at,
    subject: commit.subject,
    relative: formatRelativeTime(commit.at, now),
  }));

  const rootNode: GitTreeNode = {
    name: repoName,
    path: "",
    kind: "dir",
    children: treeChildren(""),
  };

  return {
    repoRoot: options.repoRoot,
    repoName,
    branch: options.branch,
    path: [repoName, ...pathParts],
    relativeDir,
    tree: [rootNode],
    files,
    activity,
  };
}

export async function inspectGitRepo(options: {
  cwd: string;
  relativeDir?: string;
  allowedRoots: readonly string[];
  homeDir: string;
  now?: Date;
  pathApi?: PathApi;
  runGit: (cwd: string, args: readonly string[]) => Promise<string>;
}): Promise<GitInspectResult> {
  const pathApi = options.pathApi ?? path;
  const relativeDir = resolveSafeRelativeDir(options.relativeDir, pathApi);
  if (relativeDir === null) return { ok: false, error: "invalid-path", message: "directory path is not allowed" };

  const requested = resolveSafeAbsolutePath(options.cwd, options.homeDir, pathApi);
  if (!requested) return { ok: false, error: "invalid-path", message: "working directory path is not allowed" };

  const allowed = options.allowedRoots
    .map((root) => resolveSafeAbsolutePath(root, options.homeDir, pathApi))
    .filter((root): root is string => root !== null);
  const permitted = allowed.some((root) => isPathInsideOrEqual(requested, root, pathApi));
  if (!permitted) return { ok: false, error: "not-allowed", message: "working directory is outside the allowed roots" };

  let repoRoot: string;
  try {
    repoRoot = (await options.runGit(requested, GIT_INSPECT_COMMANDS.toplevel)).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed? ?out/i.test(message)) return { ok: false, error: "timeout", message: "git inspect timed out" };
    if (/not a git repository/i.test(message)) return { ok: false, error: "not-a-repo", message: "not a git repository" };
    if (/ENOENT|not recognized|not found/i.test(message)) return { ok: false, error: "git-unavailable", message: "git is not available" };
    return { ok: false, error: "not-a-repo", message };
  }

  const resolvedRoot = resolveSafeAbsolutePath(repoRoot, options.homeDir, pathApi);
  if (!resolvedRoot || isFilesystemRoot(resolvedRoot, pathApi)) {
    return { ok: false, error: "not-allowed", message: "refusing to inspect a filesystem-root git repository" };
  }
  const allowedInRepo = allowed.some((root) => isPathInsideOrEqual(root, resolvedRoot, pathApi));
  if (!allowedInRepo) return { ok: false, error: "not-allowed", message: "repository is outside the allowed roots" };
  if (!isPathInsideOrEqual(requested, resolvedRoot, pathApi)) {
    return { ok: false, error: "not-allowed", message: "working directory is outside the repository" };
  }

  try {
    const [branchRaw, filesRaw, logRaw] = await Promise.all([
      options.runGit(resolvedRoot, GIT_INSPECT_COMMANDS.branch),
      options.runGit(resolvedRoot, GIT_INSPECT_COMMANDS.files),
      options.runGit(resolvedRoot, GIT_INSPECT_COMMANDS.log),
    ]);
    return {
      ok: true,
      view: buildRepoView({
        repoRoot: resolvedRoot,
        branch: branchRaw.trim() || "HEAD",
        relativeDir,
        files: parseGitLsTree(filesRaw),
        commits: parseGitLogNameOnly(logRaw),
        pathApi,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed? ?out/i.test(message)) return { ok: false, error: "timeout", message: "git inspect timed out" };
    return { ok: false, error: "git-unavailable", message };
  }
}
