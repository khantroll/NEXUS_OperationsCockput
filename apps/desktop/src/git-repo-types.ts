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
