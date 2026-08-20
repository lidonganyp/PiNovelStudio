-- CreateTable
CREATE TABLE "novel_projects" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "genre" TEXT NOT NULL DEFAULT '',
    "sub_genres" JSONB NOT NULL DEFAULT '[]',
    "world_key_terms" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "workflow_state" TEXT NOT NULL DEFAULT 'project_created',
    "last_active_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapters" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generation_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapter_seeds" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "intent" TEXT NOT NULL DEFAULT '',
    "must_include" TEXT NOT NULL DEFAULT '',
    "forbidden_facts" TEXT NOT NULL DEFAULT '',
    "character_motives" TEXT NOT NULL DEFAULT '',
    "promises" TEXT NOT NULL DEFAULT '',
    "ending_goal" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "novel_chapter_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapter_versions" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "version_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "generation_job_id" TEXT,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_chapter_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_characters" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "role_type" TEXT NOT NULL DEFAULT 'other',
    "identity" TEXT NOT NULL DEFAULT '',
    "goals" TEXT NOT NULL DEFAULT '',
    "motivation" TEXT NOT NULL DEFAULT '',
    "personality" TEXT NOT NULL DEFAULT '',
    "abilities" TEXT NOT NULL DEFAULT '',
    "relationships" TEXT NOT NULL DEFAULT '',
    "secrets" TEXT NOT NULL DEFAULT '',
    "character_arc" TEXT NOT NULL DEFAULT '',
    "current_state" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_outline_nodes" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "parent_id" INTEGER,
    "node_type" TEXT NOT NULL DEFAULT 'chapter',
    "title" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "narrative_goal" TEXT NOT NULL DEFAULT '',
    "conflict" TEXT NOT NULL DEFAULT '',
    "turning_point" TEXT NOT NULL DEFAULT '',
    "ending_hook" TEXT NOT NULL DEFAULT '',
    "pov_character_id" INTEGER,
    "involved_character_ids" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_outline_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_documents" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "document_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_document_versions" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "version_number" INTEGER NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "change_summary" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_assistant_messages" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "job_id" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "content_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "novel_assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_feedback" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "chapter_id" INTEGER,
    "job_id" TEXT,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admin_user_id" INTEGER,

    CONSTRAINT "novel_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_generation_jobs" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "chapter_id" INTEGER,
    "job_type" TEXT NOT NULL DEFAULT 'chapter_generation',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "max_charge" BIGINT NOT NULL,
    "settled_amount" BIGINT NOT NULL DEFAULT 0,
    "progress_stage" TEXT NOT NULL DEFAULT 'checking_materials',
    "failure_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "novel_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "novel_projects_user_id_status_idx" ON "novel_projects"("user_id", "status");

-- CreateIndex
CREATE INDEX "novel_chapters_project_id_chapter_number_idx" ON "novel_chapters"("project_id", "chapter_number");

-- CreateIndex
CREATE INDEX "novel_chapters_user_id_idx" ON "novel_chapters"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "novel_chapter_seeds_chapter_id_key" ON "novel_chapter_seeds"("chapter_id");

-- CreateIndex
CREATE INDEX "novel_chapter_seeds_project_id_idx" ON "novel_chapter_seeds"("project_id");

-- CreateIndex
CREATE INDEX "novel_chapter_versions_project_id_idx" ON "novel_chapter_versions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "novel_chapter_versions_chapter_id_version_number_key" ON "novel_chapter_versions"("chapter_id", "version_number");

-- CreateIndex
CREATE INDEX "novel_characters_project_id_idx" ON "novel_characters"("project_id");

-- CreateIndex
CREATE INDEX "novel_outline_nodes_project_id_idx" ON "novel_outline_nodes"("project_id");

-- CreateIndex
CREATE INDEX "novel_outline_nodes_parent_id_idx" ON "novel_outline_nodes"("parent_id");

-- CreateIndex
CREATE INDEX "novel_documents_project_id_document_type_idx" ON "novel_documents"("project_id", "document_type");

-- CreateIndex
CREATE UNIQUE INDEX "novel_document_versions_document_id_version_number_key" ON "novel_document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "novel_assistant_messages_project_id_created_at_idx" ON "novel_assistant_messages"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "novel_feedback_project_id_idx" ON "novel_feedback"("project_id");

-- CreateIndex
CREATE INDEX "novel_feedback_user_id_idx" ON "novel_feedback"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "novel_generation_jobs_job_id_key" ON "novel_generation_jobs"("job_id");

-- CreateIndex
CREATE INDEX "novel_generation_jobs_user_id_status_idx" ON "novel_generation_jobs"("user_id", "status");

-- CreateIndex
CREATE INDEX "novel_generation_jobs_project_id_chapter_id_idx" ON "novel_generation_jobs"("project_id", "chapter_id");

-- AddForeignKey
ALTER TABLE "novel_projects" ADD CONSTRAINT "novel_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapters" ADD CONSTRAINT "novel_chapters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapters" ADD CONSTRAINT "novel_chapters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_seeds" ADD CONSTRAINT "novel_chapter_seeds_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_seeds" ADD CONSTRAINT "novel_chapter_seeds_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_seeds" ADD CONSTRAINT "novel_chapter_seeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_versions" ADD CONSTRAINT "novel_chapter_versions_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_versions" ADD CONSTRAINT "novel_chapter_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_versions" ADD CONSTRAINT "novel_chapter_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_versions" ADD CONSTRAINT "novel_chapter_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_characters" ADD CONSTRAINT "novel_characters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_characters" ADD CONSTRAINT "novel_characters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_outline_nodes" ADD CONSTRAINT "novel_outline_nodes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_outline_nodes" ADD CONSTRAINT "novel_outline_nodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_outline_nodes" ADD CONSTRAINT "novel_outline_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "novel_outline_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_outline_nodes" ADD CONSTRAINT "novel_outline_nodes_pov_character_id_fkey" FOREIGN KEY ("pov_character_id") REFERENCES "novel_characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_documents" ADD CONSTRAINT "novel_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_documents" ADD CONSTRAINT "novel_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_document_versions" ADD CONSTRAINT "novel_document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "novel_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_document_versions" ADD CONSTRAINT "novel_document_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_assistant_messages" ADD CONSTRAINT "novel_assistant_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_assistant_messages" ADD CONSTRAINT "novel_assistant_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_feedback" ADD CONSTRAINT "novel_feedback_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_feedback" ADD CONSTRAINT "novel_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_feedback" ADD CONSTRAINT "novel_feedback_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_feedback" ADD CONSTRAINT "novel_feedback_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_generation_jobs" ADD CONSTRAINT "novel_generation_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_generation_jobs" ADD CONSTRAINT "novel_generation_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "novel_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_generation_jobs" ADD CONSTRAINT "novel_generation_jobs_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "novel_chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
