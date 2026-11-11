-- 任务进度事件持久化：生成过程中的进度消息与评审意见全文落库，供任务卡片聊天流回放。
CREATE TABLE "novel_generation_job_events" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "job_id" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "novel_generation_job_events_job_id_created_at_idx" ON "novel_generation_job_events"("job_id", "created_at");
