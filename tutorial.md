# CuteBots tutorial

This guide covers initial setup, running CuteBots, connecting a GitHub repository, and using the dashboard. Commands are for Windows PowerShell run from the repository root unless noted.

## Requirements

- Node.js 22 or newer and npm
- Docker Desktop or Docker Engine running; project sandboxes always use Docker
- A Groq API key (or another provider supported by the dashboard)

## Initial setup

Install dependencies and create the local environment file:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Never commit `.env` or put a real credential in `.env.example`. In `.env`, configure Groq like this:

```dotenv
LLM_PROVIDER=groq
LLM_MODEL=openai/gpt-oss-120b
API_KEY=your_groq_api_key
```

Generate a persistent encryption key:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy the output to `SETTINGS_ENCRYPTION_KEY` in `.env`. Keep the same key for as long as encrypted settings and project credentials exist; changing it makes them unreadable. The agent accepts `API_KEY` or `LLM_API_KEY` for the model API credential.

The Groq credential previously shared in the project chat was exposed. Revoke it and use a newly generated key.

Build the sandbox image once. Both run modes need this image:

```powershell
docker build -f infra/Dockerfile.sandbox-node -t cutebots-sandbox-node:latest .
```

## Run CuteBots

Choose one of these modes for the web app and agent. Docker is still required for project sandboxes in either mode.
Do not run host mode and Docker mode at the same time: both agent processes would poll the same task queue.

### Run the web app and agent on Windows

Build the shared agent packages once, then start the web and agent development servers:

```powershell
npm exec -- turbo run build --filter=agent... --ui=stream
npm run dev
```

Keep the terminal open while using the app. Open [http://localhost:3000](http://localhost:3000). The agent health endpoint is [http://localhost:3001/health](http://localhost:3001/health). Press **Ctrl+C** to stop both servers.

### Run the web app and agent in Docker

First start builds the app images and starts the web app and agent:

```powershell
docker compose up --build
```

Next time, start the already-built stack with:

```powershell
docker compose up
```

Open [http://localhost:3000](http://localhost:3000); the agent health endpoint is [http://localhost:3001/health](http://localhost:3001/health). The web and agent containers mount the source tree and watch their code, so normal edits under `apps/web` and `apps/agent` do not require an image rebuild.

Stop the foreground stack with **Ctrl+C**, or from another terminal run:

```powershell
docker compose down
```

This preserves the database volume. Do not add `--volumes` unless you intentionally want to delete that data.

### When rebuilds are needed

- Changes under `apps/web` or `apps/agent`: development watchers reload them.
- Changes to shared code under `packages/`: rebuild the dependent package outputs and restart the agent.

  Host mode:

  ```powershell
  npm exec -- turbo run build --filter=agent... --ui=stream
  ```

  Docker mode:

  ```powershell
  docker compose exec agent npm exec -- turbo run build --filter=agent... --ui=stream
  docker compose restart agent
  ```

- Dependency changes: run `npm install` in host mode. In Docker mode, update the Linux dependency volumes with `docker compose exec web npm install`.
- Dockerfile changes: rebuild the app images with `docker compose up --build`.

## Connect GitHub repositories

Create a project from the dashboard's **New project** form and enter its HTTPS GitHub repository URL, such as `https://github.com/owner/repository`.

- **Public repository:** no clone credential is needed to read and clone it.
- **Private repository:** create a GitHub fine-grained personal access token at [GitHub token settings](https://github.com/settings/personal-access-tokens). Restrict it to the one repository. Grant **Contents: Read-only**, then paste it into **Read-only clone credential**. This is enough to clone and pull.
Tokens are encrypted at rest with `SETTINGS_ENCRYPTION_KEY`; do not include tokens in repository URLs or task descriptions. The current basic agent edits files and runs commands in the sandbox; it does not push branches or create pull requests.

## Work in the dashboard

1. Create a project and provide its GitHub repository URL and any required credentials.
2. Start the project's sandbox.
3. Describe the coding task and start it.
4. Follow task events in the dashboard.
5. Reply in the dashboard when the agent asks a question.
6. Review the files and task status. Resume paused tasks, cancel active tasks, or destroy the sandbox when you are finished.

## Optional settings

- **Ollama:** configure a local Ollama-compatible endpoint if you want to use a local model instead of a hosted provider.

## Safety and troubleshooting

CuteBots is intended for one trusted local user, not as a public or multi-user service. The agent has access to the host Docker socket so it can create and control sandboxes. Sandboxes isolate project execution but do not make it safe to expose the Docker daemon or app services to untrusted users. Keep ports bound to localhost and review code before running it outside a sandbox.

- Web dashboard unavailable: confirm the web server/container is running on port 3000.
- Agent API unavailable: check `http://localhost:3001/health` and the agent logs.
- Sandbox won't start: confirm Docker Desktop is running and `cutebots-sandbox-node:latest` exists (`docker image ls cutebots-sandbox-node`).
- Private clone or push fails: verify that the fine-grained token includes the correct repository and minimum required permissions, and has not expired.
