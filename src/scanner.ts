import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RepositoryFile, RepositorySnapshot, SupportedLanguage } from "./types.js";

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache", ".venv"]);
const PROTECTED = /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential).*)$|(?:\.(?:pem|key|p12|pfx))$/i;
const MAX_FILES = 2000;
const MAX_FILE_SIZE = 2_000_000;

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
    const path = relative(root, full).replace(/\\/g, "/");
    if (PROTECTED.test(path)) continue;

    if (entry.isDirectory()) {
      await walk(root, full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(full);
    if (info.size > MAX_FILE_SIZE) continue;

    let content = "";
    try {
      content = await readFile(full, "utf8");
    } catch {
      continue;
    }

    files.push({ path, size: info.size, language: languageFor(path), content });
    if (files.length > MAX_FILES) {
      throw new Error(`Repository exceeds Méthis file limit of ${MAX_FILES} files.`);
    }
  }
}

export function snapshotFromFiles(root: string, files: RepositoryFile[]): RepositorySnapshot {
  const packageFile = files.find((file) => file.path === "package.json");
  const packageManagers: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];

  if (files.some((file) => file.path === "pnpm-lock.yaml")) packageManagers.push("pnpm");
  else if (files.some((file) => file.path === "yarn.lock")) packageManagers.push("yarn");
  else if (packageFile) packageManagers.push("npm");

  if (packageFile) {
    try {
      const packageJson = JSON.parse(packageFile.content) as { scripts?: Record<string, unknown> };
      const scripts = packageJson.scripts ?? {};
      if (typeof scripts.test === "string") testCommands.push(`${packageManagers[0] ?? "npm"} run test`);
      if (typeof scripts.typecheck === "string") testCommands.push(`${packageManagers[0] ?? "npm"} run typecheck`);
      if (typeof scripts.build === "string") buildCommands.push(`${packageManagers[0] ?? "npm"} run build`);
    } catch {
      // Keep the invalid package manifest visible to the agent.
    }
  }

  return { root, files, packageManagers, testCommands, buildCommands };
}

export async function scanRepository(root: string): Promise<RepositorySnapshot> {
  const files: RepositoryFile[] = [];
  await walk(root, root, files);
  return snapshotFromFiles(root, files);
}
