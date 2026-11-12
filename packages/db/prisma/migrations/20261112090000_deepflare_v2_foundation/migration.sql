-- CreateTable
CREATE TABLE "DeepFlareWorkOrder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeepFlareWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepFlareWorkOrderEvent" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "command" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeepFlareWorkOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepFlareWorkOrderDispatch" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeepFlareWorkOrderDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeepFlareWorkOrder_workspaceId_projectId_createdAt_idx" ON "DeepFlareWorkOrder"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DFWorkOrder_create_key" ON "DeepFlareWorkOrder"("workspaceId", "projectId", "createdBy", "mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "DFWorkOrderEvent_mutation_key" ON "DeepFlareWorkOrderEvent"("workOrderId", "actorId", "mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeepFlareWorkOrderEvent_workOrderId_revision_key" ON "DeepFlareWorkOrderEvent"("workOrderId", "revision");

-- CreateIndex
CREATE INDEX "DeepFlareWorkOrderDispatch_status_createdAt_idx" ON "DeepFlareWorkOrderDispatch"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeepFlareWorkOrderDispatch_workOrderId_planVersion_key" ON "DeepFlareWorkOrderDispatch"("workOrderId", "planVersion");

-- AddForeignKey
ALTER TABLE "DeepFlareWorkOrder" ADD CONSTRAINT "DeepFlareWorkOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepFlareWorkOrderEvent" ADD CONSTRAINT "DeepFlareWorkOrderEvent_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "DeepFlareWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepFlareWorkOrderDispatch" ADD CONSTRAINT "DeepFlareWorkOrderDispatch_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "DeepFlareWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
