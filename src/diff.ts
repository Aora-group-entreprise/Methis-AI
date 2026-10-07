import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitDiff(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--"], {
      cwd: root,
      maxBuffer: 2_000_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to generate git diff: ${message}`);
  }
}
