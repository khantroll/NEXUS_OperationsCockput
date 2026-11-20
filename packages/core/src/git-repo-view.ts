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
