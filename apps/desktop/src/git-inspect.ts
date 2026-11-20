import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { inspectGitRepo, type GitInspectResult } from "@nexus/core/git-repo";

const execFileAsync = promisify(execFile);

/**
 * Read-only git inspect for the Metro repo tile. The renderer may only supply a cwd and an optional
 * repo-relative folder; argv is always a fixed allow-list and is never built with string interpolation.
 */
export async function runGitInspect(input: { cwd?: unknown; relativeDir?: unknown }, allowedRoots: readonly string[]): Promise<GitInspectResult> {
  const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : (allowedRoots[0] ?? process.cwd());
  const relativeDir = typeof input.relativeDir === "string" ? input.relativeDir : "";
  return inspectGitRepo({
    cwd,
    relativeDir,
    allowedRoots: allowedRoots.length > 0 ? allowedRoots : [process.cwd()],
    homeDir: os.homedir(),
    runGit: async (gitCwd, args) => {
      const { stdout } = await execFileAsync("git", [...args], {
        cwd: gitCwd,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      });
      return stdout;
    },
  });
}
