# CuteBots

CuteBots is a local coding agent app. It lets you connect a project, chat with an AI agent, and have the agent work with the project's files in an isolated sandbox (docker container which will be run locally on pc).

## Architecture

- `apps/web` is the Next.js application. It provides the dashboard and handles project, conversation, credential, and run requests.
- `packages/core` runs the AI agent, connects to AI providers, and provides tools for working with project files and commands.
- `packages/core` also manages Docker sandboxes, where each project's code and commands are isolated.
- `packages/db` uses Prisma and SQLite to store projects, conversations, runs, and settings.
- `packages/types` contains types shared between the web app, core, and database packages.
- `packages/ui` contains reusable interface components.

The browser uses the web app to start and manage agent runs. The core package runs the agent and its tools in the project's sandbox, while the database stores the application's data. Run activity is sent to the browser as a live event stream.

## How the agent works

When you send a message, the web app checks the project settings and makes sure its sandbox is ready. The agent loads the conversation history and sends it to the selected AI provider along with instructions and the tools it can use.

The agent repeats a simple cycle: ask the AI what to do, run any requested tools in the project's sandbox, and send the results back to the AI. Tools can inspect and edit files, run commands, and search the project. Depending on the project's settings, the agent can also ask you a question, search the web, or push changes to the repository. When it has finished, its response and run activity are saved and shown in the dashboard.
