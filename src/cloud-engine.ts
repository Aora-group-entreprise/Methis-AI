import { LocalQwenModel } from "./model.js";
import { MethisBrain } from "./brain.js";
import { loadGitHubRepository } from "./github.js";
import type { FixPlan, RepositorySnapshot } from "./types.js";

interface Repo { owner: string; name: string; }
interface Run { id?: number; status?: string; conclusion?: string | null; html_url?: string; head_sha?: string; name?: string; }
interface Job { id?: number; conclusion?: string | null; status?: string; }
interface RefResponse { object?: { sha?: string } }
interface CommitResponse { tree?: { sha?: string } }
interface ContentResponse { content?: string; encoding?: string; sha?: string }

const MAX_ATTEMPTS = 3;
const CI_TIMEOUT_MS = 240_000;
const POLL_MS = 3_000;

function parseRepo(input: string): Repo {
  const clean = input.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    throw new Error("GitHub repository must look like owner/repository.");
  }
  return { owner: parts[0], name: parts[1] };
}
function api(repo: Repo, path: string) {
  return `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`;
}
function headers(token: string) {
  return { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "methis-ai" };
}
async function request<T>(repo: Repo, path: string, token: string, init: RequestInit = { method: "GET" }): Promise<T> {
  const response = await fetch(api(repo, path), { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}
function decode(value: string) { return atob(value.replace(/\s/g, "")); }

async function branchSha(repo: Repo, branch: string, token: string) {
  const ref = await request<RefResponse>(repo, `/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!ref.object?.sha) throw new Error("Branch SHA could not be resolved.");
  return ref.object.sha;
}
async function createBranch(repo: Repo, branch: string, sha: string, token: string) {
  await request(repo, "/git/refs", token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
}
async function applyPlan(repo: Repo, branch: string, plan: FixPlan, token: string) {
  const parent = await branchSha(repo, branch, token);
  const commit = await request<CommitResponse>(repo, `/git/commits/${parent}`, token);
  if (!commit.tree?.sha) throw new Error("Base tree could not be resolved.");

  const tree: Array<Record<string, string>> = [];
  const changed: string[] = [];
  for (const edit of plan.edits) {
    if (edit.path.includes("..") || /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential).*)$/i.test(edit.path) || /\.(?:pem|key|p12|pfx)$/i.test(edit.path)) {
      throw new Error(`Protected path rejected: ${edit.path}`);
    }
    const current = await request<ContentResponse>(repo, `/contents/${edit.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, token);
    if (current.encoding !== "base64" || !current.content) throw new Error(`Unable to read ${edit.path}`);
    const oldContent = decode(current.content);
    if (oldContent.split(edit.oldText).length - 1 !== 1) throw new Error(`Edit for ${edit.path} must match exactly once.`);
    tree.push({ path: edit.path, mode: "100644", type: "blob", content: oldContent.replace(edit.oldText, edit.newText) });
    changed.push(edit.path);
  }

  if (!tree.length) throw new Error("No safe edits were produced.");
  const newTree = await request<{ sha: string }>(repo, "/git/trees", token, { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
  const newCommit = await request<{ sha: string }>(repo, "/git/commits", token, {
    method: "POST",
    body: JSON.stringify({ message: `feat(methis): ${plan.summary.slice(0, 72)}`, tree: newTree.sha, parents: [parent] }),
  });
  await request(repo, `/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha, force: false }) });
  return { commitSha: newCommit.sha, changedFiles: [...new Set(changed)] };
}

async function runForCommit(repo: Repo, sha: string, token: string) {
  const data = await request<{ workflow_runs?: Run[] }>(repo, `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=10`, token);
  return data.workflow_runs?.[0];
}
async function failureLogs(repo: Repo, run: Run, token: string) {
  if (!run.id) return "";
  const jobs = await request<{ jobs?: Job[] }>(repo, `/actions/runs/${run.id}/jobs?per_page=100`, token);
  const output: string[] = [];
  for (const job of (jobs.jobs ?? []).filter((item) => item.conclusion && item.conclusion !== "success").slice(0, 3)) {
    if (!job.id) continue;
    const response = await fetch(api(repo, `/actions/jobs/${job.id}/logs`), {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "methis-ai" },
    });
    if (response.ok) output.push((await response.text()).slice(-40_000));
  }
  return output.join("\n\n").slice(-80_000);
}
async function waitForCI(repo: Repo, sha: string, token: string) {
  const deadline = Date.now() + CI_TIMEOUT_MS;
  let run: Run | undefined;
  while (Date.now() < deadline) {
    run = await runForCommit(repo, sha, token);
    if (run?.status === "completed") {
      const passed = run.conclusion === "success";
      return { passed, run, error: passed ? "" : await failureLogs(repo, run, token) };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { passed: false, run, error: "GitHub Actions did not complete before the Méthis verification timeout." };
}

export async function runCloudMethisEngine(input: {
  repository: string;
  task: string;
  baseBranch: string;
  token: string;
  modelUrl?: string;
  modelName?: string;
  modelToken?: string;
}) {
  const repo = parseRepo(input.repository);
  const branch = `methis/agent-${Date.now().toString(36)}`;
  const baseSha = await branchSha(repo, input.baseBranch, input.token);
  await createBranch(repo, branch, baseSha, input.token);

  const model = new LocalQwenModel(input.modelUrl, input.modelName, input.modelToken);
  let errorOutput = "";
  const attempts: Array<Record<string, unknown>> = [];
  const brain = new MethisBrain(input.task);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remote = await loadGitHubRepository(`${repo.owner}/${repo.name}/${branch}`);
    const snapshot: RepositorySnapshot = {
      root: `github://${repo.owner}/${repo.name}`,
      files: remote.files,
      packageManagers: [],
      testCommands: [],
      buildCommands: [],
    };
    const thinking = await brain.think(snapshot, { description: input.task, errorOutput: errorOutput || undefined }, model);
    const plan = thinking.plan;

    if (!plan.edits.length) {
      return { status: "no-safe-edit", branch, attempts, message: plan.summary };
    }

    const applied = await applyPlan(repo, branch, plan, input.token);
    const ci = await waitForCI(repo, applied.commitSha, input.token);
    attempts.push({
      attempt,
      brain: { confidence: thinking.decision.confidence, risk: thinking.decision.risk, scope: thinking.decision.scope, hypotheses: thinking.decision.hypotheses },
      commit: applied.commitSha,
      changedFiles: applied.changedFiles,
      summary: plan.summary,
      verification: ci.passed ? "passed" : "failed",
      runUrl: ci.run?.html_url,
      error: ci.error ? ci.error.slice(-12_000) : undefined,
    });

    if (ci.passed) {
      const pr = await request<{ html_url?: string; number?: number; state?: string }>(repo, "/pulls", input.token, {
        method: "POST",
        body: JSON.stringify({
          title: `fix: ${plan.summary.slice(0, 70)}`,
          head: branch,
          base: input.baseBranch,
          body: [
            "## Méthis AI",
            "",
            plan.summary,
            "",
            "### Reasoning",
            plan.reasoning,
            "",
            `### Verification\nGitHub Actions passed for commit ${applied.commitSha}.`,
            `Méthis completed ${attempt} verification attempt(s).`,
          ].join("\n"),
          draft: false,
        }),
      });

      return {
        status: "verified",
        branch,
        baseBranch: input.baseBranch,
        commit: applied.commitSha,
        summary: plan.summary,
        reasoning: plan.reasoning,
        brain: thinking.decision,
        changedFiles: applied.changedFiles,
        verification: { runUrl: ci.run?.html_url, workflow: ci.run?.name, conclusion: ci.run?.conclusion },
        pullRequest: pr.html_url,
        pullRequestNumber: pr.number,
        attempts,
      };
    }

    errorOutput = ci.error || "GitHub Actions failed without log output.";
    brain.learnFromFailure(errorOutput);
  }

  return {
    status: "verification-failed",
    branch,
    baseBranch: input.baseBranch,
    attempts,
    message: "Méthis stopped after three repair attempts. No Pull Request was created.",
  };
}
