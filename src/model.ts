import type { BugReport, FixPlan, RepositorySnapshot } from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class LocalQwenModel {
  constructor(
    private readonly endpoint = process.env.METHIS_MODEL_URL ?? "http://127.0.0.1:8000/v1/chat/completions",
    private readonly model = process.env.METHIS_MODEL ?? "Qwen/Qwen3-Coder-Next",
  ) {}

  async plan(input: { repository: RepositorySnapshot; bug: BugReport }): Promise<FixPlan> {
    const files = input.repository.files
      .filter((file) => file.language !== "unknown")
      .map((file) => `FILE: ${file.path}\n${file.content}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are Methis, a conservative coding agent. Analyze the reported bug and return JSON only. Choose the smallest safe set of existing files. Never invent paths. Never rewrite unrelated code. Return complete replacement content only for files that must change. JSON keys: summary, files, reasoning, changes. changes is an array of objects with path and content.",
      },
      {
        role: "user",
        content: `BUG:\n${input.bug.description}\n\nERROR:\n${input.bug.errorOutput ?? "none"}\n\nREPOSITORY:\n${files}`,
      },
    ];

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.1,
        max_tokens: 12000,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as ChatResponse;
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Local model returned no content.");

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Model did not return a JSON object.");

    const plan = JSON.parse(raw.slice(start, end + 1)) as FixPlan;
    if (
      !plan.summary ||
      !Array.isArray(plan.files) ||
      typeof plan.reasoning !== "string" ||
      !Array.isArray(plan.changes)
    ) {
      throw new Error("Model returned an invalid fix plan.");
    }

    const known = new Set(input.repository.files.map((file) => file.path));
    for (const file of plan.files) {
      if (!known.has(file)) throw new Error(`Model selected an unknown file: ${file}`);
    }

    for (const change of plan.changes) {
      if (!change || typeof change.path !== "string" || typeof change.content !== "string") {
        throw new Error("Model returned an invalid file change.");
      }
      if (!known.has(change.path)) {
        throw new Error(`Model attempted to modify an unknown file: ${change.path}`);
      }
    }

    return plan;
  }
}
