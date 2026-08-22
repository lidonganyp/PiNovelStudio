-- Structured FailureEnvelope for chapter-generation jobs.
-- failure_message remains the user-facing reason for older clients.
ALTER TABLE "novel_generation_jobs" ADD COLUMN "failure" JSONB;
