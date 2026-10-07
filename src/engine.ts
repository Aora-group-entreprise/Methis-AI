import type { BugReport, FixPlan, FixResult, RepositorySnapshot, VerificationResult } from "./types.js";
import { scanRepository } from "./scanner.js";

export interface CodeModel {
  plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan>;
  apply(input: { repository: RepositorySnapshot; plan: FixPlan }): Promise<string[]>;
}

export interface Verifier {
  run(repository: RepositorySnapshot): Promise<VerificationResult[]>;
}

export class MethisEngine {
  constructor(private readonly model: CodeModel, private readonly verifier: Verifier) {}

  async fix(root: string, bug: BugReport): Promise<FixResult> {
    const repository = await scanRepository(root);
    const plan = await this.model.plan({ repository, bug });
    const changedFiles = await this.model.apply({ repository, plan });
    const verification = await this.verifier.run(repository);
    return { plan, changedFiles, verification };
  }
}
