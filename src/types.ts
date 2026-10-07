export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "rust" | "unknown";

export interface RepositoryFile {
  path: string;
  size: number;
  language: SupportedLanguage;
  content: string;
}

export interface RepositorySnapshot {
  root: string;
  files: RepositoryFile[];
  packageManagers: string[];
  testCommands: string[];
  buildCommands: string[];
}

export interface BugReport {
  description: string;
  errorOutput?: string;
}

export interface FileEdit {
  path: string;
  oldText: string;
  newText: string;
}

export interface FixPlan {
  summary: string;
  files: string[];
  reasoning: string;
  edits: FileEdit[];
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  passed: boolean;
}

export interface FixResult {
  plan: FixPlan;
  verification: VerificationResult[];
  changedFiles: string[];
  diff: string;
  attempts: number;
  verified: boolean;
}
