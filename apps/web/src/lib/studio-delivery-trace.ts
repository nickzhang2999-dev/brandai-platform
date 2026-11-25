type DeliveryStage = "generation_claimed" | "model_request_started" | "model_response_received" | "artifact_enqueue" | "worker_claimed" | "asset_persisted";

export function studioTimingEnabled() {
  const override = process.env.DF_STUDIO_DELIVERY_TRACE;
  if (override !== undefined) return override === "1";
  return process.env.VITE_GIT_BRANCH === "review/p0-canvas-recovery" ||
    process.env.BRANDAI_QUEUE_PREFIX === "brandai-review-p0-canvas-recovery";
}

export function traceStudioDelivery(stage: DeliveryStage, requestId: string, outputId?: string, assetId?: string) {
  if (!studioTimingEnabled()) return;
  console.info("[studio-delivery]", JSON.stringify({ stage, at: Date.now(), requestId, outputId, assetId }));
}
