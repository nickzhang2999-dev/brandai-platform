CREATE TABLE "BrandDeletionReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mutationId" UUID NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrandDeletionReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandDeletionReceipt_identity_key" ON "BrandDeletionReceipt"("workspaceId", "userId", "mutationId");
CREATE INDEX "BrandDeletionReceipt_actor_idx" ON "BrandDeletionReceipt"("userId", "createdAt");

-- Keep the intentional soft references and cleanup receipts. Only NEW tasks
-- require a live brand; historical orphan rows may still reach terminal states.
-- The key-share lock serializes admission against brand deletion, even for
-- older task factories which do not yet hold an application-level brand lock.
CREATE FUNCTION "require_live_task_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
            RAISE EXCEPTION 'Task workspace identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF NOT (OLD."status"::text NOT IN ('PENDING', 'RUNNING') AND NEW."status"::text IN ('PENDING', 'RUNNING')) THEN
            RETURN NEW;
        END IF;
    END IF;
    PERFORM "id" FROM "BrandWorkspace" WHERE "id" = NEW."workspaceId" FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Task workspace does not exist' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "AsyncTask_live_workspace" BEFORE INSERT OR UPDATE OF "workspaceId", "status" ON "AsyncTask"
FOR EACH ROW EXECUTE FUNCTION "require_live_task_workspace"();
CREATE TRIGGER "StudioDecompositionRequest_live_workspace" BEFORE INSERT OR UPDATE OF "workspaceId", "status" ON "StudioDecompositionRequest"
FOR EACH ROW EXECUTE FUNCTION "require_live_task_workspace"();
