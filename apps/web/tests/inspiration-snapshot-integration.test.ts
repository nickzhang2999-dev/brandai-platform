import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({state: vi.fn(), session: vi.fn(), create: vi.fn(), tick: vi.fn(), object: vi.fn(), legacy: vi.fn(), fetch: vi.fn(), keys: {} as Record<string, string>}));
vi.mock('@brandai/db', () => ({prisma: {inspirationState: {findUnique: f.state}, inspirationSnapshotImport: {findUnique: f.session}, inspirationImage: {findUnique: f.legacy}}}));
vi.mock('../src/lib/inspiration/snapshot-import', () => ({createSnapshotImport: f.create, syncSnapshotTick: f.tick, getSnapshotObject: f.object}));
vi.mock('../src/lib/inspiration/config', async importOriginal => ({...await importOriginal<object>(),
  syncConfig: () => ({baseUrl: 'https://synthetic.invalid/feed', token: 'synthetic-only', keys: f.keys}),
  receiverOrigin: () => 'https://snapshot.example.invalid',
}));
import { synchronizeSnapshot } from '../src/lib/inspiration/snapshot-sync';
import { readInspirationImage } from '../src/lib/inspiration/image-store';
import { sha256 } from '../src/lib/inspiration/protocol';
import { bytes, fixture, keys, signed } from './helpers/inspiration-snapshot-fixture';
import type { SnapshotManifest } from '../src/lib/inspiration/snapshot-protocol';

