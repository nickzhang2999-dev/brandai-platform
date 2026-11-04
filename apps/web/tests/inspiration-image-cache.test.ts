import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const f = vi.hoisted(() => ({ user: vi.fn(), role: vi.fn(), getCase: vi.fn(), file: vi.fn() }));
vi.mock('@brandai/db', () => ({ prisma: { inspirationImage: { findUnique: f.file } } }));
vi.mock('@/lib/api', () => ({ requireUser: f.user, ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } }, handleError: (e: {status?: number}) => new Response(null, {status: e.status ?? 500}) }));
vi.mock('@/lib/workspace', () => ({ requireWorkspaceRole: f.role }));
vi.mock('@/lib/inspiration/service', () => ({ getCase: f.getCase, requireEnabled: () => {} }));
vi.mock('@/lib/inspiration/protocol', () => ({ PublishedCase: { parse: (v: unknown) => v }, sha256: (v: Buffer) => createHash('sha256').update(v).digest('hex') }));
import { GET } from '../src/app/api/workspaces/[wsId]/inspiration/cases/[caseId]/images/[imageId]/route';
const bytes = Buffer.from('synthetic image bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
function get(etag?: string) {
  return GET(new Request('http://localhost/api/image?revision=1&libraryId=library', { headers: etag ? { 'if-none-match': etag } : {} }), {params: Promise.resolve({wsId: 'workspace', caseId: 'case', imageId: 'image'})});
}
beforeEach(() => {
  vi.resetAllMocks();
  f.user.mockResolvedValue({ id: 'user' }); f.role.mockResolvedValue(undefined);
  f.getCase.mockResolvedValue({ row: { libraryId: 'library', releaseId: 'release', body: { images: [{image_id: 'image', path: 'images/test.png'}] } } });
  f.file.mockResolvedValue({bytes, sha256: hash, mimeType: 'image/png'});
});
it('revalidates cached bodies, while authorized matching requests avoid retransmission', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
  const cached = await get(response.headers.get('etag')!);
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe('');
  expect(cached.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
  expect(f.role).toHaveBeenLastCalledWith('workspace', 'user', 'VIEWER');
});
it('rejects revoked membership and withdrawn cases before honoring matching validators', async () => {
  f.role.mockRejectedValueOnce({status: 403});
  expect((await get(`"${hash}"`)).status).toBe(403);
  expect(f.file).not.toHaveBeenCalled();
  f.getCase.mockRejectedValueOnce({status: 404});
  expect((await get(`"${hash}"`)).status).toBe(404);
  expect(f.file).not.toHaveBeenCalled();
});
it('checks changed bytes even after the same release/path/hash was previously read', async () => {
  expect((await get()).status).toBe(200);
  f.file.mockResolvedValue({bytes: Buffer.from('corrupt'), sha256: hash, mimeType: 'image/png'});
  expect((await get(`"${hash}"`)).status).toBe(503);
});
