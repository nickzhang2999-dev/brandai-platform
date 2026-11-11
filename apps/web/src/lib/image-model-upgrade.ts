export const IMAGE26_MODEL = "gpt-image-2.6-sunburst";
export type ImageUpgradeProof = { id: string; requestedModel: string; returnedModel: string | null; requestId: string | null; imageKey: string; sha256: string; totalTokens: number | null };
/** Verify a real image before changing configuration; subsequent releases preserve admin overrides. */
export async function runImage26Upgrade(deps: {
  previousModel: string; alreadyApplied: boolean; configured: boolean;
  probe(model: string): Promise<boolean>;
  generate(model: string): Promise<ImageUpgradeProof>;
  persist(model: string, proof: ImageUpgradeProof): Promise<void>;
}) {
  if (deps.alreadyApplied) return { status: "already-applied", configuredModel: deps.previousModel };
  if (!deps.configured) throw new Error("Existing production provider configuration required");
  if (!await deps.probe(IMAGE26_MODEL)) throw new Error("Target model unavailable on the configured upstream");
  const proof = await deps.generate(IMAGE26_MODEL);
  if (proof.requestedModel !== IMAGE26_MODEL || (proof.returnedModel !== null && proof.returnedModel !== IMAGE26_MODEL)) throw new Error("Verification model mismatch");
  await deps.persist(IMAGE26_MODEL, proof);
  return { status: "applied", configuredModel: IMAGE26_MODEL, ...proof };
}
