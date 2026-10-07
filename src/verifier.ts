import { spawn } from "node:child_process";
import type { RepositorySnapshot, VerificationResult } from "./types.js";

const TIMEOUT_MS = 120_000;

function run(command: string, cwd: string): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: "1" },
    });

    let output = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ command, exitCode, output: output.slice(-12000), passed: exitCode === 0 });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      output += "\n[timeout]";
      finish(124);
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      output += error.message;
      finish(1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

export class CommandVerifier {
  async run(repository: RepositorySnapshot): Promise<VerificationResult[]> {
    const commands = [...repository.testCommands, ...repository.buildCommands];
    const results: VerificationResult[] = [];

    for (const command of commands) {
      const result = await run(command, repository.root);
      results.push(result);
      if (!result.passed) break;
    }

    return results;
  }
}
