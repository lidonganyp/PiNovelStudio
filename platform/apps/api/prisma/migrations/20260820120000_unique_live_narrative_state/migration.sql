-- A project has one live narrative-state document.  Generation may create it
-- on first delivery, while a user can create/edit documents concurrently.
-- The partial unique index closes that create-vs-create race.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM novel_documents
    WHERE deleted_at IS NULL
      AND document_type = 'narrative_state'
    GROUP BY project_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot create unique live narrative-state index: duplicate documents exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "novel_documents_one_live_narrative_state_per_project"
  ON "novel_documents"("project_id")
  WHERE "deleted_at" IS NULL
    AND "document_type" = 'narrative_state';
