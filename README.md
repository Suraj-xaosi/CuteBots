# CuteBots

CuteBots is a local coding-agent workspace. Add a GitHub repository, get a persistent Docker sandbox cloned and ready, then give the agent one task at a time. Project context and task conversations are stored in SQLite.

## Project workflow

1. Create a project with its GitHub repository URL. A GitHub token is optional for public cloning; to clone private repositories or push changes, provide a repository-scoped token with Contents read/write permission.
2. CuteBots creates a sandbox, clones the repository, and creates one persistent `cutebots/<project-id>` working branch.
3. Assign a task, then follow its response and tool progress in the conversation while it works. Dependencies are installed only when needed.
4. Continue completed or interrupted tasks in the same conversation and branch. Cancelled work is interrupted, not deleted.
5. The sandbox remains until explicitly destroyed.

Each project may have one active task. New tasks for a busy project are rejected rather than queued; other projects remain independent.

## Project structure

- `apps/web`: dashboard for projects, streamed task conversations, project context, files, and settings; panels, layout behavior, and workspace state are separated into focused components and hooks
- `apps/agent`: API and project/task lifecycle, with repository provisioning isolated from project CRUD
- `packages/core`: LangGraph agent loop, LangChain model integrations, AI SDK streaming adapter, command/file/search tools grouped by purpose, optional Tavily web search, Docker controls
- `packages/db`: SQLite/Prisma schema, migrations, and persistence
- `packages/types`: shared application and model types
- `infra/Dockerfile.sandbox-base`: common sandbox base; language runtimes are installed later as needed

The agent service manages Docker sandboxes and has access to the Docker socket. CuteBots is intended for one trusted local user, not as an internet-facing multi-user service.

## Follow the code

If you are new to the codebase, follow one feature at a time instead of reading every file:

1. **Dashboard:** start at `apps/web/app/page.tsx`, then follow the component it renders in `apps/web/components/`.
2. **Browser requests:** `apps/web/lib/agent-api.ts` sends requests to the backend. The Next.js config forwards `/api` requests to the agent service.
3. **API routes:** `apps/agent/src/app.ts` connects the route files in `apps/agent/src/routes/`. Routes check input, then call a service.
4. **Project and task rules:** `apps/agent/src/services/` contains the decisions for creating projects, preparing sandboxes, and starting or stopping tasks.
5. **Agent work:** `packages/core/src/agent/agent-loop.ts` runs the task. It asks the language model what to do, runs requested tools, and repeats until the task is done.
6. **Tools and sandbox:** `packages/core/src/tools/` defines what the agent can do. `packages/core/src/sandbox.ts` connects those tools to Docker.
7. **Saved data:** `packages/db/prisma/schema.prisma` describes the database. `apps/agent/src/persistence/` reads and writes agent messages and logs.

For example, to understand **creating a task**, follow `dashboard-tasks-panel.tsx` → `agent-api.ts` → `project-routes.ts` → `task-service.ts` → `agent-loop.ts`. To understand where a task's history goes, continue to `prisma-agent-persistence.ts` and `schema.prisma`.

### A few patterns you will see

- `Result<T>` means an operation either worked (`ok: true`, with `data`) or failed (`ok: false`, with an error). Check `ok` before using `data`.
- API routes validate incoming data before passing it to a service.
- Services make application decisions; Prisma code saves and loads data; core code runs the agent and its tools.
- The TypeScript types at these boundaries describe what each part sends to the next. Start from the function call you are following, and look up a type only when you need to know what data it carries.

## Run locally

Requirements: Node.js 22+, npm, Docker, and a configured model provider.

```powershell
npm install
Copy-Item .env.example .env
```

Set `LLM_PROVIDER`, `LLM_MODEL`, and `API_KEY` in `.env`. Generate a persistent encryption key for credentials:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the output as `SETTINGS_ENCRYPTION_KEY`. CuteBots builds the shared sandbox image automatically when the first project sandbox is created.

Start the web app and agent:

```powershell
npm exec -- turbo run build --filter=agent...
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). See [tutorial.md](./tutorial.md) for Docker Compose, repository credentials, and dashboard usage.

## Current boundaries

- Project creation provisions and clones only; it does not install repository dependencies.
- The agent has basic file and command tools. It can install dependencies during a task when asked or when needed.
- Optional web search is available after adding a Tavily API key in dashboard Settings.
- Task history is stored in SQLite; project context is a small user-maintained text field, not semantic/vector memory.
- The agent commits and pushes only when explicitly asked, and only to the project's working branch. A repository-scoped GitHub token with Contents read/write permission is required.
