-- Additive: the existing ProjectCanvas table and old clients remain unchanged.
CREATE TABLE "EditorDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'novart-native-v1',
    "canvas" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EditorDocument_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "EditorDocument_projectId_key" ON "EditorDocument"("projectId");
CREATE INDEX "EditorDocument_workspaceId_idx" ON "EditorDocument"("workspaceId");
ALTER TABLE "EditorDocument" ADD CONSTRAINT "EditorDocument_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
