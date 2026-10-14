-- One durable receipt per authenticated user's brand-create intent. Existing
-- brands and memberships are retained; no receipt is manufactured for them.
CREATE TABLE "StudioBrandCreation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mutationId" UUID NOT NULL,
  "inputDigest" CHAR(64) NOT NULL,
  "workspaceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioBrandCreation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudioBrandCreation_inputDigest_check" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "StudioBrandCreation_identity_key" ON "StudioBrandCreation"("userId", "mutationId");
CREATE INDEX "StudioBrandCreation_workspaceId_idx" ON "StudioBrandCreation"("workspaceId");

ALTER TABLE "StudioBrandCreation" ADD CONSTRAINT "StudioBrandCreation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioBrandCreation" ADD CONSTRAINT "StudioBrandCreation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
