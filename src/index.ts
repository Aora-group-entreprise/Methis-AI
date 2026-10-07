import { scanRepository } from "./scanner.js";
import { LocalQwenModel } from "./model.js";
import { CommandVerifier } from "./verifier.js";
import { MethisEngine } from "./engine.js";
import { loadGitHubRepository } from "./github.js";

const input = process.argv[2] ?? process.cwd();
const bug = process.argv.slice(3).join(" ") || "Analyze this repository and identify the smallest safe fix for the reported problem.";
const githubInput = input.startsWith("github:") ? input.slice("github:".length) : input;

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

  console.log(JSON.stringify({
    summary: result.plan.summary,
    reasoning: result.plan.reasoning,
    changedFiles: result.changedFiles,
    verification: result.verification,
    diff: result.diff,
  }, null, 2));
} else {
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
