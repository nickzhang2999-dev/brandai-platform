-- P5: run scripts/sql/p5-workspace-orphan-audit.sql and review its counts first.
-- No data repair/deletion is performed. A nonzero orphan or scope mismatch
-- requires an explicit remediation decision; adding these FKs must not silently
-- turn an existing cross-brand link into a second cascade deletion path.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Generation" child JOIN "Project" parent ON parent."id" = child."projectId" WHERE child."workspaceId" <> parent."workspaceId"
    UNION ALL
    SELECT 1 FROM "StudioBrandMaterialReceipt" child JOIN "Asset" parent ON parent."id" = child."assetId" WHERE child."workspaceId" <> parent."workspaceId"
    UNION ALL
    SELECT 1 FROM "StudioGenerationRequest" child JOIN "Generation" parent ON parent."id" = child."generationId" WHERE child."workspaceId" <> parent."workspaceId"
    UNION ALL
    SELECT 1 FROM "StudioGenerationOutput" child JOIN "StudioGenerationRequest" parent ON parent."id" = child."requestId" WHERE child."workspaceId" <> parent."workspaceId"
    UNION ALL
    SELECT 1 FROM "StudioGeneratedMaterial" child JOIN "StudioGenerationRequest" parent ON parent."id" = child."requestId" WHERE child."workspaceId" <> parent."workspaceId"
    UNION ALL
    SELECT 1 FROM "StudioGeneratedMaterial" child JOIN "StudioGenerationOutput" parent ON parent."id" = child."outputId" WHERE child."workspaceId" <> parent."workspaceId"
  ) THEN
    RAISE EXCEPTION 'P5 workspace mismatch detected; run the read-only workspace audit and resolve ownership before migrating';
  END IF;
END $$;

-- These records already belong to the workspace's Project/Asset cascade tree.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioBrandMaterialReceipt" ADD CONSTRAINT "StudioBrandMaterialReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioGenerationRequest" ADD CONSTRAINT "StudioGenerationRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioGenerationOutput" ADD CONSTRAINT "StudioGenerationOutput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioGeneratedMaterial" ADD CONSTRAINT "StudioGeneratedMaterial_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cleanup receipts intentionally retain soft workspace identities:
-- AsyncTask -> StudioMaterialUpload, StudioDecompositionRequest.
-- UsageLog remains an append-only billing history; StudioBrandCreation retains
-- its existing SET NULL tombstone. None of these policies are changed here.

CREATE INDEX "AsyncTask_refId_idx" ON "AsyncTask"("refId");
CREATE INDEX "GenerationVersion_parentVersionId_idx" ON "GenerationVersion"("parentVersionId");
CREATE INDEX "StudioConversation_projectId_idx" ON "StudioConversation"("projectId");
CREATE INDEX "StudioConversation_userId_idx" ON "StudioConversation"("userId");
CREATE INDEX "WorkbenchChatDraft_projectId_idx" ON "WorkbenchChatDraft"("projectId");
CREATE INDEX "Asset_replacementAssetId_idx" ON "Asset"("replacementAssetId");
CREATE INDEX "StudioGenerationOutput_workspaceId_idx" ON "StudioGenerationOutput"("workspaceId");

COMMIT;

