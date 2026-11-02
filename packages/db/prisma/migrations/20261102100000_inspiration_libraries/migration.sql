BEGIN;

-- Separate immutable publication storage from the brand using its references.
CREATE TYPE "InspirationLibraryKind" AS ENUM ('WORKSPACE', 'SHARED');
CREATE TABLE "InspirationLibraryIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "inspiration_library_identity_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    RAISE EXCEPTION 'Library recipient identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InspirationLibraryIdentity_immutable" BEFORE UPDATE ON "InspirationLibraryIdentity"
FOR EACH ROW EXECUTE FUNCTION "inspiration_library_identity_immutable"();
CREATE TABLE "InspirationLibrary" (
  "id" TEXT NOT NULL,
  "kind" "InspirationLibraryKind" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "legacyWorkspaceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InspirationLibrary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InspirationLibrary_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InspirationLibrary_legacyWorkspaceId_fkey" FOREIGN KEY ("legacyWorkspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InspirationLibrary_scope_check" CHECK (("kind" = 'WORKSPACE' AND "legacyWorkspaceId" IS NOT NULL AND "id" = "legacyWorkspaceId") OR ("kind" = 'SHARED' AND "legacyWorkspaceId" IS NULL))
);
CREATE UNIQUE INDEX "InspirationLibrary_legacyWorkspaceId_key" ON "InspirationLibrary"("legacyWorkspaceId");
CREATE INDEX "InspirationLibrary_ownerId_kind_idx" ON "InspirationLibrary"("ownerId", "kind");
-- Existing private packages retain their original workspace identity and grants.
INSERT INTO "InspirationLibrary" ("id","kind","ownerId","legacyWorkspaceId")
SELECT "id",'WORKSPACE',"ownerId","id" FROM "BrandWorkspace";
ALTER TABLE "InspirationState" DROP CONSTRAINT "InspirationState_workspaceId_fkey";
ALTER TABLE "InspirationState" RENAME COLUMN "workspaceId" TO "libraryId";
ALTER TABLE "InspirationState" ADD CONSTRAINT "InspirationState_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspirationRelease" DROP CONSTRAINT "InspirationRelease_workspaceId_fkey";
ALTER TABLE "InspirationRelease" RENAME COLUMN "workspaceId" TO "libraryId";
ALTER TABLE "InspirationRelease" ADD CONSTRAINT "InspirationRelease_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspirationRecord" DROP CONSTRAINT "InspirationRecord_workspaceId_fkey";
ALTER TABLE "InspirationRecord" RENAME COLUMN "workspaceId" TO "libraryId";
ALTER TABLE "InspirationRecord" ADD CONSTRAINT "InspirationRecord_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspirationImage" DROP CONSTRAINT "InspirationImage_workspaceId_fkey";
ALTER TABLE "InspirationImage" RENAME COLUMN "workspaceId" TO "libraryId";
ALTER TABLE "InspirationImage" ADD CONSTRAINT "InspirationImage_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER INDEX "InspirationRelease_workspaceId_releaseId_key" RENAME TO "InspirationRelease_libraryId_releaseId_key";
ALTER INDEX "InspirationRelease_workspaceId_sequence_key" RENAME TO "InspirationRelease_libraryId_sequence_key";
ALTER INDEX "InspirationRecord_workspaceId_caseId_revision_key" RENAME TO "InspirationRecord_libraryId_caseId_revision_key";
ALTER INDEX "InspirationRecord_workspaceId_caseId_idx" RENAME TO "InspirationRecord_libraryId_caseId_idx";
ALTER INDEX "InspirationImage_workspaceId_releaseId_path_key" RENAME TO "InspirationImage_libraryId_releaseId_path_key";
ALTER TABLE "InspirationChat" ADD COLUMN "libraryId" TEXT;
UPDATE "InspirationChat" SET "libraryId" = "workspaceId";
ALTER TABLE "InspirationChat" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "InspirationChat" ADD CONSTRAINT "InspirationChat_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspirationBookmark" ADD COLUMN "libraryId" TEXT;
UPDATE "InspirationBookmark" SET "libraryId" = "workspaceId";
ALTER TABLE "InspirationBookmark" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "InspirationBookmark" ADD CONSTRAINT "InspirationBookmark_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspirationFeedback" ADD COLUMN "libraryId" TEXT;
UPDATE "InspirationFeedback" SET "libraryId" = "workspaceId";
ALTER TABLE "InspirationFeedback" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "InspirationFeedback" ADD CONSTRAINT "InspirationFeedback_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "InspirationBookmark_workspaceId_userId_caseId_projectId_key";
CREATE UNIQUE INDEX "InspirationBookmark_workspaceId_userId_libraryId_caseId_projectId_key" ON "InspirationBookmark"("workspaceId","userId","libraryId","caseId","projectId");
ALTER TABLE "AsyncTask" ADD COLUMN "inspirationLibraryId" TEXT;
UPDATE "AsyncTask" t SET "inspirationLibraryId" = t."workspaceId" WHERE t."kind" = 'INSPIRATION_SYNC' AND EXISTS (SELECT 1 FROM "InspirationLibrary" l WHERE l."id" = t."workspaceId");
ALTER TABLE "AsyncTask" ADD CONSTRAINT "AsyncTask_inspirationLibraryId_fkey" FOREIGN KEY ("inspirationLibraryId") REFERENCES "InspirationLibrary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AsyncTask_inspirationLibraryId_kind_createdAt_idx" ON "AsyncTask"("inspirationLibraryId","kind","createdAt");

COMMIT;
