type DeliveryStage = "model_response_received" | "artifact_enqueue" | "worker_claimed" | "asset_persisted";

export function traceStudioDelivery(stage: DeliveryStage, requestId: string, outputId?: string, assetId?: string) {
  if (process.env.DF_STUDIO_DELIVERY_TRACE !== "1") return;
  console.info("[studio-delivery]", JSON.stringify({ stage, at: Date.now(), requestId, outputId, assetId }));
}
