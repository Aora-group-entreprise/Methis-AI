import { scanRepository } from "./scanner.js";
import { MethisPlanningAgent } from "./agent.js";

const root = process.argv[2] ?? process.cwd();
const bug = process.argv.slice(3).join(" ") || "Analyze this repository and identify the smallest safe fix for the reported problem.";

const snapshot = await scanRepository(root);
console.log(`Méthis scanned ${snapshot.files.length} files.`);

if (process.argv.length > 3) {
  const plan = await new MethisPlanningAgent().plan(root, { description: bug });
  console.log(JSON.stringify(plan, null, 2));
} else {
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
