import { describe, expect, it } from "vitest";
import { createOwnedLayerRecovery } from "../../../apps/web/src/components/owned-canvas/owned-layer-recovery";
const identity = { workspaceId: "w", userId: "u", projectId: "p" };
const input = { projectId: "p", mutationId: "00000000-0000-4000-8000-000000000001", sourceShapeId: "shape:a", assetId: "a", assetSha256: "a".repeat(64), documentRevision: 3, layerCount: 4 };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe("layer intake journal", () => {
  it("persists the exact paid intent and restores it on reload without submitting", () => {
    const port = storage(); createOwnedLayerRecovery(identity, port).store(input);
    expect(createOwnedLayerRecovery(identity, port).load()).toEqual(input);
    expect(createOwnedLayerRecovery({ ...identity, userId: "other" }, port).load()).toBeNull();
  });
  it("cannot replace an unresolved input or clear a different mutation", () => {
    const port = storage(), journal = createOwnedLayerRecovery(identity, port); journal.store(input);
    expect(() => journal.store({ ...input, layerCount: 5 })).toThrow();
    expect(() => journal.clear({ ...input, documentRevision: 4 })).toThrow();
    expect(journal.load()).toEqual(input); journal.clear(input); expect(journal.load()).toBeNull();
  });
  it("restores an exact AUTO request and never replaces it with a manual guess", () => {
    const { layerCount: _unused, ...source } = input;
    const automatic = { ...source, layerMode: "AUTO" as const };
    const port = storage(), journal = createOwnedLayerRecovery(identity, port);
    expect(journal.store(automatic)).toEqual(automatic);
    expect(createOwnedLayerRecovery(identity, port).load()).toEqual(automatic);
    expect(() => journal.store(input)).toThrow(); expect(() => journal.clear(input)).toThrow();
    expect(journal.load()).toEqual(automatic); journal.clear(automatic); expect(journal.load()).toBeNull();
  });
  it("fails closed if a write does not survive readback or the record is malformed", () => {
    const port = storage(); const broken = { ...port, setItem() {} };
    expect(() => createOwnedLayerRecovery(identity, broken).store(input)).toThrow();
    const journal = createOwnedLayerRecovery(identity, port); journal.store(input);
    const key = [...port.values.keys()][0]!; port.values.set(key, "corrupt input"); expect(() => journal.load()).toThrow(); expect(port.getItem(key)).toBe("corrupt input");
  });
});
