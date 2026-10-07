import type { RepositoryFile } from "./types.js";

interface GitTreeItem {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitTreeResponse {
  tree?: GitTreeItem[];
  truncated?: boolean;
}

interface GitBlobResponse {
  content?: string;
  encoding?: string;
}

export interface GitHubRepository {
  owner: string;
  name: string;
  ref?: string;
}

const MAX_FILES = 2000;
const MAX_FILE_SIZE = 2_000_000;

function parseRepository(input: string): GitHubRepository {
  const clean = input
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const parts = clean.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error("GitHub repository must look like owner/repository.");
  }

  return { owner: parts[0], name: parts[1], ref: parts[2] };
}

async function githubRequest<T>(url: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "methis-ai",
  };

  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export async function loadGitHubRepository(input: string): Promise<{
  repository: GitHubRepository;
  files: RepositoryFile[];
}> {
  const repository = parseRepository(input);
  const ref = encodeURIComponent(repository.ref ?? "HEAD");
  const treeUrl = `https://api.github.com/repos/${repository.owner}/${repository.name}/git/trees/${ref}?recursive=1`;
  const tree = await githubRequest<GitTreeResponse>(treeUrl);

  if (tree.truncated) {
    throw new Error("GitHub returned a truncated repository tree. Reduce the repository size before using Méthis.");
  }

  const entries = (tree.tree ?? []).filter(
    (item) => item.type === "blob" && item.path && item.sha,
  );

  if (entries.length > MAX_FILES) {
    throw new Error(`Repository exceeds Méthis GitHub limit of ${MAX_FILES} files.`);
  }

  const files: RepositoryFile[] = [];

  for (const entry of entries) {
    if ((entry.size ?? 0) > MAX_FILE_SIZE) continue;

    const blob = await githubRequest<GitBlobResponse>(
      `https://api.github.com/repos/${repository.owner}/${repository.name}/git/blobs/${entry.sha}`,
    );

    if (blob.encoding !== "base64" || !blob.content) continue;

    const content = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
    files.push({
      path: entry.path!,
      size: Buffer.byteLength(content),
      language: languageFor(entry.path!),
      content,
    });
  }

  return { repository, files };
}

function languageFor(path: string): RepositoryFile["language"] {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  return "unknown";
}
