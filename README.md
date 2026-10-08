# Méthis AI

Méthis AI is the engine only: a conservative coding agent for real repositories.

## Core pipeline

Repository → scanner → local/open-weight coding model → minimal patch → verification → optional GitHub commit / draft PR.

The default model adapter uses an OpenAI-compatible endpoint and defaults to **Qwen/Qwen3-Coder-Next**.

## Runtime targets

### Node.js

The Node runtime powers the full engine and local workspace fixing:

`npm run dev`

`npm run cli -- /path/to/repository`

`npm run cli -- /path/to/repository "specific bug description"`

### Cloudflare Worker

Cloudflare runs the remote GitHub analysis/fix API:

- `GET /api/health`
- `POST /api/analyze`
- `POST /api/github-fix`

Local filesystem fixing remains Node-only because Cloudflare Workers do not provide the Node filesystem/process execution environment required by the verifier.

## Cloudflare configuration

Set the Worker secret:

`wrangler secret put GITHUB_TOKEN`

Set `METHIS_MODEL_URL` to a reachable OpenAI-compatible model endpoint and `METHIS_MODEL` to the model identifier.

Deploy:

`npm run build`

`npx wrangler deploy`

Authentication, plans, billing, dashboard UI, landing pages, and product presentation are intentionally not part of this repository state.
