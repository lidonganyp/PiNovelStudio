-- Retain the original call ledger; reverse failed chapter charges exactly once.
CREATE TABLE "novel_generation_refunds" (
  "id" SERIAL PRIMARY KEY,
  "job_id" TEXT NOT NULL UNIQUE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "from_real" BIGINT NOT NULL,
  "from_bonus" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_generation_refund_nonnegative" CHECK ("from_real" >= 0 AND "from_bonus" >= 0)
);
CREATE INDEX "novel_generation_refunds_user_id_created_at_idx" ON "novel_generation_refunds"("user_id", "created_at");
