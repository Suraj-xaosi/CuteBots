# CuteBots

CuteBots is a local AI coding workspace that helps you create projects, run coding tasks, and monitor progress from a simple dashboard.

Think of it like a lightweight local AI coding agent:
- you create a project,
- you ask the agent to do work,
- the app runs that work inside a safe sandbox,
- and you can watch logs, status, and results in real time.

It is designed for local development, experimentation, and small AI-assisted coding workflows.

## What this project is for

This project lets you:
- create a workspace for a coding task,
- run AI-driven actions inside a containerized environment,
- track tasks and progress,
- review logs and file outputs,
- continue or retry work when something fails,
- monitor token usage and rough cost.

In easy language: it is a small, local version of an AI coding assistant that runs inside your machine instead of in the cloud.

## What it can do

The system currently supports:

- Project creation and management
- Task queueing for AI work
- Live task status updates
- Sandbox-based execution for each project
- Log streaming while a task runs
- Recovery when the app or server restarts
- Usage tracking for token counts
- A browser dashboard to manage everything in one place

## Main features

### 1. Project dashboard
A browser UI shows your projects and tasks. You can pick a project, inspect task details, and keep an eye on what is running.

### 2. AI task runner
Each task is queued and processed by the background agent system. This allows work to happen in an organized way instead of all at once.

### 3. Safe sandbox environment
Every project runs in its own isolated sandbox. That helps keep work separate and reduces risk from code running in the same environment.

### 4. Live task updates
As the agent works, the UI can stream updates and logs. You do not need to reload the page to see progress.

### 5. Recovery and stability
The system tries to recover from crashes or restarts so tasks do not silently disappear. This helps make the local runtime more reliable.

### 6. Token and usage tracking
The app can calculate token usage for a task and show an estimate of runtime cost.

## How it works

The project is split into a few parts:

- Frontend: Next.js app running in the browser
- Backend agent: Express API that handles tasks and project lifecycle
- Database: Prisma + SQLite for storing tasks, logs, and project metadata
- Sandbox runtime: Docker containers for isolated execution
- Task pipeline: queue and runtime loop for processing work

In simple terms:

1. You create a project in the web dashboard.
2. The backend creates a sandbox for that project.
3. You send a task to the agent.
4. The task is queued and processed inside the sandbox.
5. Logs and status stream back to the dashboard.
6. You can see results, retry work, or continue a paused task.

## How to run it

### Prerequisites

- Node.js 22 or newer and npm
- Docker Desktop or Docker Engine running (sandbox containers always run in Docker)
- A Groq API key if you want to use Groq

The commands below use Windows PowerShell from the repository root.

### 1. Configure Groq once

Create the local environment file and open it:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set these entries in `.env` (use your own Groq key; do not commit or paste it into source files):

```dotenv
LLM_PROVIDER=groq
LLM_MODEL=openai/gpt-oss-120b
API_KEY=your_groq_api_key
```

Generate a persistent encryption key:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy the output into `SETTINGS_ENCRYPTION_KEY` in `.env`. Keep it unchanged while encrypted settings exist; changing it makes those secrets unreadable. The `API_KEY` entry is read as the LLM key by the agent. You can also use `LLM_API_KEY` instead.

The Groq key supplied during setup was exposed in chat and should be revoked. Put a newly issued key in your local `.env`; never put a real key in `.env.example`.

### 2. Build the sandbox image once

Run this in either startup mode. This image is needed for project sandboxes even when the web app and agent run directly on your host:

```powershell
docker build -f infra/Dockerfile.sandbox-node -t cutebots-sandbox-node:latest .
```

### Option A: Run the web app and agent directly on Windows

Install dependencies and build the agent's shared workspace packages once:

```powershell
npm install
npm exec -- turbo run build --filter=agent... --ui=stream
```

Start both the Next.js web app and agent in development/watch mode:

```powershell
npm run dev
```

Leave this terminal open. The web app is at http://localhost:3000 and the agent health check is at http://localhost:3001/health. Stop both with **Ctrl+C**. Docker Desktop must stay running so the agent can create sandbox containers. The agent creates the `sandbox-net` Docker network automatically when it first needs it.

### Option B: Run the web app and agent in Docker

The first start builds the app images:

```powershell
docker compose up --build
```

Wait until the web app is ready, then open http://localhost:3000. The agent health check is at http://localhost:3001/health. Both services mount the source tree and run in watch mode, so ordinary edits to `apps/web` and `apps/agent` do not require rebuilding. Start the already-built stack next time with:

```powershell
docker compose up
```

Stop the stack with **Ctrl+C** or, from another terminal:

```powershell
docker compose down
```

`docker compose down` keeps the database and Qdrant named volumes. Do not add `--volumes` unless you intend to delete persistent app data.

### What needs a rebuild?

- Editing files under `apps/web` or `apps/agent`: no image rebuild; development mode reloads them.
- Editing shared code under `packages/`: rebuild the agent dependency chain with `npm exec -- turbo run build --filter=agent... --ui=stream`, then restart the dev process/container.
- Changing dependencies: run `npm install` in host mode. In Docker mode, run `docker compose exec web npm install` to update the Linux dependency volumes. Rebuild app images after changing a Dockerfile.

For host-run mode, restart `npm run dev` after rebuilding shared packages. In Docker mode, build shared packages in the agent container and restart it so the running agent reloads the generated output:

```powershell
docker compose exec agent npm exec -- turbo run build --filter=agent... --ui=stream
docker compose restart agent
```

### 3. Use the dashboard

- Create a project with a GitHub repository URL. Private repositories can use a read-only clone credential and a separate write token.
- Configure the LLM provider, model, and API key with the settings button if you did not configure them in `.env`.
- Start a task, follow its live events, inspect sandbox files, and reply to agent questions.
- Resume paused tasks, cancel running tasks, or explicitly destroy the project sandbox.

Vector memory is optional and needs a configured embedding provider/key and a reachable Qdrant service. The basic Groq setup above does not require a separate embedding key.

## Typical workflow

A normal workflow looks like this:

1. Open the dashboard.
2. Create a new project.
3. Start a task such as coding, refactoring, or file generation.
4. Watch progress in the live stream.
5. Check logs and results when the task finishes.
6. Use token metrics to understand usage and cost.

## Development notes

In Docker development, Compose keeps Linux dependencies and generated files in Docker volumes while mounting the source tree for live reload. In host development, npm runs both app watchers directly, but Docker Desktop is still required for sandboxes.

This repo is organized into a monorepo:

- apps/web: frontend dashboard
- apps/agent: backend agent service and task logic
- packages/core: common runtime and sandbox utilities
- prisma/schema: database model

## Important security note

This project uses Docker from inside the agent service. That gives the agent the ability to start and manage containers on your machine. The web and agent ports bind to host loopback, and sandbox containers use a separate network from the agent API.

This is intended for one trusted local user, not as a multi-user service. The Docker socket remains host-level access, and code inside a sandbox is untrusted; do not expose these ports or attach the agent to networks containing untrusted containers.

Keep the agent API and Docker socket private. Do not run this in a public or shared environment unless you fully understand the risks.

## Summary

CuteBots is a local AI coding agent platform that helps you:
- manage coding projects,
- run AI tasks in isolated sandboxes,
- monitor progress live,
- recover from crashes,
- and understand what work is being done.

It is best for local experimentation, prototyping, and learning how an AI coding assistant can work inside a real development environment.
