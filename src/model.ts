import type { BugReport, FixPlan, RepositoryFile, RepositorySnapshot } from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const MAX_CONTEXT_CHARS = 120_000;
const MAX_EDITS = 8;
const MAX_EDIT_CHARS = 60_000;
const MAX_TOTAL_EDIT_CHARS = 180_000;

function isSensitivePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("/.env.") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("id_rsa");
}

function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]");
}

function relevanceScore(file: RepositoryFile, bug: string): number {
  const terms = bug.toLowerCase().split(/[^a-z0-9_./-]+/).filter((term) => term.length >= 3);
  const haystack = (file.path + "\n" + file.content.slice(0, 12_000)).toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function buildContext(files: RepositoryFile[], bug: string): string {
  const candidates = files
    .filter((file) => file.language !== "unknown" && !isSensitivePath(file.path))
    .sort((a, b) => relevanceScore(b, bug) - relevanceScore(a, bug) || a.size - b.size);

  const selected: string[] = [];
  let total = 0;

  for (const file of candidates) {
    const block = `FILE: ${file.path}\n${redactSecrets(file.content)}`;
    if (total + block.length > MAX_CONTEXT_CHARS) continue;
    selected.push(block);
    total += block.length + 2;
  }

  return selected.join("\n\n");
}

function extractJson(raw: string): string {
  const fenced = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  if (fenced) return fenced[1].trim();

  const start = raw.indexOf("{");
  if (start < 0) throw new Error("Model did not return a JSON object.");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  throw new Error("Model returned incomplete JSON.");
}

export class LocalQwenModel {
  constructor(
    private readonly endpoint = process.env.METHIS_MODEL_URL ?? "http://127.0.0.1:8000/v1/chat/completions",
    private readonly model = process.env.METHIS_MODEL ?? "Qwen/Qwen3-Coder-Next",
  ) {}

  async plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan> {
    const files = buildContext(input.repository.files, input.bug.description);
    if (!files) throw new Error("No safe source files are available for model analysis.");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are Méthis, a conservative coding agent. Return JSON only. Find the smallest safe fix for the reported bug. Never invent paths. Never rewrite an entire file when a small edit is enough. Do not create or delete files. Every edit must use an exact oldText substring from the supplied repository and a newText replacement. oldText must be unique in that file. Keep edits minimal. JSON keys: summary, files, reasoning, edits. edits is an array of {path, oldText, newText}.",
      },
      {
        role: "user",
        content: `BUG:\n${redactSecrets(input.bug.description)}\n\nERROR:\n${redactSecrets(input.bug.errorOutput ?? "none")}\n\nREPOSITORY CONTEXT:\n${files}`,
      },
    ];

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.1,
        max_tokens: 12_000,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as ChatResponse;
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Local model returned no content.");

    const plan = JSON.parse(extractJson(raw)) as FixPlan;
    if (
      typeof plan.summary !== "string" ||
      !plan.summary.trim() ||
      !Array.isArray(plan.files) ||
      typeof plan.reasoning !== "string" ||
      !Array.isArray(plan.edits)
    ) {
      throw new Error("Model returned an invalid fix plan.");
    }

    if (plan.edits.length > MAX_EDITS) {
      throw new Error(`Model returned too many edits. Maximum is ${MAX_EDITS}.`);
    }

    const known = new Map(input.repository.files.map((file) => [file.path, file]));
    let totalEditChars = 0;

    for (const edit of plan.edits) {
      if (!edit || typeof edit.path !== "string" || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
        throw new Error("Model returned an invalid edit.");
      }
      if (isSensitivePath(edit.path)) {
        throw new Error(`Model attempted to edit a protected file: ${edit.path}`);
      }

      const file = known.get(edit.path);
      if (!file) throw new Error(`Model attempted to modify an unknown file: ${edit.path}`);
      if (!edit.oldText.trim()) throw new Error(`Edit for ${edit.path} has an empty oldText.`);
      if (edit.oldText.length > MAX_EDIT_CHARS || edit.newText.length > MAX_EDIT_CHARS) {
        throw new Error(`Edit for ${edit.path} is too large.`);
      }

      const occurrences = file.content.split(edit.oldText).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Edit for ${edit.path} must match exactly once; found ${occurrences} matches.`);
      }

      totalEditChars += edit.oldText.length + edit.newText.length;
      if (totalEditChars > MAX_TOTAL_EDIT_CHARS) {
        throw new Error("Model returned too much total patch content.");
      }
    }

    for (const file of plan.files) {
      if (!known.has(file)) throw new Error(`Model selected an unknown file: ${file}`);
    }

    return plan;
  }
}
