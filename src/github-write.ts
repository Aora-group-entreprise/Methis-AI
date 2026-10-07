import type { GitHubRepository } from "./github.js";

interface RefResponse {
  object: { sha: string };
}

interface CommitResponse {
  sha: string;
  tree: { sha: string };
}

interface ContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
}
interface RepositoryResponse { default_branch?: string; }

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

export async function getDefaultBranch(repository: GitHubRepository): Promise<string> {
  const response = await request<RepositoryResponse>(api(repository, ""), { method: "GET" });
  if (!response.default_branch) throw new Error("GitHub repository has no default branch.");
  return response.default_branch;
}

export async function getBaseRef(repository: GitHubRepository, base: string): Promise<{ sha: string; treeSha: string }> {
  const ref = await request<RefResponse>(api(repository, `/git/ref/heads/${base}`), { method: "GET" });
  const commit = await request<CommitResponse>(api(repository, `/git/commits/${ref.object.sha}`), { method: "GET" });
  return { sha: ref.object.sha, treeSha: commit.tree.sha };
}

export async function fetchFile(
  repository: GitHubRepository,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string }> {
  const response = await request<ContentResponse>(
    api(repository, `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`),
    { method: "GET" },
  );

  if (response.encoding !== "base64" || !response.content || !response.sha) {
    throw new Error(`Unable to read GitHub file: ${path}`);
  }

  return {
    content: Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8"),
    sha: response.sha,
  };
}

export async function createBranch(repository: GitHubRepository, branch: string, sha: string): Promise<void> {
  await request(api(repository, "/git/refs"), {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
}

export async function createTree(
  repository: GitHubRepository,
  elements: Array<Record<string, string>>,
  baseTreeSha: string,
): Promise<{ sha: string }> {
  return request(api(repository, "/git/trees"), {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: elements }),
  });
}

export async function createCommit(
  repository: GitHubRepository,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<{ sha: string }> {
  return request(api(repository, "/git/commits"), {
    method: "POST",
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
}
