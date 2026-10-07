import type {
  BugReport,
  FixPlan,
  FixResult,
  RepositorySnapshot,
  VerificationResult,
} from "./types.js";
import { scanRepository } from "./scanner.js";
import { TemporaryWorkspace } from "./workspace.js";
import { applyChanges } from "./patcher.js";
import { gitDiff } from "./diff.js";

export interface CodeModel {
  plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan>;
}

export interface Verifier {
  run(repository: RepositorySnapshot): Promise<VerificationResult[]>;
}

export class MethisEngine {
  constructor(private readonly model: CodeModel, private readonly verifier: Verifier) {}

  async fix(root: string, bug: BugReport): Promise<FixResult> {
    const repository = await scanRepository(root);
    const plan = await this.model.plan({ repository, bug });

    const workspace = await TemporaryWorkspace.create(root, repository.files.length);

    try {
      const changedFiles = await applyChanges(workspace, repository, plan.changes);
      const patchedRepository = await scanRepository(workspace.root);
      const verification = await this.verifier.run(patchedRepository);
      const diff = await gitDiff(workspace.root);

      return { plan, changedFiles, verification, diff };
    } finally {
      await workspace.cleanup();
    }
  }
}
