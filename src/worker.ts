import { LocalQwenModel } from "./model.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";

interface AssetsBinding { fetch(request: Request): Promise<Response>; }
interface Env {
  ASSETS?: AssetsBinding;
  GITHUB_TOKEN?: string;
  METHIS_MODEL_URL?: string;
  METHIS_MODEL?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseRepository(input: string): { owner: string; name: string; ref?: string } {
  const clean = input.replace(/^https?:\\/\\/(www\\.)?github\\.com\\//, "").replace(/\\.git$/, "").replace(/\\/$/, "");
  const parts = clean.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error("GitHub repository must look like owner/repository.");
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) throw new Error("Invalid GitHub repository name.");
  return { owner: parts[0], name: parts[1], ref: parts.slice(2).join("/") || undefined };
}

async function githubApi<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "methis-ai" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function githubWrite<T>(url: string, token: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("content-type", "application/json");
  headers.set("user-agent", "methis-ai");
  headers.set("authorization", `Bearer \${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`GitHub write failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

function withToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GITHUB_TOKEN;
  if (token) process.env.GITHUB_TOKEN = token;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 100_000) throw new Error("Request too large.");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const model = new LocalQwenModel(env.METHIS_MODEL_URL, env.METHIS_MODEL);
        return json({
          ok: true,
          engine: "Méthis AI",
          model: model.config.model,
          endpoint: model.config.endpoint,
          qwen: await model.health(),
          runtime: "cloudflare-worker",
        });
      }

