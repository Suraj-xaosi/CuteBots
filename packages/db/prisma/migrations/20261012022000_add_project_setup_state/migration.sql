ALTER TABLE "Project" ADD COLUMN "setup_status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Project" ADD COLUMN "setup_log" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Project" ADD COLUMN "setup_error" TEXT;
ALTER TABLE "Project" ADD COLUMN "setup_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Project" ADD COLUMN "detected_setup" TEXT;

UPDATE "Project"
SET
    "setup_status" = 'READY',
    "setup_log" = 'Existing workspace retained; dependencies were not reinstalled.',
    "detected_setup" = CASE WHEN "sandbox_type" = char(109, 105, 110, 105, 109, 97, 108) THEN 'No Node.js sandbox' ELSE 'Node.js sandbox' END
WHERE "workspace_ready" = 1;
