-- 章节内容评审后置为建议模式：评审建议存储 + 用户决策记录
-- 评审不阻断章节落盘；建议与决策仅作展示与版本链追踪用途

-- 章节评审建议表：每章保留最新一条评审结果（upsert 语义），历史结论随新评审覆盖，
-- 评审原文与证据片段完整保留在 quality trace（runtime 侧）中
CREATE TABLE "novel_chapter_reviews" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "chapter_version" INTEGER NOT NULL,
    "generation_job_id" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'advisory',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verdict" TEXT,
    "rationale" TEXT NOT NULL DEFAULT '',
    "risks" JSONB,
    "evidence_spans" JSONB,
    "model" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "novel_chapter_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_chapter_reviews_chapter_id_key" ON "novel_chapter_reviews"("chapter_id");
CREATE INDEX "novel_chapter_reviews_project_id_idx" ON "novel_chapter_reviews"("project_id");
CREATE INDEX "novel_chapter_reviews_user_id_idx" ON "novel_chapter_reviews"("user_id");

ALTER TABLE "novel_chapter_reviews"
    ADD CONSTRAINT "novel_chapter_reviews_chapter_id_fkey"
    FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_reviews"
    ADD CONSTRAINT "novel_chapter_reviews_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_reviews"
    ADD CONSTRAINT "novel_chapter_reviews_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 章节用户决策表：保留 / 直接重新生成 / 修改大纲后重新生成，构成版本决策链
CREATE TABLE "novel_chapter_decisions" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "chapter_version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "revised_intent" TEXT,
    "new_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_chapter_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "novel_chapter_decisions_chapter_id_created_at_idx" ON "novel_chapter_decisions"("chapter_id", "created_at");
CREATE INDEX "novel_chapter_decisions_project_id_idx" ON "novel_chapter_decisions"("project_id");

ALTER TABLE "novel_chapter_decisions"
    ADD CONSTRAINT "novel_chapter_decisions_chapter_id_fkey"
    FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_decisions"
    ADD CONSTRAINT "novel_chapter_decisions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_chapter_decisions"
    ADD CONSTRAINT "novel_chapter_decisions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 章节主表冗余快照字段：避免列表/详情接口额外联表
ALTER TABLE "novel_chapters"
    ADD COLUMN "review_status" TEXT,
    ADD COLUMN "review_verdict" TEXT,
    ADD COLUMN "review_rationale" TEXT;
