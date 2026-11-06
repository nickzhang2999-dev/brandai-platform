import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { InspirationSnapshotManifest, InspirationSnapshotObjectDescriptor } from '@brandai/contracts';
import { canonical, sha256 } from '../src/lib/inspiration/protocol';
import { validateSnapshotManifest, validateSnapshotPart, validateSnapshotObject, validateSnapshotInventory } from '../src/lib/inspiration/snapshot-protocol';
import { bytes, describePart, fixture, keys, recipient, replaceParts, signed } from './helpers/inspiration-snapshot-fixture';

describe('bounded snapshot v3 protocol', () => {
  it.each([0, 2001, 10000])('authenticates a %i-record complete snapshot without the legacy 2000-record cap', async count => {
    const f = await fixture(count), manifest = validateSnapshotManifest(bytes(f.manifest), keys, recipient);
    const parts = f.parts.map((part, index) => validateSnapshotPart(bytes(part), manifest.parts[index]!, manifest));
    expect(validateSnapshotInventory(manifest, parts)).toEqual({recordsCount: count, imageCount: count ? 1 : 0, imageBytes: count ? f.image.length : 0});
    if (count) await expect(validateSnapshotObject(f.image, f.object)).resolves.toBeUndefined();
  }, 30_000);

  it('rejects invalid signatures, keys, wrong recipients and unknown envelope fields', async () => {
    const {manifest} = await fixture();
    expect(() => validateSnapshotManifest(bytes({...manifest, sequence: 2}), keys, recipient)).toThrow('signature');
    expect(() => validateSnapshotManifest(bytes(manifest), {}, recipient)).toThrow('signing key');
    expect(() => validateSnapshotManifest(bytes(manifest), keys, {...recipient, library_id: 'other'})).toThrow('recipient');
    expect(() => validateSnapshotManifest(bytes(manifest), keys, {...recipient, origin: 'https://other.example.invalid'})).toThrow('recipient');
    expect(() => validateSnapshotManifest(bytes({...manifest, arbitrary: true}), keys, recipient)).toThrow();
  });

  it('rejects oversized and noncanonical roots before retaining a package', async () => {
    const {manifest} = await fixture();
    expect(() => validateSnapshotManifest(Buffer.alloc(1024 * 1024 + 1), keys, recipient)).toThrow('size limit');
    expect(() => validateSnapshotManifest(Buffer.from(JSON.stringify(manifest)), keys, recipient)).toThrow('Noncanonical');
    expect(() => validateSnapshotManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(manifest)]), keys, recipient)).toThrow('Noncanonical');
    const raw = bytes(manifest).toString().replace('"schema_version":3', '"schema_version":3,"schema_version":3');
    expect(() => validateSnapshotManifest(Buffer.from(raw), keys, recipient)).toThrow('Noncanonical');
    expect(() => validateSnapshotManifest(Buffer.from([0xff, 0x0a]), keys, recipient)).toThrow();
  });

  it('rejects unsorted, overlapping or duplicate part descriptors and incorrect totals', async () => {
    const {manifest} = await fixture(30);
    const check = (update: Partial<typeof manifest>) => validateSnapshotManifest(bytes(signed({...manifest, ...update})), keys, recipient);
    expect(() => check({parts: [...manifest.parts].reverse()})).toThrow('prefixes');
    const first = manifest.parts[0]!;
    expect(() => check({parts: [first, {...first, prefix: first.prefix + '0', sha256: 'e'.repeat(64)}]})).toThrow('prefixes');
    expect(() => check({parts: [first, {...first, prefix: 'ff'}]})).toThrow('checksum');
    expect(() => check({records_count: manifest.records_count + 1})).toThrow('record total');
    expect(() => check({records_count: 100001})).toThrow();
    expect(() => check({parts: [], records_count: 0})).toThrow('empty snapshot');
  });

  it('rejects missing, changed and extra parts', async () => {
    const f = await fixture(30), descriptor = f.manifest.parts[0]!, part = f.parts[0]!;
    expect(() => validateSnapshotPart(Buffer.concat([bytes(part), Buffer.from(' ')]), descriptor, f.manifest)).toThrow('checksum');
    expect(() => validateSnapshotPart(bytes(part), {...descriptor, sha256: 'e'.repeat(64)}, f.manifest)).toThrow('not in manifest');
    expect(() => validateSnapshotInventory(f.manifest, f.parts.slice(1))).toThrow('Incomplete');
    expect(() => validateSnapshotInventory(f.manifest, [f.parts[0]!, ...f.parts.slice(0, -1)])).toThrow('Duplicate');
  });

  it('rejects duplicate/unsorted IDs, misplaced hash prefixes, delete records and broken case hashes', async () => {
    const f = await fixture(2001), original = f.parts.find(p => p.records.length > 2)!;
    const check = (edit: (p: typeof original) => void) => {
      const part = structuredClone(original);edit(part);
      const manifest = replaceParts(f.manifest, [part]);
      return validateSnapshotPart(bytes(part), describePart(part), manifest);
    };
    expect(() => check(p => {p.records[1] = p.records[0]!;})).toThrow('Duplicate');
    expect(() => check(p => {p.records.reverse();})).toThrow('unsorted');
    expect(() => check(p => {p.prefix = p.prefix === 'ff' ? 'ee' : 'ff';})).toThrow('prefix');
    expect(() => check(p => {p.records[0]!.content_hash = 'd'.repeat(64);})).toThrow('Invalid case');
    expect(() => check(p => {Object.assign(p.records[0]!, {op: 'delete'});})).toThrow();
  });

  it('rejects record-sized payloads before case processing', async () => {
    const f = await fixture(1), part = f.parts[0]!;
    part.records[0]!.case.extra = 'x'.repeat(1024 * 1024);
    part.records[0]!.content_hash = sha256(canonical(part.records[0]!.case));
    const manifest = replaceParts(f.manifest, [part]);
    expect(() => validateSnapshotPart(bytes(part), manifest.parts[0]!, manifest)).toThrow('record size');
  });

  it('retains current case grants, evidence references and exact image inventory', async () => {
    const f = await fixture(1), original = f.parts[0]!;
    const check = (edit: (p: typeof original) => void) => {
      const part = structuredClone(original);edit(part);
      part.records[0]!.content_hash = sha256(canonical(part.records[0]!.case));
      const manifest = replaceParts(f.manifest, [part]);
      return validateSnapshotPart(bytes(part), manifest.parts[0]!, manifest);
    };
    expect(() => check(p => {p.records[0]!.case.editorial = {};})).toThrow('recipient');
    expect(() => check(p => {p.records[0]!.case.claims[0]!.image_ids = ['missing'];})).toThrow('evidence');
    expect(() => check(p => {p.objects[0] = {...p.objects[0]!, path: `images/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64)};})).toThrow('Missing');
    expect(() => check(p => {p.objects.push({...p.objects[0]!, path: `images/${'f'.repeat(64)}.png`, sha256: 'f'.repeat(64)});p.objects.sort((a,b)=>a.path < b.path ? -1 : 1);})).toThrow('Unreferenced');
  });

  it('checks global unique image totals and conflicting declarations across parts', async () => {
    const f = await fixture(30);
    expect(() => validateSnapshotInventory({...f.manifest, image_count: 2}, f.parts)).toThrow('total');
    expect(() => validateSnapshotInventory({...f.manifest, image_bytes: f.image.length + 1}, f.parts)).toThrow('total');
    f.parts[1]!.objects[0] = {...f.parts[1]!.objects[0]!, width: 4};
    const manifest = replaceParts(f.manifest, f.parts);
    expect(() => validateSnapshotInventory(manifest, f.parts)).toThrow('Conflicting');
  });

  it('enforces exact byte hash, MIME and decoded dimensions, not just a valid header', async () => {
    const f = await fixture(1);
    await expect(validateSnapshotObject(Buffer.concat([f.image, Buffer.from('x')]), f.object)).rejects.toThrow('checksum');
    await expect(validateSnapshotObject(f.image, {...f.object, width: 4})).rejects.toThrow('dimensions');
    const pngAsJpeg = {...f.object, path: `images/${f.object.sha256}.jpg`, mime: 'image/jpeg' as const};
    await expect(validateSnapshotObject(f.image, pngAsJpeg)).rejects.toThrow('format');
    const truncated = f.image.subarray(0, 42), digest = sha256(truncated);
    await expect(validateSnapshotObject(truncated, {...f.object, sha256: digest, path: `images/${digest}.png`, size: truncated.length})).rejects.toThrow();
    const gif = await sharp({create: {width: 3, height: 2, channels: 3, background: 'red'}}).gif().toBuffer(), gifHash = sha256(gif);
    await expect(validateSnapshotObject(gif, {...f.object, sha256: gifHash, path: `images/${gifHash}.png`, size: gif.length})).rejects.toThrow('Unsupported');
    // Two synthetic 2x2 solid-color frames generated locally with Pillow.
    const animated = Buffer.from('UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABkAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA', 'base64');
    const animatedHash = sha256(animated);
    await expect(validateSnapshotObject(animated, {sha256: animatedHash, path: `images/${animatedHash}.webp`, size: animated.length, mime: 'image/webp', width: 2, height: 2})).rejects.toThrow('Unsupported');
    expect(InspirationSnapshotObjectDescriptor.safeParse({...f.object, width: 40_000_000, height: 2}).success).toBe(false);
  });

  it('keeps explicit nullable parent separate from omitted or coercible fields', async () => {
    const f = await fixture(0);
    expect(InspirationSnapshotManifest.safeParse(f.manifest).success).toBe(true);
    const {parent_release_id: _, ...missing} = f.manifest;
    for (const invalid of [missing, {...f.manifest, sequence: '1'}, {...f.manifest, withdrawal_sequence: null}, {...f.manifest, records_count: true}]) {
      expect(InspirationSnapshotManifest.safeParse(invalid).success).toBe(false);
    }
  });
});
