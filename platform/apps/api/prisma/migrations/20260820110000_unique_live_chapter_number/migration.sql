-- A chapter number is the stable identity used by generation and context
-- compilation. Keep one live chapter per project/number even under concurrent
-- creates; soft-deleted rows remain recoverable and may be recreated.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM novel_chapters
    WHERE deleted_at IS NULL
    GROUP BY project_id, chapter_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot create unique live chapter-number index: duplicate live chapters exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "novel_chapters_one_live_number_per_project"
  ON "novel_chapters"("project_id", "chapter_number")
  WHERE "deleted_at" IS NULL;
