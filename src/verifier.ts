import { spawn } from "node:child_process";
import type { RepositorySnapshot, VerificationResult } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 12_000;
const SAFE_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "ComSpec", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"];

function parseCommand(command: string): { executable: string; args: string[] } {
  const match = command.match(/^(npm|pnpm|yarn) run (test|typecheck|build)$/);
  if (!match) throw new Error(`Unsupported verification command: ${command}`);
  return { executable: match[1], args: ["run", match[2]] };
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NODE_ENV: "test" };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  env.npm_config_ignore_scripts = "false";
  return env;
}

function run(command: string, cwd: string): Promise<VerificationResult> {
  return new Promise((resolveResult) => {
    const { executable, args } = parseCommand(command);
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      env: safeEnvironment(),
      windowsHide: true,
    });

    let output = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolveResult({ command, exitCode, output: output.slice(-MAX_OUTPUT), passed: exitCode === 0 });
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
