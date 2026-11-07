-- 章节评审质量追踪（quality-trace）：追加式记录每次评审的状态结论与证据，
-- 与评审建议表（upsert 语义，仅保留最新一条）互补，trace 表保留完整历史，
-- 供 releaseGovernance 审计与用户反馈回流取证。
CREATE TABLE "novel_chapter_review_traces" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "chapter_version" INTEGER NOT NULL,
    "generation_job_id" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'advisory',
    "status" TEXT NOT NULL,
    "verdict" TEXT,
    "rationale" TEXT NOT NULL DEFAULT '',
    "risks" JSONB,
    "evidence_spans" JSONB,
    "model" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "novel_chapter_review_traces_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "novel_chapter_review_traces_chapter_id_created_at_idx" ON "novel_chapter_review_traces"("chapter_id", "created_at");
CREATE INDEX "novel_chapter_review_traces_project_id_idx" ON "novel_chapter_review_traces"("project_id");
CREATE INDEX "novel_chapter_review_traces_user_id_idx" ON "novel_chapter_review_traces"("user_id");
ALTER TABLE "novel_chapter_review_traces"
    ADD CONSTRAINT "novel_chapter_review_traces_chapter_id_fkey"
    FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_review_traces"
    ADD CONSTRAINT "novel_chapter_review_traces_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_review_traces"
    ADD CONSTRAINT "novel_chapter_review_traces_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
