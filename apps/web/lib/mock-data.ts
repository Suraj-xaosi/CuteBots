export type ProjectStatus = "running" | "stopped" | "paused";
export type TaskStatus = "running" | "done" | "failed" | "waiting";

export type FileNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children?: FileNode[];
};

export type Message = {
  id: string;
  sender: "assistant" | "user" | "system";
  text: string;
  time: string;
};

export const projectList = [
  {
    id: "proj-1",
    name: "cutebots-web",
    repoUrl: "https://github.com/acme/cutebots-web",
    status: "running" as ProjectStatus,
    branch: "agent/task-104",
    updatedAt: "2 min ago",
    sandbox: "Node 20 / Docker",
  },
  {
    id: "proj-2",
    name: "marketing-site",
    repoUrl: "https://github.com/acme/marketing-site",
    status: "paused" as ProjectStatus,
    branch: "agent/task-091",
    updatedAt: "18 min ago",
    sandbox: "Node 20 / Docker",
  },
  {
    id: "proj-3",
    name: "internal-tools",
    repoUrl: "https://github.com/acme/internal-tools",
    status: "stopped" as ProjectStatus,
    branch: "main",
    updatedAt: "1 hour ago",
    sandbox: "Stopped",
  },
];

export const fileTree: FileNode[] = [
  {
    name: "app",
    path: "app",
    kind: "folder",
    children: [
      { name: "layout.tsx", path: "app/layout.tsx", kind: "file" },
      { name: "page.tsx", path: "app/page.tsx", kind: "file" },
      { name: "globals.css", path: "app/globals.css", kind: "file" },
    ],
  },
  {
    name: "components",
    path: "components",
    kind: "folder",
    children: [
      { name: "dashboard-shell.tsx", path: "components/dashboard-shell.tsx", kind: "file" },
      { name: "workspace-panel.tsx", path: "components/workspace-panel.tsx", kind: "file" },
    ],
  },
  { name: "package.json", path: "package.json", kind: "file" },
  { name: "tsconfig.json", path: "tsconfig.json", kind: "file" },
];

export const logs = [
  { id: "1", type: "status", text: "Sandbox started and workspace is ready.", time: "09:41" },
  { id: "2", type: "tool", text: "read_file: app/page.tsx", time: "09:42" },
  { id: "3", type: "status", text: "Task branch created: agent/task-104", time: "09:43" },
  { id: "4", type: "tool", text: "str_replace: updated layout shell and tokens", time: "09:44" },
  { id: "5", type: "status", text: "Validation passed: typecheck succeeded", time: "09:45" },
];

export const taskMessages: Message[] = [
  { id: "m1", sender: "assistant", text: "I’ll review the layout and keep the dashboard components isolated and predictable.", time: "09:41" },
  { id: "m2", sender: "user", text: "Please build the project dashboard and keep it neutral, easy to scan, and fast to reason about.", time: "09:42" },
  { id: "m3", sender: "assistant", text: "I’m updating the shell to use a simple sidebar + workspace + logs layout and reducing effect-driven state to explicit user actions.", time: "09:43" },
  { id: "m4", sender: "assistant", text: "The workspace layout is ready. I’m validating the file tree and log panels before finishing the task.", time: "09:45" },
];

export async function fetchProjects() {
  await new Promise((resolve) => setTimeout(resolve, 350));
  return projectList;
}
