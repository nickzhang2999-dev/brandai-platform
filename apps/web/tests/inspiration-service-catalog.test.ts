import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspirationListResponse } from '@brandai/contracts';
const mocks = vi.hoisted(() => ({ records: vi.fn(), enabled: vi.fn(), settings: vi.fn(), resolve: vi.fn() }));
vi.mock('@brandai/db', () => ({ prisma: {}, Prisma: {} }));
vi.mock('@/lib/api', () => ({ ApiException: class extends Error {} }));
vi.mock('@/lib/inspiration/replica', () => ({ activeRecords: mocks.records }));
vi.mock('@/lib/inspiration/config', () => ({ inspirationEnabled: mocks.enabled, syncConfigured: () => true, contentSyncMode: () => 'automatic' }));
vi.mock('@/lib/settings', () => ({ getEffectiveAiSettings: mocks.settings }));
vi.mock('@/lib/studio-copywriting-provider', () => ({ copywritingConfig: () => ({}), copywritingEndpoint: () => '' }));
vi.mock('@/lib/inspiration/library', () => ({ resolveLibrary: mocks.resolve, sourceLibrary: (library: {id:string;kind:string}) => ({id:library.id,kind:library.kind}) }));
import { getCase, listCases, currentCases } from '@/lib/inspiration/service';
import { answerEvidence } from '@/lib/inspiration/provider';

function record() {
  const permissions = { display: 'allowed', analysis: 'allowed', export: 'allowed' };
  return { case_id: 'legacy-case', revision: 1, title: '自有测试案例', summary_zh: '中文设计说明', brand_or_team: '测试团队',
    review_status: 'approved', display_permission: 'allowed', permissions, analysis_version: '1', model_version: 'none',
    tags: { industry: ['other'], medium: ['digital'] }, editorial: { material_kind: 'reference', legacy_medium_fallback: true },
    sources: [{ source_id: 'source-1', url: 'https://example.invalid/source', display_permission: 'allowed', permissions }],
    images: [{ image_id: 'image-1', source_id: 'source-1', path: 'images/test.png', display_permission: 'allowed', permissions }],
    claims: [{ claim_id: 'claim-1', kind: 'visual_observation', text: '可见字体', source_ids: [], image_ids: ['image-1'] }] };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled.mockReturnValue(true);
  mocks.resolve.mockImplementation(async (workspaceId:string, requestedId?:string) => ({id:requestedId ?? workspaceId,kind:'WORKSPACE',ownerId:'tenant',legacyWorkspaceId:workspaceId}));
  mocks.settings.mockResolvedValue({ vlm: { provider: 'openai', model: 'isolated-test', apiKey: 'synthetic-key', baseUrl: 'https://example.invalid/v1' } });
  vi.stubEnv('INSPIRATION_CHAT_PROVIDER', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('catalog service visibility and model evidence', () => {
  it('keeps internal evidence beyond pages 1 and 4, while UI remains paginated and disabled reads stay closed', async () => {
    const records=Array.from({length:201},(_,index)=>({caseId:`case-${String(index).padStart(3,'0')}`,revision:1,body:{...record(),case_id:`case-${String(index).padStart(3,'0')}`}}));
    mocks.records.mockResolvedValue({state:null,release:null,records});
    expect((await listCases('workspace')).cases).toHaveLength(50);
    expect((await currentCases('workspace')).cases).toHaveLength(201);
    expect((await currentCases('workspace','workspace',['case-050','case-200'])).cases.map(c=>c.caseId)).toEqual(['case-050','case-200']);
    mocks.records.mockResolvedValue({state:null,release:null,records:records.slice(0,200)});
    expect((await currentCases('workspace','workspace',['case-200'])).cases).toEqual([]);
    mocks.enabled.mockReturnValue(false);mocks.records.mockClear();
    expect((await currentCases('workspace')).cases).toEqual([]);expect(mocks.records).not.toHaveBeenCalled();
  });
  it('returns only disabled capability state without reading replica content', async () => {
    mocks.enabled.mockReturnValue(false);
    mocks.records.mockRejectedValue(new Error('Stored replica must never be read while disabled'));
    const result = InspirationListResponse.parse(await listCases('workspace', { q: 'anything', medium: 'digital' }));
    expect(mocks.records).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ enabled: false, activeRelease: null, caseCount: 0, cases: [], withdrawalSequence: 0, lastSyncAt: null, error: null,
      syncStatus: { content: { state: 'disabled' }, withdrawals: { state: 'disabled' }, activeManifestHash: null, withdrawalHash: null } });
  });
  it('reads current records again when re-enabled, rather than retaining the disabled projection', async () => {
    mocks.enabled.mockReturnValue(false); await listCases('workspace');
    mocks.enabled.mockReturnValue(true); mocks.records.mockResolvedValue({ state: null, release: null, records: [{ caseId: 'legacy-case', revision: 1, body: record() }] });
    expect((await listCases('workspace')).cases[0]?.caseId).toBe('legacy-case');
    expect(mocks.records).toHaveBeenCalledOnce(); expect(mocks.records).toHaveBeenCalledWith({id:'workspace',kind:'WORKSPACE',ownerId:'tenant',legacyWorkspaceId:'workspace'},{skipSnapshotRecords:true});
  });
  it('excludes legacy defaults from filters, case details and the actual model request payload', async () => {
    const original = record(), before = JSON.stringify(original);
    mocks.records.mockResolvedValue({ state: null, release: null, records: [{ caseId: 'legacy-case', revision: 1, body: original }] });
    const list = await listCases('workspace');
    expect(list.cases[0]).toMatchObject({ taxonomyStatus: 'legacy', tags: { industry: [], medium: [], task: [] } });
    expect((await listCases('workspace', { medium: 'digital' })).cases).toEqual([]);
    expect((await listCases('workspace', { q: '数字界面' })).cases).toEqual([]);
    expect(list.sourceLibrary).toEqual({id:'workspace',kind:'WORKSPACE'});
    expect(list.cases[0]?.libraryId).toBe('workspace');
    const detail = (await getCase('workspace', 'legacy-case', 1)).case;
    expect(detail.tags).toEqual(list.cases[0]?.tags);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sections: [{ text: '测试观察', caseId: 'legacy-case', claimIds: ['claim-1'] }], limitations: '隔离测试' }) } }] })));
    vi.stubGlobal('fetch', fetcher);
    await answerEvidence('怎样理解版式', [detail], [], new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
    const request = JSON.parse(fetcher.mock.calls[0]![1].body);
    const evidence = JSON.parse(request.messages[1].content).cases[0];
    expect(evidence.tags).toEqual({ industry: [], medium: [], task: [] });
    expect(JSON.stringify(evidence)).not.toMatch(/digital|other|数字界面/);
    expect(JSON.stringify(original)).toBe(before);
  });
});
