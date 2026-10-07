# Méthis AI

Méthis is a conservative local AI coding agent for real repositories. It scans source, plans a minimal edit, applies it in a disposable workspace, verifies it, retries bounded failures, and can prepare an isolated GitHub pull request.

## Pipeline

```
Repository
   ↓
Scanner + protected-file filtering
   ↓
Relevant source context
   ↓
Local open-weight coding model
   ↓
Validated minimal edits
   ↓
Disposable workspace
   ↓
Verification
   ↓
Retry on failure (max 3)
   ↓
Diff / Pull Request
```

The default model adapter uses an OpenAI-compatible local HTTP endpoint and defaults to **Qwen/Qwen3-Coder-Next**. No paid AI API is required.

Default endpoint:

`http://127.0.0.1:8000/v1/chat/completions`

Environment variables:

- `METHIS_MODEL_URL`
- `METHIS_MODEL`
- `GITHUB_TOKEN` for GitHub write operations
- `METHIS_SESSION_SECRET` for persistent signed sessions in production
- `METHIS_ENABLE_LOCAL_FIX=true` and `METHIS_WORKSPACE_ROOT` only when an approved local workspace integration is configured

## Safety boundaries

- Secret-like files are excluded from model context.
- Source files are capped at 2 MB each and repositories at 2,000 files.
- Model edits must target existing files and exact unique text.
- Whole-file rewrites, new files, path traversal, and protected secret files are rejected.
- Verification never uses a shell and receives a reduced environment without repository secrets.
- Verification is bounded to 120 seconds per command.
- GitHub fixes use a fresh branch and one Git commit containing the patch, then open a draft PR.
- Remote GitHub fixes are statically validated before the PR is created; repository CI remains the final merge gate.
- Server authentication uses password hashing and signed HttpOnly sessions; browser localStorage is not trusted for identity or usage.
- Server-side limits are enforced per account: Free allows 10 analyses/day and 2 Fixes/month. Méthis Pro is designed for $1 Crypto/month and allows 100 analyses/day plus 8 Fixes/month, released as 2 credits on cycle days 0, 1, 10 and 15.
- Paid plan activation is intentionally not implemented until a real crypto billing provider is connected. The UI cannot grant itself a paid plan.
- Runtime account data is stored outside Git in `data/accounts.json` for the current single-node deployment foundation; use a durable database before multi-instance production.

## Web API

- `GET /api/health` reports the configured Qwen model.
- `GET /api/plans` exposes server-side plan limits.
- `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `GET /api/auth/me` manage the account session.
- `POST /api/analyze` requires authentication and consumes one daily analysis after the repository is successfully loaded.
- `POST /api/github-fix` requires Méthis Pro and consumes one monthly Fix credit for a specific bug.
- `POST /api/fix` is disabled on the public web server unless an approved local workspace integration explicitly enables it. Every Fix request is restricted to one specific bug; whole-app repair requests are rejected.

## Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js .
```
\n\n## Fix credit policy\n\n- One Fix credit = one specific bug.\n- Requests to fix the whole app or codebase are rejected.\n- Free: 2 Fixes per month.\n- Méthis Pro: $1 Crypto/month, 8 Fixes per billing cycle: 2 immediately, then 2 on day 1, day 10 and day 15.\n- The server enforces credit availability; browser state cannot grant extra Fixes.\n