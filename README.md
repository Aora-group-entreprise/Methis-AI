# Méthis AI

Méthis AI is the engine only: a conservative local coding agent for real repositories.

## Core pipeline

Repository → scanner → relevant source context → local open-weight coding model → minimal patch → verification → bounded retry → optional GitHub commit / draft PR.

The default model adapter uses an OpenAI-compatible local HTTP endpoint and defaults to **Qwen/Qwen3-Coder-Next**. No paid AI API is required.

Default endpoint:

`http://127.0.0.1:8000/v1/chat/completions`

Environment variables:

- `METHIS_MODEL_URL`
- `METHIS_MODEL`
- `GITHUB_TOKEN` for GitHub write operations
- `METHIS_ENABLE_LOCAL_FIX=true` to enable the local HTTP fix endpoint
- `METHIS_WORKSPACE_ROOT` to restrict local fixes to an approved workspace

## Run

```bash
npm install
npm run typecheck
npm run build
npm start
```

CLI:

```bash
npm run cli -- /path/to/repository
npm run cli -- /path/to/repository "specific bug description"
npm run cli -- github:owner/repository
npm run cli -- github-fix:owner/repository "specific bug description"
```

## API

- `GET /api/health` checks the local model endpoint.
- `POST /api/analyze` scans a GitHub repository.
- `POST /api/github-fix` asks the model for a minimal patch and prepares a GitHub draft PR.
- `POST /api/fix` runs the verified local engine when local fixing is explicitly enabled.

Authentication, plans, billing, dashboard UI, landing pages, and product presentation are intentionally not part of this repository state. This repository contains the AI engine and only the runtime/integration code required to operate it.