const library = {id: 'synthetic-library', kind: 'SHARED' as const, ownerId: 'synthetic-owner', legacyWorkspaceId: null};
const recipient = {kind: 'library', origin: 'https://snapshot.example.invalid', library_id: library.id};
let session: {id: string; libraryId: string; releaseId: string; sequence: number; manifest: SnapshotManifest; rootHash: string};
let raw: Buffer;
let latest: {schema_version: number; recipient: typeof recipient; status: string; release: {release_id: string; sequence: number; manifest_sha256: string}};
beforeEach(async () => {
  vi.resetAllMocks();vi.stubGlobal('fetch', f.fetch);
  const sample = await fixture(1), manifest = signed({...sample.manifest, release_id: 'fixed-release', sequence: 3});
  raw = bytes(manifest);f.keys = {...keys};
  session = {id: 'fixed-session', libraryId: library.id, releaseId: 'fixed-release', sequence: 3, manifest, rootHash: sha256(raw)};
  latest = {schema_version: 3, recipient, status: 'published', release: {release_id: session.releaseId, sequence: 3, manifest_sha256: sha256(raw)}};
  f.state.mockResolvedValue(null);f.session.mockResolvedValue(null);f.create.mockResolvedValue(session);
  f.tick.mockResolvedValue({sessionId: session.id, status: 'DOWNLOADING', complete: false, bytes: 100, objects: 1});
  f.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('/latest') ? JSON.stringify(latest) : raw));
  f.legacy.mockResolvedValue(null);f.object.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('snapshot discovery, fixed intent and image read boundary', () => {
  it('persists the discovered session before the first bounded tick and preserves incomplete status', async () => {
    const order: string[] = [];
    f.tick.mockImplementation(async () => {order.push('tick');return {sessionId: session.id, status: 'DOWNLOADING', complete: false};});
    const result = await synchronizeSnapshot(library, new AbortController().signal, async () => {}, {onSession: async id => {expect(id).toBe(session.id);order.push('saved');}});
    expect(order).toEqual(['saved', 'tick']);expect(result?.complete).toBe(false);
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(['https://synthetic.invalid/feed/snapshots/latest', 'https://synthetic.invalid/feed/snapshots/releases/fixed-release/manifest']);
  });
  it('resumes the pinned release without asking latest again even when publication has advanced', async () => {
    f.session.mockResolvedValue(session);
    f.tick.mockImplementation(async (_library, options) => {
      await options.fetchPart('a'.repeat(64), 1024);
      return {sessionId: session.id, status: 'VALIDATING', complete: false};
    });
    await synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: session.id});
    expect(f.create).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![0]).toBe(`https://synthetic.invalid/feed/snapshots/releases/fixed-release/parts/${'a'.repeat(64)}`);
    expect(f.fetch.mock.calls[0]![1]).toMatchObject({redirect: 'error', cache: 'no-store'});
  });
  it('rejects regressed discovery before reusing an old active session or announcing success', async () => {
    f.state.mockResolvedValue({releaseSequence: 4});
    f.tick.mockResolvedValue({sessionId: session.id, status: 'ACTIVE', complete: true});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {})).rejects.toThrow('Release rollback');
    expect(f.state).toHaveBeenCalledWith({where: {libraryId: library.id}, select: {releaseSequence: true}});
    expect(f.create).not.toHaveBeenCalled();expect(f.tick).not.toHaveBeenCalled();
  });
  it('permits idempotent discovery of the same installed sequence', async () => {
    f.state.mockResolvedValue({releaseSequence: 3});
    f.tick.mockResolvedValue({sessionId: session.id, status: 'ACTIVE', complete: true});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {})).resolves.toMatchObject({status: 'ACTIVE', complete: true});
    expect(f.create).toHaveBeenCalledOnce();expect(f.tick).toHaveBeenCalledOnce();
  });
  it('keeps explicit pinned-session idempotence separate from fresh discovery', async () => {
    f.session.mockResolvedValue(session);f.state.mockResolvedValue({releaseSequence: 4});
    f.tick.mockResolvedValue({sessionId: session.id, status: 'ACTIVE', complete: true});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: session.id})).resolves.toMatchObject({status: 'ACTIVE', complete: true});
    expect(f.fetch).not.toHaveBeenCalled();expect(f.state).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects missing or foreign pinned sessions without starting a different root', async () => {
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: 'missing'})).rejects.toThrow('scope');
    f.session.mockResolvedValue({...session, libraryId: 'foreign'});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: session.id})).rejects.toThrow('scope');
    expect(f.fetch).not.toHaveBeenCalled();expect(f.tick).not.toHaveBeenCalled();
  });
  it('revalidates pinned metadata against its root hash and current trusted keys', async () => {
    f.session.mockResolvedValue(session);f.keys = {replacement: keys.synthetic};
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: session.id})).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();expect(f.tick).not.toHaveBeenCalled();
    f.keys = {...keys};f.session.mockResolvedValue({...session, rootHash: '0'.repeat(64)});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {sessionId: session.id})).rejects.toThrow();
    expect(f.tick).not.toHaveBeenCalled();
  });
  it('does not activate if trust is revoked during the final permission check', async () => {
    f.session.mockResolvedValue(session);
    f.tick.mockImplementation(async (_library, options) => {await options.beforeActivate();return {status: 'ACTIVE', complete: true};});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {f.keys = {replacement: keys.synthetic};}, {sessionId: session.id})).rejects.toThrow();
  });
  it('rejects discovery checksum tampering before creating a session', async () => {
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({...latest, release: {...latest.release, manifest_sha256: '0'.repeat(64)}}))).mockResolvedValueOnce(new Response(raw));
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {})).rejects.toThrow('checksum');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('awaits durable task pinning and rechecks authority immediately before activation', async () => {
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {}, {onSession: async () => {throw new Error('task expired');}})).rejects.toThrow('expired');
    expect(f.tick).not.toHaveBeenCalled();
    f.tick.mockImplementation(async (_library, options) => {await options.beforeActivate();return {complete: true, status: 'ACTIVE'};});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {throw new Error('receiver revoked');})).rejects.toThrow('revoked');
  });
  it.each(['CANCELLED', 'FAILED_VALIDATION'])('never reports %s as a successful receive', async status => {
    f.tick.mockResolvedValue({sessionId: session.id, status, complete: false});
    await expect(synchronizeSnapshot(library, new AbortController().signal, async () => {})).rejects.toThrow('validation');
  });
  it('does not fall back to CAS for a legacy release and scopes snapshot lookup to the pinned active release', async () => {
    const row = {libraryId: library.id, releaseId: 'original-record-release'}, path = `images/${'a'.repeat(64)}.png`;
    expect(await readInspirationImage(row, path)).toBeNull();expect(f.object).not.toHaveBeenCalled();
    f.object.mockResolvedValue({mime: 'image/png', sha256: 'a'.repeat(64), bytes: Buffer.from('synthetic')});
    expect(await readInspirationImage(row, path, 'active-snapshot', true)).toMatchObject({mimeType: 'image/png'});
    expect(f.object).toHaveBeenCalledWith(library.id, 'active-snapshot', path);
    expect(f.legacy).toHaveBeenCalledWith({where: {libraryId_releaseId_path: {...row, path}}});
  });
});
