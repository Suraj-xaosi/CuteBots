# CuteBots

CuteBots is being migrated to a conversation/run architecture with a self-hosted Next.js app. The legacy Express backend has been removed; the Next.js API handlers and backend services are intentionally left for a clean-slate implementation.

## Project structure

- `apps/web`: Next.js dashboard and the future home for API route handlers under `app/api/`
- `packages/core`: LangGraph agent loop, LangChain model integrations, AI SDK streaming adapter, command/file/search tools grouped by purpose, optional Tavily web search, Docker controls
- `packages/db`: SQLite/Prisma schema, migrations, and persistence
- `packages/types`: shared application and model types
- `infra/Dockerfile.sandbox-base`: common sandbox base; language runtimes are installed later as needed

The dashboard still expects API endpoints that have not yet been reimplemented. The API client calls same-origin `/api/*` URLs, and Next.js can serve these through App Router route handlers without a proxy to a separate server.

## Follow the code

If you are new to the codebase, follow one feature at a time instead of reading every file:

1. **Dashboard:** start at `apps/web/app/page.tsx`, then follow the component it renders in `apps/web/components/`.
2. **Browser requests:** `apps/web/lib/agent-api.ts` sends same-origin requests to `/api/*`.
3. **Next.js API routes:** add App Router handlers under `apps/web/app/api/` when implementing the new backend.
4. **Agent work:** `packages/core/src/agent/agent-loop.ts` contains the agent loop and `packages/core/src/tools/` contains its tools.
5. **Tools and sandbox:** `packages/core/src/sandbox.ts` connects core tools to Docker.
6. **Saved data:** `packages/db/prisma/schema.prisma` describes the database schema; persistence wiring belongs in the new backend.

For example, to follow a dashboard request, start at the relevant component, then `apps/web/lib/agent-api.ts`, and add the matching Next.js route handler under `apps/web/app/api/`.

### A few patterns you will see

- `Result<T>` means an operation either worked (`ok: true`, with `data`) or failed (`ok: false`, with an error). Check `ok` before using `data`.
- Next.js route handlers should validate incoming data before passing it to functional service modules.
- Keep application decisions in functional service modules, persistence in Prisma-facing modules, and agent execution in core.
- The TypeScript types at these boundaries describe what each part sends to the next. Start from the function call you are following, and look up a type only when you need to know what data it carries.

## Run locally

Requirements: Node.js 22+, npm, Docker, and a configured model provider.

```powershell
npm install
Copy-Item .env.example .env
```

Start the Next.js dashboard:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Backend endpoints are not available until their Next.js route handlers are implemented.
