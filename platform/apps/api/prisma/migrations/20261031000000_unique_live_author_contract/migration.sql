-- 作者审批链的章纲契约与 provenance：每个项目、每个文档类型只应有一份 live 文档。
-- 通用 CRUD 已被 403 阻断；这里用部分唯一索引兜底两个并发 commit 的 create 竞态，
-- 避免同一章节出现多份契约或两个事务写入相同版本号。
-- 谓词限定 chapter_contract% ，不影响其他文档类型的历史数据。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM novel_documents
    WHERE deleted_at IS NULL
      AND document_type LIKE 'chapter_contract%'
    GROUP BY project_id, document_type
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot create unique live author-contract index: duplicate documents exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "novel_documents_one_live_author_contract_per_type"
  ON "novel_documents"("project_id", "document_type")
  WHERE "deleted_at" IS NULL
    AND "document_type" LIKE 'chapter_contract%';
