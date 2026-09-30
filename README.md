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

## How to use it

### Prerequisites

You need:
- Node.js and npm
- Docker Desktop or Docker Engine
- A working local environment with permission to run containers

### 1. Install dependencies

From the project root:

```sh
npm install
```

### 2. Build the sandbox image

```sh
docker build -f infra/Dockerfile.sandbox-node -t devin-sandbox-node:latest .
```

### 3. Start the app

```sh
docker compose up --build
```

This starts the app stack locally.

### 4. Open the app

- Web app: http://localhost:3000
- Agent health check: http://localhost:3001/health

### 5. Use the dashboard

- Create a project
- Start a new task
- Watch the logs and task state
- Open a task details view to inspect output and usage
- Cancel or retry when needed

## Typical workflow

A normal workflow looks like this:

1. Open the dashboard.
2. Create a new project.
3. Start a task such as coding, refactoring, or file generation.
4. Watch progress in the live stream.
5. Check logs and results when the task finishes.
6. Use token metrics to understand usage and cost.

## Development notes

This repo is organized into a monorepo:

- apps/web: frontend dashboard
- apps/agent: backend agent service and task logic
- packages/core: common runtime and sandbox utilities
- prisma/schema: database model

## Important security note

This project uses Docker from inside the agent service. That gives the agent the ability to start and manage containers on your machine.

This is useful for local development, but it is also a security risk if the service is exposed to untrusted networks.

Keep the agent API and Docker socket private. Do not run this in a public or shared environment unless you fully understand the risks.

## Summary

CuteBots is a local AI coding agent platform that helps you:
- manage coding projects,
- run AI tasks in isolated sandboxes,
- monitor progress live,
- recover from crashes,
- and understand what work is being done.

It is best for local experimentation, prototyping, and learning how an AI coding assistant can work inside a real development environment.
