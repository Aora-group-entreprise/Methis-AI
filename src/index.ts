import { scanRepository } from "./scanner.js";

const root = process.argv[2] ?? process.cwd();

const snapshot = await scanRepository(root);

console.log(JSON.stringify({
  engine: "Méthis AI",
  mode: "repository-scan",
  repository: snapshot.root,
  files: snapshot.files.length,
  languages: [...new Set(snapshot.files.map(file => file.language))],
  packageManagers: snapshot.packageManagers,
  testCommands: snapshot.testCommands,
  buildCommands: snapshot.buildCommands
}, null, 2));
