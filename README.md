# Méthis AI

Méthis is a conservative AI coding agent designed to analyze a real repository, understand a bug, choose the smallest safe change, verify it, and later open a pull request.

## Current engine

```
Repository
   ↓
Scanner + source context
   ↓
Bug report
   ↓
Local open-weight coding model
   ↓
Validated fix plan
   ↓
Patch workspace
   ↓
Typecheck / tests / build
   ↓
Diff
   ↓
Pull Request
```

The first model adapter uses an OpenAI-compatible local HTTP endpoint and defaults to **Qwen/Qwen3-Coder-Next**. Méthis does not call OpenAI, Anthropic, Gemini, Cursor, or Replit Agent APIs.

Default model endpoint:

`http://127.0.0.1:8000/v1/chat/completions`

Environment variables:

- `METHIS_MODEL_URL`
- `METHIS_MODEL`

The model weights can be free/open-weight, but inference still needs compute. The goal is zero paid AI API usage, not magically zero compute cost.

## Safety boundaries

- Repository files are scanned with a 2 MB per-file limit.
- Generated plans may only reference files that exist in the scanned repository.
- Verification commands have a 120 second timeout.
- The production worker will use an isolated temporary workspace and clean it after every job.
- No private keys or seed phrases are ever accepted by the agent.

## Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js .
```

## Status

This commit adds the local model adapter, source-aware planning agent, and deterministic verification runner. Patch application, isolated GitHub workspaces, authentication, crypto entitlement verification, and pull-request creation are the next engine layers.
