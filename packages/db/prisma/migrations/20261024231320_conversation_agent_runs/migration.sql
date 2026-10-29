PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "title" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Conversation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "Conversation" ("id", "project_id", "title", "created_at", "updated_at")
SELECT "id", "project_id", "description", "created_at", "updated_at"
FROM "Task";

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "completion_summary" TEXT,
    "fail_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    CONSTRAINT "AgentRun_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "AgentRun" (
    "id", "conversation_id", "status", "completion_summary",
    "fail_reason", "created_at", "updated_at", "started_at", "completed_at"
)
SELECT
    "id", "id",
    CASE
        WHEN "status" IN ('PENDING', 'QUEUED', 'RUNNING', 'PAUSED', 'CANCELLED', 'WAITING_FOR_INPUT')
            THEN 'INTERRUPTED'
        WHEN "status" = 'UNVERIFIED' THEN 'AWAITING_APPROVAL'
        ELSE "status"
    END,
    "completion_summary", "fail_reason", "created_at", "updated_at",
    "started_at", "completed_at"
FROM "Task";

CREATE TABLE "new_AgentLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentLog_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentLog" ("id", "run_id", "type", "content", "created_at")
SELECT "id", "task_id", "type", "content", "created_at" FROM "AgentLog";
DROP TABLE "AgentLog";
ALTER TABLE "new_AgentLog" RENAME TO "AgentLog";
CREATE INDEX "AgentLog_run_id_id_idx" ON "AgentLog"("run_id", "id");

CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "run_id" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" TEXT,
    "tool_call_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" (
    "id", "conversation_id", "run_id", "role", "content",
    "tool_calls", "tool_call_id", "created_at"
)
SELECT
    "id", "task_id", "task_id", "role", "content",
    "tool_calls", "tool_call_id", "created_at"
FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_conversation_id_created_at_idx" ON "Message"("conversation_id", "created_at");
CREATE INDEX "Message_run_id_created_at_idx" ON "Message"("run_id", "created_at");

CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repo_url" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "clone_credential" TEXT,
    "container_id" TEXT,
    "active_run_id" TEXT,
    "branch_name" TEXT,
    "sandbox_status" TEXT NOT NULL DEFAULT 'STOPPED',
    "provision_status" TEXT NOT NULL DEFAULT 'PENDING',
    "provision_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Project_active_run_id_fkey" FOREIGN KEY ("active_run_id") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" (
    "id", "name", "repo_url", "context", "clone_credential", "container_id",
    "branch_name", "sandbox_status", "provision_status", "provision_error",
    "created_at", "updated_at"
)
SELECT
    "id", "name", "repo_url", "context", "clone_credential", "container_id",
    "branch_name", "sandbox_status", "provision_status", "provision_error",
    "created_at", "updated_at"
FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_active_run_id_key" ON "Project"("active_run_id");

DROP TABLE "Task";
CREATE INDEX "Conversation_project_id_created_at_idx" ON "Conversation"("project_id", "created_at");
CREATE INDEX "AgentRun_conversation_id_created_at_idx" ON "AgentRun"("conversation_id", "created_at");
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

PRAGMA defer_foreign_keys=OFF;
PRAGMA foreign_keys=ON;
