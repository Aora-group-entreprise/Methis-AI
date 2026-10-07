import { LocalQwenModel } from "./model.js";
import { CommandVerifier } from "./verifier.js";
import { MethisEngine } from "./engine.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";

const input = process.argv[2] ?? process.cwd();
const bug = process.argv.slice(3).join(" ") || "Analyze this repository and identify the smallest safe fix for the reported problem.";
const githubInput = input.startsWith("github-fix:")
  ? input.slice("github-fix:".length)
  : input.startsWith("github:")
    ? input.slice("github:".length)
    : input;

if (input.startsWith("github-fix:")) {
  const remote = await loadGitHubRepository(githubInput);
  const repository = {
    root: `github://${remote.repository.owner}/${remote.repository.name}`,
    files: remote.files,
    packageManagers: [],
    testCommands: [],
    buildCommands: [],
  };

  const model = new LocalQwenModel();
  const plan = await model.plan({ repository, bug: { description: bug } });
  if (!plan.edits.length) throw new Error("Méthis produced no edits. No Pull Request was created.");

  const pr = await createFixPullRequest(remote.repository, plan);
  console.log(JSON.stringify({
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
  }, null, 2));
  process.exit(0);
}

if (input.startsWith("github:") || /^https?:\/\/github\.com\//.test(input)) {
  const remote = await loadGitHubRepository(githubInput);
  console.log(JSON.stringify({
    engine: "Méthis AI",
    mode: "github-scan",
    repository: remote.repository,
    files: remote.files.length,
    languages: [...new Set(remote.files.map((file) => file.language))],
  }, null, 2));
  process.exit(0);
}

if (process.argv.length > 3) {
  const engine = new MethisEngine(new LocalQwenModel(), new CommandVerifier());
  const result = await engine.fix(input, { description: bug });
  console.log(JSON.stringify(result, null, 2));
} else {
  const { scanRepository } = await import("./scanner.js");
  const snapshot = await scanRepository(input);
  console.log(`Méthis scanned ${snapshot.files.length} files.`);
  console.log(JSON.stringify({
    engine: "Méthis AI",
    mode: "repository-scan",
    repository: snapshot.root,
    files: snapshot.files.length,
    languages: [...new Set(snapshot.files.map((file) => file.language))],
    packageManagers: snapshot.packageManagers,
    testCommands: snapshot.testCommands,
    buildCommands: snapshot.buildCommands,
  }, null, 2));
}