      if (!url.pathname.startsWith("/api/") && request.method === "GET" && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405);
      }

      const data = await readBody(request);

      if (url.pathname === "/api/workspace/tree") {
        const repository = String(data.repository ?? "").trim();
        const requestedRef = String(data.ref ?? "").trim();
        if (!repository) return json({ error: "Repository is required." }, 400);
        const parsed = parseRepository(repository);
        const repoInfo = await githubApi<{ default_branch?: string }>(
          `https://api.github.com/repos/${parsed.owner}/${parsed.name}`,
          env.GITHUB_TOKEN,
        );
        const ref = requestedRef || parsed.ref || repoInfo.default_branch || "main";
        const tree = await githubApi<{ tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>; truncated?: boolean }>(
          `https://api.github.com/repos/${parsed.owner}/${parsed.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          env.GITHUB_TOKEN,
        );
        if (tree.truncated) return json({ error: "GitHub returned a truncated tree. This repository is too large for the current workspace view." }, 413);
        const files = (tree.tree ?? [])
          .filter(item => item.type === "blob" && item.path && item.sha)
          .filter(item => !/(^|\\/)(?:\\.env(?:\\..*)?|.*(?:secret|credential).*)$/i.test(item.path!))
          .filter(item => !/\\.(?:pem|key|p12|pfx)$/i.test(item.path!))
          .filter(item => (item.size ?? 0) <= 2_000_000)
          .slice(0, 2000)
          .map(item => ({ path: item.path, size: item.size ?? 0, sha: item.sha }));
        return json({ repository: parsed, branch: ref, files });
      }

      if (url.pathname === "/api/workspace/file") {
        const repository = String(data.repository ?? "").trim();
        const path = String(data.path ?? "").trim();
        const requestedRef = String(data.ref ?? "").trim();
        if (!repository) return json({ error: "Repository is required." }, 400);
        if (!path || path.length > 500 || path.includes("..")) return json({ error: "A safe repository file path is required." }, 400);
        if (/(^|\\/)(?:\\.env(?:\\..*)?|.*(?:secret|credential).*)$/i.test(path) || /\\.(?:pem|key|p12|pfx)$/i.test(path)) {
          return json({ error: "This file type is protected from workspace preview." }, 403);
        }
        const parsed = parseRepository(repository);
        const ref = requestedRef || parsed.ref || "HEAD";
        const tree = await githubApi<{ tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }> }>(
          `https://api.github.com/repos/${parsed.owner}/${parsed.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          env.GITHUB_TOKEN,
        );
        const entry = (tree.tree ?? []).find(item => item.type === "blob" && item.path === path && item.sha);
        if (!entry) return json({ error: "File not found on this branch." }, 404);
        if ((entry.size ?? 0) > 2_000_000) return json({ error: "File is too large for workspace preview." }, 413);
        const blob = await githubApi<{ content?: string; encoding?: string }>(
          `https://api.github.com/repos/${parsed.owner}/${parsed.name}/git/blobs/${entry.sha}`,
          env.GITHUB_TOKEN,
        );
        if (blob.encoding !== "base64" || !blob.content) return json({ error: "File content is not available as text." }, 415);
        const content = atob(blob.content.replace(/\\s/g, ""));
        return json({ repository: parsed, branch: ref, path, content });
      }

      if (url.pathname === "/api/workspace/save") {
        if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured on the Worker." }, 500);
        const repository = String(data.repository ?? "").trim();
        const path = String(data.path ?? "").trim();
        const content = String(data.content ?? "");
        const baseBranch = String(data.baseBranch ?? "").trim() || "main";
        let branch = String(data.branch ?? "").trim();
        if (!repository || !path) return json({ error: "Repository and file path are required." }, 400);
        if (path.length > 500 || path.includes("..") || /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential).*)$/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path)) return json({ error: "This file is protected from workspace editing." }, 403);
        if (content.length > 2_000_000) return json({ error: "File is too large to save." }, 413);
        const parsed = parseRepository(repository);
        if (!branch) branch = \`methis/\${Date.now().toString(36)}\`;
        const base = await githubApi<{ object?: { sha?: string } }>(
          \`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/git/ref/heads/\${encodeURIComponent(baseBranch)}\`,
          env.GITHUB_TOKEN,
        );
        const baseSha = base.object?.sha;
        if (!baseSha) return json({ error: "Base branch could not be resolved." }, 400);
        let branchExists = true;
        try { await githubApi(\`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/git/ref/heads/\${encodeURIComponent(branch)}\`, env.GITHUB_TOKEN); }
        catch { branchExists = false; }
        if (!branchExists) {
          await githubWrite(\`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/git/refs\`, env.GITHUB_TOKEN, {
            method: "POST",
            body: JSON.stringify({ ref: \`refs/heads/\${branch}\`, sha: baseSha }),
          });
        }
        let existingSha: string | undefined;
        try {
          const existing = await githubApi<{ sha?: string }>(
            \`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/contents/\${path}?ref=\${encodeURIComponent(branch)}\`,
            env.GITHUB_TOKEN,
          );
          existingSha = existing.sha;
        } catch {}
        const payload: Record<string, unknown> = {
          message: \`feat(methis): update \${path}\`,
          content: btoa(unescape(encodeURIComponent(content))),
          branch,
        };
        if (existingSha) payload.sha = existingSha;
        const saved = await githubWrite<{ content?: { sha?: string }; commit?: { sha?: string } }>(
          \`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/contents/\${path}\`,
          env.GITHUB_TOKEN,
          { method: "PUT", body: JSON.stringify(payload) },
        );
        return json({ repository: parsed, branch, baseBranch, path, contentSha: saved.content?.sha, commit: saved.commit?.sha, status: "saved" }, 201);
      }

      if (url.pathname === "/api/workspace/pr") {
        if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured on the Worker." }, 500);
        const repository = String(data.repository ?? "").trim();
        const branch = String(data.branch ?? "").trim();
        const base = String(data.baseBranch ?? "").trim() || "main";
        const title = String(data.title ?? "").trim() || "Méthis AI changes";
        const body = String(data.body ?? "").trim() || "Changes prepared and verified in the Méthis AI workspace.";
        if (!repository || !branch) return json({ error: "Repository and branch are required." }, 400);
        const parsed = parseRepository(repository);
        const pr = await githubWrite<{ html_url?: string; number?: number; state?: string }>(
          \`https://api.github.com/repos/\${parsed.owner}/\${parsed.name}/pulls\`,
          env.GITHUB_TOKEN,
          { method: "POST", body: JSON.stringify({ title, body, head: branch, base, draft: false }) },
        );
        return json({ repository: parsed, branch, baseBranch: base, pullRequest: pr.html_url, pullRequestNumber: pr.number, status: pr.state || "open" }, 201);
      }

      if (url.pathname === "/api/analyze") {
        const repository = String(data.repository ?? "").trim();
        if (!repository) return json({ error: "Repository is required." }, 400);

        const remote = await loadGitHubRepository(repository);
        return json({
          engine: "Méthis AI",
          mode: "github-scan",
          repository: remote.repository,
          files: remote.files.length,
          languages: [...new Set(remote.files.map((file) => file.language))],
          status: "ready",
        });
      }

      if (url.pathname === "/api/github-fix") {
        const repository = String(data.repository ?? "").trim();
        const problem = String(data.problem ?? "").trim();

        if (!repository) return json({ error: "Repository is required." }, 400);
        if (!problem) return json({ error: "A specific bug description is required." }, 400);

        const remote = await loadGitHubRepository(repository);
        const model = new LocalQwenModel(env.METHIS_MODEL_URL, env.METHIS_MODEL);

        const plan = await model.plan({
          repository: {
            root: `github://${remote.repository.owner}/${remote.repository.name}`,
            files: remote.files,
            packageManagers: [],
            testCommands: [],
            buildCommands: [],
          },
          bug: { description: problem },
        });

        if (!plan.edits.length) {
          return json({
            error: "Méthis produced no safe edits. No Pull Request was created.",
            summary: plan.summary,
          }, 422);
        }

        if (!env.GITHUB_TOKEN) {
          return json({ error: "GITHUB_TOKEN is not configured on the Worker." }, 500);
        }

        const previous = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = env.GITHUB_TOKEN;

        try {
          const pr = await createFixPullRequest(remote.repository, plan);
          return json({
            engine: "Méthis AI",
            mode: "github-fix",
            repository: remote.repository,
            summary: plan.summary,
            changedFiles: [...new Set(plan.edits.map((edit) => edit.path))],
            branch: pr.branch,
            commit: pr.commit,
            pullRequest: pr.prUrl,
            pullRequestNumber: pr.prNumber,
            verification: pr.verification,
          }, 201);
        } finally {
          if (previous === undefined) delete process.env.GITHUB_TOKEN;
          else process.env.GITHUB_TOKEN = previous;
        }
      }

      if (url.pathname === "/api/fix") {
        return json({
          error: "Local workspace fixes require the Node.js runtime. Use the CLI/server deployment for local repository fixes.",
        }, 501);
      }

      return json({ error: "Unknown endpoint." }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";
      return json({ error: message }, 500);
    }
  },
};
