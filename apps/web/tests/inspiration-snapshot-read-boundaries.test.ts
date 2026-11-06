import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({active: vi.fn(), resolve: vi.fn(), transaction: vi.fn(), records: vi.fn(), bookmarks: vi.fn(), feedback: vi.fn(), sql: [] as Array<{text: string; values: unknown[]}>}));
vi.mock('@brandai/db', async importOriginal => ({...await importOriginal<object>(), prisma: {
  $transaction: f.transaction, inspirationRecord: {findMany: f.records}, inspirationBookmark: {findMany: f.bookmarks}, inspirationFeedback: {findMany: f.feedback},
}}));
vi.mock('../src/lib/inspiration/replica', () => ({activeRecords: f.active}));
vi.mock('../src/lib/inspiration/library', () => ({resolveLibrary: f.resolve, ensureLibrary: vi.fn(), sourceLibrary: (value: {id: string; kind: string}) => ({id: value.id, kind: value.kind})}));
vi.mock('../src/lib/inspiration/config', () => ({inspirationEnabled: () => true, contentSyncMode: () => 'manual', syncConfigured: () => true, receiverOrigin: () => 'https://snapshot.example.invalid'}));
vi.mock('../src/lib/api', () => ({
  ApiException: class extends Error {constructor(public status: number, message: string) {super(message);}},
  requireUser: async () => ({id: 'synthetic-user'}), ok: (value: unknown) => Response.json(value),
  handleError: (error: Error) => Response.json({error: error.message}, {status: 500}), parse: vi.fn(),
}));
vi.mock('../src/lib/workspace', () => ({requireWorkspaceRole: async () => ({role: 'OWNER'})}));
import { Prisma } from '@brandai/db';
import { InspirationChatInput } from '@brandai/contracts';
import { currentCases } from '../src/lib/inspiration/service';
import { snapshotCatalogPage } from '../src/lib/inspiration/snapshot-catalog';
import { listInspirationFeedback } from '../src/lib/inspiration/feedback';
import { GET as getBookmarks } from '../src/app/api/workspaces/[wsId]/inspiration/bookmarks/route';
import { fixture } from './helpers/inspiration-snapshot-fixture';

const library = {id: 'synthetic-library', kind: 'SHARED' as const, ownerId: 'synthetic-owner', legacyWorkspaceId: null};
let row: {id: string; caseId: string; revision: number; libraryId: string; body: unknown};
beforeEach(async () => {
  vi.clearAllMocks();f.sql.length = 0;f.resolve.mockResolvedValue(library);
  const sample = await fixture(1), record = sample.parts[0]!.records[0]!;
  row = {id: 'synthetic-record', libraryId: library.id, caseId: record.case_id, revision: record.revision, body: record.case};
  f.active.mockImplementation(async (_scope, options) => ({state: null, release: {releaseId: 'fixed-release', manifest: sample.manifest}, records: options?.caseIds?.includes(row.caseId) ? [row] : []}));
  f.records.mockResolvedValue([row]);
  f.transaction.mockImplementation(async callback => callback({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Prisma.sql(strings, ...values);f.sql.push({text: query.text, values: query.values});
      if (query.text.includes('ORDER BY score DESC')) return [{id: row.id, caseId: row.caseId}];
      return [{count: 1n}];
    }, inspirationRecord: {findMany: f.records},
  }));
});

describe('snapshot catalog pagination and targeted internal reads', () => {
  it('accepts a valid long chat question while bounding only its retrieval query', async () => {
    const question = '包装'.repeat(600);
    expect(InspirationChatInput.safeParse({requestId: '00000000-0000-4000-8000-000000000000', question}).success).toBe(true);
    expect((await currentCases('synthetic-workspace', library.id, undefined, {query: question})).cases).toHaveLength(1);
    expect(f.sql.flatMap(sql => sql.values).filter(value => typeof value === 'string').every(value => value.length <= 500)).toBe(true);
    expect(f.active).toHaveBeenCalledWith(library, {caseIds: undefined, skipSnapshotRecords: true});
  });
  it('filters analysis permission before retrieval paging but leaves display-only browsing available', async () => {
    await currentCases('synthetic-workspace', library.id, undefined, {query: '包装'});
    const retrieval = f.sql.find(sql => sql.text.includes('ORDER BY score DESC'))!;
    expect(retrieval.text).toContain("r.body->'permissions'->>'analysis'='allowed'");
    expect(retrieval.text).toContain("r.body->'sources'");expect(retrieval.text).toContain("r.body->'images'");
    expect(retrieval.text.indexOf("->>'analysis'")).toBeLessThan(retrieval.text.indexOf('LIMIT'));
    f.sql.length = 0;
    await snapshotCatalogPage(library.id, 'fixed-release', {}, {limit: 2});
    expect(f.sql.every(sql => !sql.text.includes("->>'analysis'"))).toBe(true);
  });
  it('pins release, current withdrawals and cursor in SQL and fetches only the selected row bodies', async () => {
    const cursor = "cursor'parameter";
    const result = await snapshotCatalogPage(library.id, 'fixed-release', {industry: 'culture', medium: 'poster'}, {limit: 2, cursor});
    const page = f.sql.find(sql => sql.text.includes('ORDER BY score DESC'))!;
    expect(page.values).toContain(library.id);expect(page.values).toContain('fixed-release');expect(page.values).toContain(cursor);
    expect(page.text).toContain('s.withdrawn ? e."caseId"');expect(page.text).toContain('EXISTS(SELECT 1 FROM matched');expect(page.text).not.toContain(cursor);
    expect(f.records).toHaveBeenCalledWith({where: {libraryId: library.id, id: {in: [row.id]}, deleted: false}});
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {isolationLevel: 'RepeatableRead', timeout: 10000});
    expect(result).toMatchObject({caseCount: 1, matchedCount: 1, hasMore: false, nextCursor: null});
  });
  it('resolves bookmarks by their exact IDs instead of the default first 500 cases', async () => {
    f.bookmarks.mockResolvedValue([{id: 'bookmark', libraryId: library.id, caseId: row.caseId, revision: 1, projectId: null, note: 'synthetic'}]);
    const response = await getBookmarks(new Request('https://example.invalid'), {params: Promise.resolve({wsId: 'synthetic-workspace'})});
    expect(response.status).toBe(200);expect((await response.json()).items[0]).toMatchObject({caseId: row.caseId, unavailable: false});
    expect(f.active).toHaveBeenCalledWith(library, expect.objectContaining({caseIds: [row.caseId]}));
  });
  it('resolves feedback cases by IDs instead of marking later catalog entries unavailable', async () => {
    f.feedback.mockResolvedValue([{id: 'feedback', libraryId: library.id, caseId: row.caseId, revision: 1, kind: 'ANALYSIS_ERROR', note: 'synthetic', status: 'OPEN', createdAt: new Date('2026-11-06T00:00:00Z')}]);
    const result = await listInspirationFeedback('synthetic-workspace', 'synthetic-user');
    expect(result.items[0]).toMatchObject({caseId: row.caseId, unavailable: false});
    expect(f.active).toHaveBeenCalledWith(library, {caseIds: [row.caseId]});
  });
});
