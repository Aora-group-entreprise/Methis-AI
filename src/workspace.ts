import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_FILES = 2000;

export class TemporaryWorkspace {
  private constructor(readonly root: string) {}

  static async create(source: string, fileCount: number): Promise<TemporaryWorkspace> {
    if (fileCount > MAX_FILES) {
      throw new Error(`Repository exceeds the temporary workspace limit of ${MAX_FILES} files.`);
    }

    const root = await mkdtemp(join(tmpdir(), "methis-"));
    await cp(source, root, { recursive: true });
    return new TemporaryWorkspace(root);
  }

  async write(path: string, content: string): Promise<void> {
    const target = join(this.root, path);
    if (!target.startsWith(this.root + "/") && target !== this.root) {
      throw new Error(`Unsafe workspace path: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
