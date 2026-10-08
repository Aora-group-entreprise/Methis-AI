import { LocalQwenModel } from "./model.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";

interface Env {
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
        const model = new LocalQwenModel(
          env.METHIS_MODEL_URL,
          env.METHIS_MODEL,
        );
        return json({
          ok: true,
          engine: "Méthis AI",
          model: model.config.model,
          endpoint: model.config.endpoint,
          qwen: await model.health(),
          runtime: "cloudflare-worker",
        });
      }

      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405);
      }

      const data = await readBody(request);

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
        const model = new LocalQwenModel(
          env.METHIS_MODEL_URL,
          env.METHIS_MODEL,
        );

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
