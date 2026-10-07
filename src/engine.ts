import type { BugReport, FixPlan, FixResult, RepositorySnapshot, VerificationResult } from "./types.js";
import { scanRepository } from "./scanner.js";
import { TemporaryWorkspace } from "./workspace.js";
import { applyEdits } from "./patcher.js";

const MAX_ATTEMPTS = 3;

function verificationPassed(results: VerificationResult[]): boolean {
  return results.length > 0 && results.every((result) => result.passed);
}

function verificationError(results: VerificationResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => `COMMAND: ${result.command}\n${result.output}`)
    .join("\n\n")
    .slice(-20_000);
}

function diffFromEdits(edits: FixPlan["edits"]): string {
  return edits.map((edit) =>
    `--- a/${edit.path}\n+++ b/${edit.path}\n@@ edit @@\n-${edit.oldText}\n+${edit.newText}`
  ).join("\n\n");
}

export class MethisEngine {
  constructor(
    private readonly model: { plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan> },
    private readonly verifier: { run(repository: RepositorySnapshot): Promise<VerificationResult[]> },
  ) {}

  async fix(root: string, bug: BugReport): Promise<FixResult> {
    const original = await scanRepository(root);
    const workspace = await TemporaryWorkspace.create(root, original.files);
    const changedFiles = new Set<string>();
    let current = original;
    let plan: FixPlan = { summary: "No plan", files: [], reasoning: "", edits: [] };
    let verification: VerificationResult[] = [];
    const diffs: string[] = [];

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const attemptBug: BugReport = {
          description: bug.description,
          errorOutput: attempt === 1 ? bug.errorOutput : verificationError(verification),
        };

        plan = await this.model.plan({ repository: current, bug: attemptBug });
        if (!plan.edits.length) break;

        const applied = await applyEdits(workspace, current, plan.edits);
        if (!applied.length) break;
        applied.forEach((file) => changedFiles.add(file));
        diffs.push(diffFromEdits(plan.edits));

        current = await scanRepository(workspace.root);
        verification = await this.verifier.run(current);

        if (verificationPassed(verification)) {
          return {
            plan,
            verification,
            changedFiles: [...changedFiles],
            diff: diffs.join("\n\n"),
            attempts: attempt,
            verified: true,
          };
        }
      }

      return {
        plan,
        verification,
        changedFiles: [...changedFiles],
        diff: diffs.join("\n\n"),
        attempts: MAX_ATTEMPTS,
        verified: false,
      };
    } finally {
      await workspace.cleanup();
    }
  }
}
