import { cp, mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import type { RepositoryFile } from "./types.js";

const MAX_FILES = 2000;

function isProtected(path: string): boolean {
  return /(^|[\\/])(?:\.env(?:\..*)?|.*(?:secret|credential).*)$|\.(?:pem|key|p12|pfx)$/i.test(path);
}

export class TemporaryWorkspace {
  private constructor(readonly root: string) {}

  static async create(source: string, files: RepositoryFile[]): Promise<TemporaryWorkspace> {
    if (files.length > MAX_FILES) {
      throw new Error(`Repository exceeds the workspace limit of ${MAX_FILES} files.`);
    }

    const root = await mkdtemp(join(tmpdir(), "methis-"));
    const workspace = new TemporaryWorkspace(root);

    try {
      await cp(source, root, {
        recursive: true,
        filter: (sourcePath) => {
          const relative = sourcePath.startsWith(source) ? sourcePath.slice(source.length).replace(/^[/\\]+/, "") : sourcePath;
          if (!relative) return true;
          const parts = relative.split(/[\\/]/);
          if (parts.includes(".git") || parts.includes("dist") || parts.includes("build") || parts.includes(".next") || parts.includes("coverage") || parts.includes(".turbo")) return false;
          return !isProtected(relative);
        },
      });

      return workspace;
    } catch (error) {
      await workspace.cleanup();
      throw error;
    }
  }

  async read(path: string): Promise<string> {
    return readFile(this.safePath(path), "utf8");
  }

  async write(path: string, content: string): Promise<void> {
    const target = this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  private safePath(path: string): string {
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
      throw new Error(`Unsafe workspace path: ${path}`);
    }
    const target = resolve(this.root, path);
    const relativePath = relative(resolve(this.root), target);
    if (relativePath.startsWith(".."+sep) || isAbsolute(relativePath)) {
      throw new Error(`Unsafe workspace path: ${path}`);
    }
    return target;
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
