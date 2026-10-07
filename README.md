# Méthis AI

**Your AI code fixer.**

Méthis is an open-source-oriented coding agent designed to analyze a GitHub repository, understand a reported bug, modify the real code, verify the result, and prepare a pull request.

## Current architecture

```
GitHub repository
      ↓
Repository scanner
      ↓
Bug report
      ↓
Méthis Engine
      ↓
Open-source code model
      ↓
Code changes
      ↓
Typecheck / tests / build
      ↓
Diff
      ↓
Pull Request
```

The engine is intentionally separated from the model. Méthis will not depend on OpenAI, Anthropic, Gemini, Cursor, Replit Agent, or another paid AI API.

## MVP principles

- Real repository changes, not code-only answers.
- Temporary workspaces, no permanent storage of user source code.
- Deterministic tooling whenever possible.
- Open-source model integration.
- Verification before a fix is reported as successful.
- Strict execution and repository-size limits to protect the $1 Pro economics.

## Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js .
```

## Status

The repository scanner and engine contracts are the first foundation. GitHub integration, the model runtime, patch application, verification sandbox, authentication, and crypto entitlements are built on top of this core.
