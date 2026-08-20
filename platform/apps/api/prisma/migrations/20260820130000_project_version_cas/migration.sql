-- Add optimistic-lock versioning to project metadata used by generation preflight.
ALTER TABLE "novel_projects" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
