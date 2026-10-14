-- A brand-library upload is not a fake project. Keep existing project-scoped
-- identities intact; PostgreSQL needs a partial unique index because NULLs in
-- a regular compound UNIQUE do not collide and would duplicate retry uploads.
ALTER TABLE "StudioMaterialUpload" ALTER COLUMN "projectId" DROP NOT NULL;
CREATE UNIQUE INDEX "StudioMaterialUpload_brand_only_mutation_key"
  ON "StudioMaterialUpload" ("workspaceId", "userId", "mutationId")
  WHERE "projectId" IS NULL;
