-- Bounded, admin-only diagnostics for generation failures and browser observations.
CREATE TABLE "novel_error_reports" (
    "id" SERIAL NOT NULL,
    "report_id" TEXT NOT NULL,
    "user_id" INTEGER,
    "project_id" INTEGER,
    "chapter_id" INTEGER,
    "job_id" TEXT,
    "request_id" TEXT,
    "trace_id" TEXT,
    "client_event_id" TEXT,
    "code" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "gate" TEXT,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'server',
    "safe_message" TEXT NOT NULL,
    "diagnostic" JSONB,
    "error_fingerprint" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "pinned_at" TIMESTAMP(3),

    CONSTRAINT "novel_error_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_error_reports_report_id_key" ON "novel_error_reports"("report_id");
CREATE UNIQUE INDEX "novel_error_reports_client_event_id_key" ON "novel_error_reports"("client_event_id");
CREATE INDEX "novel_error_reports_expires_at_pinned_at_idx" ON "novel_error_reports"("expires_at", "pinned_at");
CREATE INDEX "novel_error_reports_job_id_created_at_idx" ON "novel_error_reports"("job_id", "created_at");
CREATE INDEX "novel_error_reports_project_id_created_at_idx" ON "novel_error_reports"("project_id", "created_at");
CREATE INDEX "novel_error_reports_code_created_at_idx" ON "novel_error_reports"("code", "created_at");
