import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RepositoryFile, RepositorySnapshot, SupportedLanguage } from "./types.js";

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

function languageFor(path: string): SupportedLanguage {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  return "unknown";
}

async function walk(root: string, current: string, files: RepositoryFile[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(full);
    if (info.size > 2_000_000) continue;
    files.push({ path: relative(root, full), size: info.size, language: languageFor(full) });
  }
}

export async function scanRepository(root: string): Promise<RepositorySnapshot> {
  const files: RepositoryFile[] = [];
  await walk(root, root, files);

  const packageManagers: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];

  if (files.some(f => f.path === "package.json")) {
    packageManagers.push("npm/pnpm/yarn");
    try {
      const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const scripts = packageJson.scripts ?? {};
      if (scripts.test) testCommands.push("npm test");
      if (scripts.typecheck) testCommands.push("npm run typecheck");
      if (scripts.build) buildCommands.push("npm run build");
    } catch {
      // Invalid package.json is itself useful evidence for the agent.
    }
  }

  if (files.some(f => f.path === "pyproject.toml" || f.path === "requirements.txt")) {
    packageManagers.push("python");
  }
  if (files.some(f => f.path === "go.mod")) packageManagers.push("go");
  if (files.some(f => f.path === "Cargo.toml")) packageManagers.push("cargo");

  return { root, files, packageManagers, testCommands, buildCommands };
}
