import type { FixPlan } from "./types.js";
import type { GitHubRepository } from "./github.js";

interface RefResponse { object: { sha: string } }
interface CommitResponse { sha: string; tree: { sha: string } }
interface PullResponse { html_url: string; number: number; draft?: boolean }

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

function api(repo: GitHubRepository, path: string): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`;
}

function branchName(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `methis/fix-${stamp}`;
}

export async function createFixPullRequest(
  repository: GitHubRepository,
  plan: FixPlan,
): Promise<{ branch: string; commit: string; prUrl: string; prNumber: number }> {
  const base = repository.ref && repository.ref !== "HEAD" ? repository.ref : "main";
  const baseRef = await request<RefResponse>(api(repository, `/git/ref/heads/${encodeURIComponent(base)}`), {
    method: "GET",
  });
  const baseSha = baseRef.object.sha;
  const branch = branchName();

  await request(api(repository, "/git/refs"), {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  const treeItems: Array<Record<string, string>> = [];
  for (const change of plan.changes) {
    const blob = await request<{ sha: string }>(api(repository, "/git/blobs"), {
      method: "POST",
      body: JSON.stringify({ content: change.content, encoding: "utf-8" }),
    });
    treeItems.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const baseCommit = await request<CommitResponse>(api(repository, `/git/commits/${baseSha}`), {
    method: "GET",
  });

  const tree = await request<{ sha: string }>(api(repository, "/git/trees"), {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeItems }),
  });

  const commit = await request<{ sha: string }>(api(repository, "/git/commits"), {
    method: "POST",
    body: JSON.stringify({
      message: `fix: ${plan.summary.slice(0, 72)}`,
      tree: tree.sha,
      parents: [baseSha],
    }),
  });

  await request(api(repository, `/git/refs/heads/${encodeURIComponent(branch)}`), {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  const pr = await request<PullResponse>(api(repository, "/pulls"), {
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
        "This PR was created by Méthis on an isolated branch.",
        "Repository CI should be used as the final verification gate before merge.",
      ].join("\n"),
      draft: true,
    }),
  });

  return { branch, commit: commit.sha, prUrl: pr.html_url, prNumber: pr.number };
}
