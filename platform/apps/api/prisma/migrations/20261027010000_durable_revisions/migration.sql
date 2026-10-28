-- Persist confirmed author revisions and executable chapter jobs.
ALTER TABLE "novel_generation_jobs"
  ADD COLUMN "revision_id" TEXT,
  ADD COLUMN "execution" JSONB,
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_until" TIMESTAMP(3);
CREATE INDEX "novel_generation_jobs_revision_id_idx" ON "novel_generation_jobs"("revision_id");
CREATE TABLE "novel_revisions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "project_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting_confirmation',
  "version" INTEGER NOT NULL DEFAULT 1,
  "input_hash" TEXT NOT NULL,
  "plan" JSONB NOT NULL,
  "pause_code" TEXT,
  "pause_reason" TEXT,
  "lease_owner" TEXT,
  "lease_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "novel_revisions_user_id_project_id_created_at_idx" ON "novel_revisions"("user_id", "project_id", "created_at");
CREATE INDEX "novel_revisions_status_lease_until_idx" ON "novel_revisions"("status", "lease_until");
CREATE UNIQUE INDEX "novel_revisions_one_active_project" ON "novel_revisions"("project_id") WHERE "status" IN ('queued', 'running');
