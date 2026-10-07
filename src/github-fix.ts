import type { FixPlan } from "./types.js";
import type { GitHubRepository } from "./github.js";
import { createBranch, createCommit, createTree, getBaseRef, fetchFile } from "./github-write.js";

export interface PullRequestResult {
  branch: string;
  commit: string;
  prUrl: string;
  prNumber: number;
  verification: "static-only";
}

function api(repository: GitHubRepository, path: string): string {
  return `https://api.github.com/repos/${repository.owner}/${repository.name}${path}`;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required for GitHub write operations.");
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "methis-ai",
  };
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function branchName(): string {
  return `methis/fix-${Date.now().toString(36)}`;
}

function applyEditsToContent(path: string, content: string, edits: FixPlan["edits"]): string {
  let result = content;
  for (const edit of edits.filter((item) => item.path === path)) {
    const occurrences = result.split(edit.oldText).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Remote patch for ${path} must match exactly once.`);
    }
    result = result.replace(edit.oldText, edit.newText);
  }
  return result;
}

export async function createFixPullRequest(
  repository: GitHubRepository,
  plan: FixPlan,
): Promise<PullRequestResult> {
  const base = repository.ref && repository.ref !== "HEAD" ? repository.ref : "main";
  const baseRef = await getBaseRef(repository, base);
  const branch = branchName();

  await createBranch(repository, branch, baseRef.sha);

  const paths = [...new Set(plan.edits.map((edit) => edit.path))];
  const treeElements: Array<Record<string, string>> = [];

  for (const path of paths) {
    const file = await fetchFile(repository, path, base);
    const content = applyEditsToContent(path, file.content, plan.edits);
    treeElements.push({
      path,
      mode: "100644",
      type: "blob",
      content,
    });
  }

  const tree = await createTree(repository, treeElements, baseRef.treeSha);
  const commit = await createCommit(repository, `fix: ${plan.summary.slice(0, 72)}`, tree.sha, baseRef.sha);

  const pr = await request<{ html_url: string; number: number }>(api(repository, "/pulls"), {
    method: "POST",
    body: JSON.stringify({
      title: `fix: ${plan.summary.slice(0, 70)}`,
      head: branch,
      base,
      body: [
        "## Méthis AI",
        "",
        plan.summary,
        "",
        "### Reasoning",
        plan.reasoning,
        "",
        "### Verification",
        "Static patch validation passed against the current base files.",
        "",
        "This PR contains one Méthis commit and remains a draft until repository CI passes.",
      ].join("\n"),
      draft: true,
    }),
  });

  return {
    branch,
    commit: commit.sha,
    prUrl: pr.html_url,
    prNumber: pr.number,
    verification: "static-only",
  };
}
