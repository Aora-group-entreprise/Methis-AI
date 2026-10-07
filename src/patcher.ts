import type { FileChange, RepositorySnapshot } from "./types.js";
import { TemporaryWorkspace } from "./workspace.js";

export async function applyChanges(
  workspace: TemporaryWorkspace,
  repository: RepositorySnapshot,
  changes: FileChange[],
): Promise<string[]> {
  const known = new Set(repository.files.map((file) => file.path));
  const changed: string[] = [];

  for (const change of changes) {
    if (!known.has(change.path)) {
      throw new Error(`Model attempted to modify an unknown file: ${change.path}`);
    }
    if (change.path.includes("..") || change.path.startsWith("/") || change.path.includes("\\")) {
      throw new Error(`Unsafe file path: ${change.path}`);
    }

    const original = repository.files.find((file) => file.path === change.path)?.content;
    if (original === change.content) continue;

    await workspace.write(change.path, change.content);
    changed.push(change.path);
  }

  return changed;
}
