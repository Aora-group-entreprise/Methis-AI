import type { BugReport, FixPlan } from "./types.js";
import { scanRepository } from "./scanner.js";
import { LocalQwenModel } from "./model.js";

export class MethisPlanningAgent {
  constructor(private readonly model = new LocalQwenModel()) {}

  async plan(root: string, bug: BugReport): Promise<FixPlan> {
    const repository = await scanRepository(root);
    return this.model.plan({ repository, bug });
  }
}
