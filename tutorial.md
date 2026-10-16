# CuteBots tutorial

Commands are for Windows PowerShell from the repository root.

## Requirements

- Node.js 22 or later and npm
- Docker Desktop running
- A configured model provider and API key

## Configure and run

```powershell
npm install
Copy-Item .env.example .env
```

Set `LLM_PROVIDER`, `LLM_MODEL`, `API_KEY`, and a stable `SETTINGS_ENCRYPTION_KEY` in `.env`. Generate the encryption key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Start the app. CuteBots builds the shared sandbox image automatically when the first project sandbox is created:

```powershell
npm exec -- turbo run build --filter=agent...
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The API health endpoint is [http://localhost:3001/health](http://localhost:3001/health).

## Enable web search

1. Create a Tavily account and copy an API key from its dashboard. Tavily currently offers a free tier; check its current [credits and pricing](https://docs.tavily.com/documentation/api-credits).
2. Open **Settings** in CuteBots and paste the key into **Tavily web search API key**.
3. Save settings. The next task can use the `web_search` tool; the key is encrypted in the local database and is not sent to the project sandbox.

To run the web app and agent in Docker Compose instead:

```powershell
docker compose up --build
```

The SQLite database is stored in the `agent_data` volume in Compose. `docker compose down` preserves it. Avoid `docker compose down --volumes` unless you intend to delete that data.

## Create and use a project

1. Choose **New project**, enter a name and an HTTPS GitHub repository URL.
2. To clone a private repository or let the agent push when asked, provide a fine-grained GitHub token restricted to that repository with **Contents: Read and write** permission. The token is encrypted at rest using `SETTINGS_ENCRYPTION_KEY`. Public cloning works without a token.
3. CuteBots creates a minimal Docker sandbox, clones the repository, and prepares a persistent `cutebots/<project-id>` branch. This stage does not install language runtimes or repository dependencies.
4. Add project-specific notes in **Project context**. The agent includes this context when starting a task. Task messages and activity logs are retained separately as history.
5. Assign one task at a time to the project. During work, the agent can inspect the repository and install tools or dependencies when needed.
6. Use **Cancel task** to interrupt active work. Select that task, enter a follow-up instruction in the task box, and choose **Continue with new instructions** to resume the same task.
7. The project sandbox remains until you explicitly destroy it. Destroying it removes its cloned working directory; starting it again recreates the sandbox and clones the repository again.

If a project already has an active task, CuteBots rejects another task instead of queuing it. Different projects can work independently.

## Current limitations

- CuteBots is for one trusted local user. The agent controls Docker through the host Docker socket; do not expose it or the app to untrusted users.
- Project provisioning currently supports cloning GitHub repositories. Runtime and dependency setup happens during assigned agent work, not during project creation.
- The agent only commits and pushes when the user explicitly asks, and pushes only to the project's working branch. A token with **Contents: Read and write** permission is required.
- SQLite stores task conversation history and a user-maintained project context field. There is no vector database or automatic semantic memory.
