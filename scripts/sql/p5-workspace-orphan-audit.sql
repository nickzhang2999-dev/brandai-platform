-- P5 pre-migration audit. Read only: never repairs/deletes source rows.
-- Counts must be captured on the actual target DB before any approved migration.
-- AsyncTask / StudioMaterialUpload / StudioDecompositionRequest retain cleanup
-- markers after brand deletion; UsageLog retains billing history. Their orphan
-- counts are deliberate retention candidates, not permission to purge rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'Membership' AS table_name, count(*)::bigint AS orphan_count FROM "Membership" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioBrandCreation' AS table_name, count(*)::bigint AS orphan_count FROM "StudioBrandCreation" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'Asset' AS table_name, count(*)::bigint AS orphan_count FROM "Asset" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'WatermarkPreset' AS table_name, count(*)::bigint AS orphan_count FROM "WatermarkPreset" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'AssetFolder' AS table_name, count(*)::bigint AS orphan_count FROM "AssetFolder" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'BrandRule' AS table_name, count(*)::bigint AS orphan_count FROM "BrandRule" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'ProhibitionRule' AS table_name, count(*)::bigint AS orphan_count FROM "ProhibitionRule" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'RuleSnapshot' AS table_name, count(*)::bigint AS orphan_count FROM "RuleSnapshot" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'ComplianceTerm' AS table_name, count(*)::bigint AS orphan_count FROM "ComplianceTerm" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'Project' AS table_name, count(*)::bigint AS orphan_count FROM "Project" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'ProjectCanvas' AS table_name, count(*)::bigint AS orphan_count FROM "ProjectCanvas" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'EditorDocument' AS table_name, count(*)::bigint AS orphan_count FROM "EditorDocument" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'WorkbenchBrandDraft' AS table_name, count(*)::bigint AS orphan_count FROM "WorkbenchBrandDraft" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'WorkbenchUserState' AS table_name, count(*)::bigint AS orphan_count FROM "WorkbenchUserState" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'WorkbenchProjectState' AS table_name, count(*)::bigint AS orphan_count FROM "WorkbenchProjectState" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioConversation' AS table_name, count(*)::bigint AS orphan_count FROM "StudioConversation" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'Generation' AS table_name, count(*)::bigint AS orphan_count FROM "Generation" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'AsyncTask' AS table_name, count(*)::bigint AS orphan_count FROM "AsyncTask" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioMaterialUpload' AS table_name, count(*)::bigint AS orphan_count FROM "StudioMaterialUpload" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioBrandMaterialReceipt' AS table_name, count(*)::bigint AS orphan_count FROM "StudioBrandMaterialReceipt" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'UsageLog' AS table_name, count(*)::bigint AS orphan_count FROM "UsageLog" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioGenerationRequest' AS table_name, count(*)::bigint AS orphan_count FROM "StudioGenerationRequest" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioGenerationOutput' AS table_name, count(*)::bigint AS orphan_count FROM "StudioGenerationOutput" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioGeneratedMaterial' AS table_name, count(*)::bigint AS orphan_count FROM "StudioGeneratedMaterial" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'StudioDecompositionRequest' AS table_name, count(*)::bigint AS orphan_count FROM "StudioDecompositionRequest" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
UNION ALL
SELECT 'WorkbenchKnowledgeImport' AS table_name, count(*)::bigint AS orphan_count FROM "WorkbenchKnowledgeImport" child LEFT JOIN "BrandWorkspace" ws ON ws.id = child."workspaceId" WHERE child."workspaceId" IS NOT NULL AND ws.id IS NULL
ORDER BY table_name;

SELECT 'Generation.projectId' AS relation_name, count(*)::bigint AS mismatch_count FROM "Generation" child JOIN "Project" parent ON parent."id" = child."projectId" WHERE child."workspaceId" <> parent."workspaceId"
UNION ALL
SELECT 'StudioBrandMaterialReceipt.assetId' AS relation_name, count(*)::bigint AS mismatch_count FROM "StudioBrandMaterialReceipt" child JOIN "Asset" parent ON parent."id" = child."assetId" WHERE child."workspaceId" <> parent."workspaceId"
UNION ALL
SELECT 'StudioGenerationRequest.generationId' AS relation_name, count(*)::bigint AS mismatch_count FROM "StudioGenerationRequest" child JOIN "Generation" parent ON parent."id" = child."generationId" WHERE child."workspaceId" <> parent."workspaceId"
UNION ALL
SELECT 'StudioGenerationOutput.requestId' AS relation_name, count(*)::bigint AS mismatch_count FROM "StudioGenerationOutput" child JOIN "StudioGenerationRequest" parent ON parent."id" = child."requestId" WHERE child."workspaceId" <> parent."workspaceId"
UNION ALL
SELECT 'StudioGeneratedMaterial.requestId' AS relation_name, count(*)::bigint AS mismatch_count FROM "StudioGeneratedMaterial" child JOIN "StudioGenerationRequest" parent ON parent."id" = child."requestId" WHERE child."workspaceId" <> parent."workspaceId"
UNION ALL
SELECT 'StudioGeneratedMaterial.outputId' AS relation_name, count(*)::bigint AS mismatch_count FROM "StudioGeneratedMaterial" child JOIN "StudioGenerationOutput" parent ON parent."id" = child."outputId" WHERE child."workspaceId" <> parent."workspaceId"
ORDER BY relation_name;
COMMIT;

