# CuteBots

CuteBots is a local AI coding workspace for creating projects, running coding tasks in isolated Docker sandboxes, and following agent progress from a browser dashboard. It combines a Next.js web app with a persistent agent service, SQLite storage, and optional Telegram notifications and human-in-the-loop replies.

The agent can work against GitHub repositories, make changes in a per-project sandbox, and report task activity in the dashboard. When Telegram is configured, it can also send task updates and ask for a reply when it needs a decision.

## Project layout

- `apps/web`: Next.js dashboard
- `apps/agent`: API, task queue, agent runtime, and sandbox lifecycle
- `packages/core`: agent loop, tools, channels, and Docker sandbox utilities
- `packages/db`: Prisma schema, migrations, and persistence

## Get started

See [tutorial.md](./tutorial.md) for setup, Groq configuration, GitHub credentials, Telegram bot setup, running with or without Docker, and day-to-day usage.

CuteBots is designed for one trusted local user. The agent controls the host Docker daemon, and sandbox code should be treated as untrusted. Keep the dashboard and agent bound to localhost and do not expose the Docker socket or services to untrusted users.
