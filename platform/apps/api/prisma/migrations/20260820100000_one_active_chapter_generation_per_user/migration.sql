-- Enforce the documented per-user generation concurrency limit in the database.
-- The service pre-check improves the normal response, while this partial unique
-- index closes the TOCTOU window between that read and job creation.
CREATE UNIQUE INDEX "novel_generation_jobs_one_active_chapter_generation_per_user"
  ON "novel_generation_jobs"("user_id")
  WHERE "job_type" = 'chapter_generation'
    AND "status" IN ('pending', 'running');
