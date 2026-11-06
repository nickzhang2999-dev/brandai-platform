import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InspirationSnapshotManifest, InspirationSnapshotObjectDescriptor, InspirationSnapshotPartDescriptor } from '../src/inspiration-snapshot';

const vectors = JSON.parse(readFileSync(new URL('../protocol-fixtures/inspiration-snapshot-shapes.json', import.meta.url), 'utf8')) as {
  manifest: Record<string, unknown>; cases: Array<{name: string; path?: string; value?: unknown; remove?: boolean; valid: boolean}>;
};
describe('snapshot wire shapes shared with Python', () => {
  it.each(vectors.cases)('$name', test => {
    const value = structuredClone(vectors.manifest);
    if (test.path) {
      const segments = test.path.split('.'), leaf = segments.pop()!;
      let object = value;
      for (const segment of segments) object = object[segment] as Record<string, unknown>;
      if (test.remove) delete object[leaf]; else object[leaf] = test.value;
    }
    expect(InspirationSnapshotManifest.safeParse(value).success).toBe(test.valid);
  });
  it('retains finite descriptor budgets and binds hash/extension/dimensions', () => {
    const hash = 'a'.repeat(64), part = {prefix: 'ab', sha256: hash, size: 1, records_count: 1};
    expect(InspirationSnapshotPartDescriptor.safeParse(part).success).toBe(true);
    for (const update of [{prefix: 'a'}, {prefix: 'abcdefabc'}, {size: 8 * 1024 * 1024 + 1}, {records_count: 2001}, {path: 'unexpected'}]) {
      expect(InspirationSnapshotPartDescriptor.safeParse({...part, ...update}).success).toBe(false);
    }
    const object = {path: `images/${hash}.png`, sha256: hash, size: 10, mime: 'image/png', width: 1, height: 1};
    expect(InspirationSnapshotObjectDescriptor.safeParse(object).success).toBe(true);
    for (const update of [{sha256: 'b'.repeat(64)}, {mime: 'image/jpeg'}, {width: 40_000_000, height: 2}, {size: 20 * 1024 * 1024 + 1}, {path: `images/../${hash}.png`}]) {
      expect(InspirationSnapshotObjectDescriptor.safeParse({...object, ...update}).success).toBe(false);
    }
  });
});
