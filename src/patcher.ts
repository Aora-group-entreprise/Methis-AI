import type { FileEdit, RepositorySnapshot } from "./types.js";
import { TemporaryWorkspace } from "./workspace.js";

export async function applyEdits(
  workspace: TemporaryWorkspace,
  repository: RepositorySnapshot,
  edits: FileEdit[],
): Promise<string[]> {
  const known = new Map(repository.files.map((file) => [file.path, file.content]));
  const changed = new Set<string>();

  for (const edit of edits) {
    const original = known.get(edit.path);
    if (original === undefined) {
      throw new Error(`Unknown file in patch: ${edit.path}`);
    }
    if (edit.path.includes("..") || edit.path.startsWith("/") || edit.path.includes("\\")) {
      throw new Error(`Unsafe file path: ${edit.path}`);
    }

    const current = await workspace.read(edit.path);
    const occurrences = current.split(edit.oldText).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Patch for ${edit.path} no longer matches exactly once.`);
    }

    await workspace.write(edit.path, current.replace(edit.oldText, edit.newText));
    changed.add(edit.path);
  }

  return [...changed];
}
