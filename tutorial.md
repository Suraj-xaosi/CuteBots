# CuteBots tutorial

This guide covers initial setup, running CuteBots, connecting GitHub and Telegram, and using the dashboard. Commands are for Windows PowerShell run from the repository root unless noted.

## Requirements

- Node.js 22 or newer and npm
- Docker Desktop or Docker Engine running; project sandboxes always use Docker
- A Groq API key (or another provider supported by the dashboard)
- A Telegram account if you want Telegram notifications and replies

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
Do not run host mode and Docker mode at the same time: both agent processes would poll the same Telegram bot token.

### Run the web app and agent on Windows

Build the shared agent packages once, then start the web and agent development servers:

```powershell
npm exec -- turbo run build --filter=agent... --ui=stream
npm run dev
```

Keep the terminal open while using the app. Open [http://localhost:3000](http://localhost:3000). The agent health endpoint is [http://localhost:3001/health](http://localhost:3001/health). Press **Ctrl+C** to stop both servers.

The host-run agent uses `localhost` for its local database and Qdrant connection. Vector memory is optional; it requires a configured embedding provider and a reachable Qdrant service. To run Qdrant for host mode, use another terminal:

```powershell
docker compose up -d qdrant
```

Stop Qdrant when finished with:

```powershell
docker compose stop qdrant
```

### Run the web app and agent in Docker

First start builds the app images and starts the app, agent, and Qdrant:

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

This preserves the database and Qdrant data volumes. Do not add `--volumes` unless you intentionally want to delete that data.

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

## Connect Telegram

Telegram can send task status changes, warnings, errors, final results, and agent questions. Replies to a question in Telegram are returned to the waiting task. The dashboard remains usable and can also reply to an agent question.

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts to create a bot.
2. Copy the bot token BotFather returns. Keep it private; anyone with the token can control the bot.
3. Start CuteBots, open the dashboard settings using the gear button, paste the token in the **Telegram bot token** field, and select **Save settings**.
4. Open your new bot using the link BotFather provides and send `/start` in a private chat.
5. The bot confirms the connection. CuteBots saves the paired chat ID encrypted in its local settings database. The pairing persists across restarts.
6. Start a project task. Telegram receives task status and completion messages. When the agent asks a question, reply directly in that chat; the reply is delivered to the waiting task.

The bot uses Telegram long polling, so CuteBots does not need a public URL or webhook. Only the first chat to pair with `/start` is accepted; another chat cannot take over an existing pairing. To pair a different chat, disable Telegram in dashboard settings, save, then configure the token again and send `/start` from the desired chat.

If the bot token is rejected, the dashboard reports the Telegram startup error. Recheck the token with BotFather and save it again. A bot token can also be set in `.env` as `TELEGRAM_BOT_TOKEN`; dashboard settings are convenient for live changes. Keep the encryption key stable.

## Connect GitHub repositories

Create a project from the dashboard's **New project** form and enter its HTTPS GitHub repository URL, such as `https://github.com/owner/repository`.

- **Public repository:** no clone credential is needed to read and clone it.
- **Private repository:** create a GitHub fine-grained personal access token at [GitHub token settings](https://github.com/settings/personal-access-tokens). Restrict it to the one repository. Grant **Contents: Read-only**, then paste it into **Read-only clone credential**. This is enough to clone and pull.
- **Push changes or create pull requests:** create a separate fine-grained token restricted to the repository. Grant **Contents: Read and write** and **Pull requests: Read and write**. Paste it into **GitHub write token**. The agent uses this token for host-side pushes and pull-request creation.

Use the minimum permissions needed. Tokens are encrypted at rest with `SETTINGS_ENCRYPTION_KEY`; do not include tokens in repository URLs or task descriptions. If you only want the agent to inspect or modify a local sandbox without pushing, omit the write token.

## Work in the dashboard

1. Create a project and provide its GitHub repository URL and any required credentials.
2. Start the project's sandbox.
3. Describe the coding task and start it.
4. Follow task events in the dashboard; if Telegram is paired, status and final messages also arrive there.
5. Reply in the dashboard or Telegram when the agent asks a question.
6. Review the files and task status. Resume paused tasks, cancel active tasks, or destroy the sandbox when you are finished.

## Optional settings

- **Web search:** configure a Tavily API key in settings to enable web search.
- **Vector memory:** configure a supported memory LLM and embedding provider/key, and make Qdrant reachable. Without an embedding key, memory is skipped; it is not required for normal task execution.
- **Ollama:** configure a local Ollama-compatible endpoint if you want to use a local model instead of a hosted provider.

## Safety and troubleshooting

CuteBots is intended for one trusted local user, not as a public or multi-user service. The agent has access to the host Docker socket so it can create and control sandboxes. Sandboxes isolate project execution but do not make it safe to expose the Docker daemon or app services to untrusted users. Keep ports bound to localhost and review code before running it outside a sandbox.

- Web dashboard unavailable: confirm the web server/container is running on port 3000.
- Agent API unavailable: check `http://localhost:3001/health` and the agent logs.
- Sandbox won't start: confirm Docker Desktop is running and `cutebots-sandbox-node:latest` exists (`docker image ls cutebots-sandbox-node`).
- Telegram has no messages: confirm the bot token is saved and send `/start` again in its paired chat. Status notifications are sent for task events; ordinary intermediate tool output is kept in the dashboard to avoid flooding chat.
- Private clone or push fails: verify that the fine-grained token includes the correct repository and minimum required permissions, and has not expired.
