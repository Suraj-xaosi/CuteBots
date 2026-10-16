# CuteBots

CuteBots is a local coding-agent workspace. Add a GitHub repository, get a persistent Docker sandbox cloned and ready, then give the agent one task at a time. Project context and task conversations are stored in SQLite.

## Minimal workflow

1. Create a project with its GitHub repository URL. A GitHub token is optional for public cloning; to clone private repositories or push changes, provide a repository-scoped token with Contents read/write permission.
2. CuteBots creates a minimal sandbox, clones the repository, and creates one persistent `cutebots/<project-id>` working branch.
3. Assign a task. The agent installs tools or dependencies only when the task requires them.
4. Cancelled work is interrupted, not deleted. Add new instructions to continue the same task and branch.
5. The sandbox remains until explicitly destroyed.

Each project may have one active task. New tasks for a busy project are rejected rather than queued; other projects remain independent.

## Project structure

- `apps/web`: dashboard for projects, task history, project context, files, and settings; panels, layout behavior, and workspace state are separated into focused components and hooks
- `apps/agent`: API and project/task lifecycle, with repository provisioning isolated from project CRUD
- `packages/core`: LangGraph agent loop, command/file/search tools grouped by purpose, optional Tavily web search, model integration, Docker controls
- `packages/db`: SQLite/Prisma schema, migrations, and persistence
- `packages/types`: shared application and model types
- `infra/Dockerfile.sandbox-minimal`: common sandbox base; language runtimes are installed later as needed

The agent service manages Docker sandboxes and has access to the Docker socket. CuteBots is intended for one trusted local user, not as an internet-facing multi-user service.

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
