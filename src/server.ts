import { createServer } from "node:http";
import { LocalQwenModel } from "./model.js";
import { CommandVerifier } from "./verifier.js";
import { MethisEngine } from "./engine.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";
import { resolve, relative, isAbsolute, sep } from "node:path";

const model = new LocalQwenModel();
const engine = new MethisEngine(model, new CommandVerifier());
const port = Number(process.env.PORT || 3000);

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  if (raw.length > 100_000) throw new Error("Request too large.");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function api(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      const qwen = await model.health();
      return json(res, 200, {
        ok: true,
        engine: "Méthis AI",
        model: model.config.model,
        endpoint: model.config.endpoint,
        qwen,
      });
    }

    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

    const data = await body(req);

    if (req.url === "/api/analyze") {
      const repository = String(data.repository ?? "").trim();
      if (!repository) return json(res, 400, { error: "Repository is required." });

      const remote = await loadGitHubRepository(repository);
      const languages = [...new Set(remote.files.map((file) => file.language))];

      return json(res, 200, {
        engine: "Méthis AI",
        model: model.config.model,
        mode: "github-scan",
        repository: remote.repository,
        files: remote.files.length,
        languages,
        status: "ready",
      });
    }

    if (req.url === "/api/github-fix") {
      const repository = String(data.repository ?? "").trim();
      const problem = String(data.problem ?? "").trim();

      if (!repository) return json(res, 400, { error: "Repository is required." });
      if (!problem) return json(res, 400, { error: "A specific bug description is required." });

      const remote = await loadGitHubRepository(repository);
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
        return json(res, 422, {
          error: "Méthis produced no safe edits. No Pull Request was created.",
          summary: plan.summary,
        });
      }

      const pr = await createFixPullRequest(remote.repository, plan);
      return json(res, 201, {
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
      });
    }

    if (req.url === "/api/fix") {
      const local = String(data.localPath ?? "").trim();
      const bug = String(data.problem ?? "").trim();

      if (process.env.METHIS_ENABLE_LOCAL_FIX !== "true") {
        return json(res, 403, { error: "Local verified fixes are disabled. Enable METHIS_ENABLE_LOCAL_FIX=true." });
      }
      if (!local) return json(res, 400, { error: "A local workspace path is required." });
      if (!bug) return json(res, 400, { error: "A specific bug description is required." });

      const configuredRoot = process.env.METHIS_WORKSPACE_ROOT;
      if (!configuredRoot) return json(res, 500, { error: "METHIS_WORKSPACE_ROOT is not configured." });

      const workspaceRoot = resolve(configuredRoot);
      const target = resolve(local);
      const rel = relative(workspaceRoot, target);

      if (rel.startsWith(".." + sep) || isAbsolute(rel)) {
        return json(res, 403, { error: "The requested workspace is outside the configured Méthis workspace root." });
      }

      const result = await engine.fix(target, { description: bug });
      return json(res, result.verified ? 200 : 422, result.verified ? result : { ...result, error: "Méthis could not verify the fix." });
    }

    return json(res, 404, { error: "Unknown endpoint." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    return json(res, 500, { error: message });
  }
}

createServer((req, res) => {
  if ((req.url || "").startsWith("/api/")) return api(req, res);
  return json(res, 404, { error: "Méthis AI engine server. Use the /api endpoints." });
}).listen(port, () => {
  console.log(`Méthis AI engine listening on http://localhost:${port}`);
});
