import type { BugReport, FixPlan, RepositoryFile, RepositorySnapshot } from "./types.js";

export interface BrainMemory {
  task: string;
  failedAttempts: number;
  errors: string[];
  changedFiles: string[];
  hypotheses: string[];
}

export interface BrainDecision {
  intent: "fix" | "analyze" | "unknown";
  scope: string[];
  hypotheses: string[];
  confidence: number;
  risk: "low" | "medium" | "high";
  strategy: string;
}

export interface BrainResult {
  decision: BrainDecision;
  plan: FixPlan;
  memory: BrainMemory;
}

const MAX_MEMORY_ERRORS = 3;
const MAX_SCOPE_FILES = 24;
const MAX_HYPOTHESES = 6;

const protectedPath = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential).*)$/i.test(path) ||
  /\.(?:pem|key|p12|pfx)$/i.test(path);

const tokenize = (value: string) =>
  [...new Set(value.toLowerCase().split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 3))];

function scoreFile(file: RepositoryFile, tokens: string[]) {
  const haystack = (file.path + "\n" + file.content.slice(0, 16000)).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (file.path.toLowerCase().includes(token)) score += 5;
    else if (haystack.includes(token)) score += 1;
  }
  if (/^(test|spec|tests|__tests__)\b/i.test(file.path)) score += 1;
  return score;
}

function inferIntent(task: string): BrainDecision["intent"] {
  if (/\b(fix|bug|error|broken|crash|fail|repair|correct|issue|exception)\b/i.test(task)) return "fix";
  if (/\b(analy[sz]|understand|explain|inspect|review|audit)\b/i.test(task)) return "analyze";
  return "unknown";
}

function buildDecision(repository: RepositorySnapshot, bug: BugReport, memory: BrainMemory): BrainDecision {
  const tokens = tokenize([bug.description, bug.errorOutput ?? "", ...memory.errors].join("\n"));
  const ranked = repository.files
    .filter((file) => !protectedPath(file.path))
    .map((file) => ({ file, score: scoreFile(file, tokens) }))
    .sort((a, b) => b.score - a.score || a.file.size - b.file.size);

  const scope = ranked.filter((item) => item.score > 0).slice(0, MAX_SCOPE_FILES).map((item) => item.file.path);
  const hypotheses = [
    ...(tokens.length ? ["The reported failure is related to one or more files matching the task/error vocabulary."] : []),
    ...(memory.errors.length ? ["A previous attempt failed, so the next patch must address the observed verification output instead of repeating the same change."] : []),
    ...(scope.length ? ["The most relevant code is concentrated in " + scope.slice(0, 5).join(", ") + (scope.length > 5 ? ", and nearby dependencies." : ".")] : []),
  ].slice(0, MAX_HYPOTHESES);

  const confidence = Math.min(0.98, Math.max(0.2, 0.35 + Math.min(scope.length, 8) * 0.07 + (memory.errors.length ? 0.08 : 0)));
  const risk: BrainDecision["risk"] =
    scope.length === 0 ? "high" :
    scope.length > 10 || memory.errors.length >= 2 ? "medium" : "low";

  return {
    intent: inferIntent(bug.description),
    scope,
    hypotheses,
    confidence,
    risk,
    strategy: memory.errors.length
      ? "Use the latest verification evidence, isolate the smallest causal change, then verify again."
      : "Map the repository, identify the smallest relevant scope, propose one minimal change, then verify it.",
  };
}

function focusedRepository(repository: RepositorySnapshot, scope: string[]): RepositorySnapshot {
  const selected = new Set(scope);
  const files = repository.files
    .filter((file) => selected.has(file.path) || file.path === "package.json" || /(?:tsconfig|vite|wrangler|package-lock|pnpm-lock|yarn\.lock)/i.test(file.path))
    .slice(0, MAX_SCOPE_FILES + 8);
  return { ...repository, files };
}

export class MethisBrain {
  private readonly memory: BrainMemory;

  constructor(task: string, previous?: Partial<BrainMemory>) {
    this.memory = {
      task,
      failedAttempts: previous?.failedAttempts ?? 0,
      errors: (previous?.errors ?? []).slice(-MAX_MEMORY_ERRORS),
      changedFiles: [...new Set(previous?.changedFiles ?? [])],
      hypotheses: (previous?.hypotheses ?? []).slice(-MAX_HYPOTHESES),
    };
  }

  get state(): BrainMemory {
    return {
      task: this.memory.task,
      failedAttempts: this.memory.failedAttempts,
      errors: [...this.memory.errors],
      changedFiles: [...this.memory.changedFiles],
      hypotheses: [...this.memory.hypotheses],
    };
  }

  async think(
    repository: RepositorySnapshot,
    bug: BugReport,
    model: { plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan> },
  ): Promise<BrainResult> {
    const decision = buildDecision(repository, bug, this.memory);
    this.memory.hypotheses = [...new Set([...this.memory.hypotheses, ...decision.hypotheses])].slice(-MAX_HYPOTHESES);

    if (decision.intent !== "fix") {
      return {
        decision,
        plan: {
          summary: "Méthis could not safely classify this request as a code-fix task.",
          files: decision.scope,
          reasoning: decision.strategy,
          edits: [],
        },
        memory: this.state,
      };
    }

    const focused = focusedRepository(repository, decision.scope);
    const enrichedBug: BugReport = {
      description: [
        bug.description,
        "",
        "MÉTHIS BRAIN DECISION:",
        "Intent: " + decision.intent,
        "Risk: " + decision.risk,
        "Confidence: " + decision.confidence.toFixed(2),
        "Strategy: " + decision.strategy,
        decision.hypotheses.length ? "Hypotheses:\n- " + decision.hypotheses.join("\n- ") : "",
        this.memory.changedFiles.length ? "Previously changed files:\n- " + this.memory.changedFiles.join("\n- ") : "",
      ].filter(Boolean).join("\n"),
      errorOutput: bug.errorOutput,
    };

    const plan = await model.plan({ repository: focused, bug: enrichedBug });
    const scoped = new Set(decision.scope);
    for (const edit of plan.edits) {
      if (!scoped.has(edit.path) && !focused.files.some((file) => file.path === edit.path)) {
        throw new Error("Méthis Brain rejected an out-of-scope edit: " + edit.path);
      }
    }

    this.memory.changedFiles = [...new Set([...this.memory.changedFiles, ...plan.edits.map((edit) => edit.path)])];
    return { decision, plan, memory: this.state };
  }

  learnFromFailure(error: string) {
    this.memory.failedAttempts += 1;
    if (error.trim()) this.memory.errors = [...this.memory.errors, error.slice(-12000)].slice(-MAX_MEMORY_ERRORS);
  }
}
