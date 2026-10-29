# CuteBots

CuteBots is a self-hosted Next.js coding-agent workspace. Server Actions handle project, credential, conversation, run, and sandbox operations; the run activity stream uses an App Router Route Handler.

## Project structure

- `apps/web`: Next.js app, project/conversation context, Server Actions, encrypted project credentials, and the run activity stream
- `packages/core`: LangGraph agent loop, LangChain model integrations, AI SDK streaming adapter, command/file/search tools grouped by purpose, optional Tavily web search, Docker controls
- `packages/db`: SQLite/Prisma schema, migrations, and persistence
- `packages/types`: shared application and model types
- `infra/Dockerfile.sandbox-base`: common sandbox base; language runtimes are installed later as needed

## Follow the code

If you are new to the codebase, follow one feature at a time instead of reading every file:

1. **Dashboard:** start at `apps/web/app/page.tsx`, then follow the component it renders in `apps/web/components/`.
2. **Browser requests:** use Server Actions for ordinary database changes and forms.
3. **Live updates:** the run activity stream is served from `apps/web/app/api/runs/[runId]/events/route.ts`.
4. **Agent work:** `packages/core/src/agent/agent-loop.ts` contains the agent loop and `packages/core/src/tools/` contains its tools.
5. **Tools and sandbox:** `packages/core/src/sandbox.ts` connects core tools to Docker.
6. **Saved data:** `packages/db/prisma/schema.prisma` describes the database schema; `apps/web/lib/server.ts` connects Prisma persistence to the agent runtime.

For example, project CRUD lives in `apps/web/lib/actions/projects.ts`; run activity is the only browser-facing Route Handler.

### A few patterns you will see

- `Result<T>` means an operation either worked (`ok: true`, with `data`) or failed (`ok: false`, with an error). Check `ok` before using `data`.
- Server Actions should validate input and return safe, serializable results.
- Keep application decisions in functional service modules, persistence in Prisma-facing modules, and agent execution in core.
- The TypeScript types at these boundaries describe what each part sends to the next. Start from the function call you are following, and look up a type only when you need to know what data it carries.

## Run locally

Requirements: Node.js 22+, npm, Docker, and a configured 32-byte base64 credential-encryption key. Enter AI provider keys in each project's settings; provider keys are encrypted in the database and are not read from environment variables.

```powershell
npm install
```

Create a root `.env` with `DATABASE_URL=file:../../data/database.db` and a `CREDENTIALS_ENCRYPTION_KEY` before saving project credentials. Generate a key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep this key private and stable; changing it makes saved project credentials unreadable.

Apply the SQLite migrations before starting the dashboard:

```powershell
npm run db:migrate --workspace=@workspace/db
```

For deployments, apply the checked-in migrations with
`npm run db:deploy --workspace=@workspace/db`.

Start the Next.js dashboard:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Project operations are exposed as Server Actions, and agent activity is streamed over SSE.

The web container needs access to the Docker socket to provision and recover project sandboxes. Existing project containers are started on app startup rather than replaced.
