-- Preserve project/task history while reducing persisted state to the minimal workflow.
PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;

CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repo_url" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "clone_credential" TEXT,
    "container_id" TEXT,
    "active_task_id" TEXT,
    "branch_name" TEXT,
    "sandbox_status" TEXT NOT NULL DEFAULT 'STOPPED',
    "provision_status" TEXT NOT NULL DEFAULT 'PENDING',
    "provision_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_Project" (
    "id", "name", "repo_url", "context", "clone_credential",
    "container_id", "sandbox_status", "provision_status", "created_at", "updated_at"
)
SELECT
    p."id",
    p."name",
    p."repo_url",
    trim(
        COALESCE((
            SELECT group_concat(pm."fact", char(10))
            FROM "ProjectMemory" pm
            WHERE pm."project_id" = p."id"
        ), '') ||
        CASE
            WHEN EXISTS (SELECT 1 FROM "ProjectMemory" pm WHERE pm."project_id" = p."id")
             AND EXISTS (
                SELECT 1 FROM "TaskMemory" tm
                JOIN "Task" t ON t."id" = tm."task_id"
                WHERE t."project_id" = p."id"
             )
            THEN char(10)
            ELSE ''
        END ||
        COALESCE((
            SELECT group_concat(tm."fact", char(10))
            FROM "TaskMemory" tm
            JOIN "Task" t ON t."id" = tm."task_id"
            WHERE t."project_id" = p."id"
        ), '')
    ),
    p."clone_credential",
    p."container_id",
    p."sandbox_status",
    CASE WHEN p."workspace_ready" = 1 THEN 'READY' ELSE 'PENDING' END,
    p."created_at",
    CURRENT_TIMESTAMP
FROM "Project" p;

CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "completion_summary" TEXT,
    "fail_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "Task_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Task" (
    "id", "project_id", "description", "status", "fail_reason",
    "created_at", "updated_at", "started_at", "completed_at"
)
SELECT
    "id",
    "project_id",
    "description",
    CASE
        WHEN "status" IN ('PENDING', 'RUNNING', 'PAUSED', 'CANCELLED') THEN 'INTERRUPTED'
        WHEN "status" = 'UNVERIFIED' THEN 'AWAITING_APPROVAL'
        ELSE "status"
    END,
    "fail_reason",
    "created_at",
    "updated_at",
    "created_at",
    CASE WHEN "status" IN ('DONE', 'UNVERIFIED', 'FAILED') THEN "updated_at" ELSE NULL END
FROM "Task";

CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" TEXT,
    "tool_call_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Message" ("id", "task_id", "role", "content", "tool_calls", "tool_call_id", "created_at")
SELECT "id", "task_id", "role", "content", "tool_calls", "tool_call_id", "created_at"
FROM "Message";

DROP TABLE "Message";
DROP TABLE "Task";
DROP TABLE "ProjectMemory";
DROP TABLE "TaskMemory";
DROP TABLE "TokenUsage";
DROP TABLE "Project";

ALTER TABLE "new_Project" RENAME TO "Project";
ALTER TABLE "new_Task" RENAME TO "Task";
ALTER TABLE "new_Message" RENAME TO "Message";

CREATE INDEX "Task_project_id_created_at_idx" ON "Task"("project_id", "created_at");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Message_task_id_created_at_idx" ON "Message"("task_id", "created_at");

PRAGMA defer_foreign_keys=OFF;
PRAGMA foreign_keys=ON;
