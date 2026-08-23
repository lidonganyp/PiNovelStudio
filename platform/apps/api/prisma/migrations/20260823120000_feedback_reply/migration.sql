-- AlterTable
ALTER TABLE "novel_feedback" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "novel_feedback" ADD COLUMN "reply_content" TEXT;
ALTER TABLE "novel_feedback" ADD COLUMN "replied_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "novel_feedback_status_created_at_idx" ON "novel_feedback"("status", "created_at");
