import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, brandWorkspace: { findFirst: vi.fn() }, membership: { findUnique: vi.fn() },
  asyncTask: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() }, $executeRaw: vi.fn(), $transaction: vi.fn() }));
const settings = vi.hoisted(() => vi.fn());
const analyze = vi.hoisted(() => vi.fn());
vi.mock('@brandai/db', () => ({ prisma: db }));
vi.mock('@/lib/settings', () => ({ getEffectiveAiSettings: settings }));
vi.mock('@/lib/omni-analysis/provider', () => ({ analyzeImage: analyze }));
import { OmniAnalysisJob, OmniAnalysisWorkflowEvidence } from '@brandai/contracts';
import { getJob, getJobWorkflowEvidence, submit } from '@/lib/omni-analysis/service';
import { OMNI_KIND, payloadHash } from '@/lib/omni-analysis/policy';
import { omniWorkflowEvidence, retainedOmniAnalysisMetadata, snapshotOmniAnalysisSource } from '@/lib/omni-analysis/workflow-evidence';
import { processAnalysis, sweepAnalysis } from '@/lib/omni-analysis/worker';
import { GET } from '@/app/api/internal/inspiration-analysis/jobs/[jobId]/workflow-evidence/route';

const token = 'unit-evidence-service-token-1234567890';
const input = { request_id: '1234567890abcdef', source_image_id: 'asset-1', revision: 7, image_sha256: 'a'.repeat(64),
  image_base64: '/9j/AA==', title: 'private source title', description: 'private source description' };
const result = { kind: 'reference', purposes: [], reason: 'private analysis text', description: '', ocr_text: '', brand: '',
  design: { palette: '', typography: '', composition: '', hierarchy: '', imagery: '', reusable_ideas: '', applicability: '', limitations: '' }, model_version: 'configured-model' };
const source = () => snapshotOmniAnalysisSource(input)!;
const meta = () => ({ payload_hash: payloadHash(input), user_id: 'service-user', source_identity: source(), request: input });
const task = (patch: Record<string, unknown> = {}) => ({ id: 'job-1', workspaceId: 'workspace-1', kind: OMNI_KIND, status: 'PENDING',
  error: null, resultJson: null, expiresAt: new Date(Date.now() + 300_000), inputJson: meta(), ...patch });
const request = (authorization = 'Bearer ' + token) => new Request('https://nova.test/api/internal/inspiration-analysis/jobs/job-1/workflow-evidence', { headers: { authorization } });
const context = () => ({ params: Promise.resolve({ jobId: 'job-1' }) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OMNI_ANALYSIS_TOKEN_SHA256', createHash('sha256').update(token).digest('hex'));
  vi.stubEnv('OMNI_ANALYSIS_WORKSPACE_ID', 'workspace-1'); vi.stubEnv('OMNI_ANALYSIS_USER_ID', 'service-user'); vi.stubEnv('OMNI_ANALYSIS_DAILY_LIMIT', '5');
  vi.stubEnv('OMNI_ANALYSIS_MODEL', ''); vi.stubEnv('OMNI_ANALYSIS_PROVIDER', '');
  db.user.findFirst.mockResolvedValue({ id: 'service-user' }); db.brandWorkspace.findFirst.mockResolvedValue({ ownerId: 'service-user' });
  db.membership.findUnique.mockResolvedValue(null); db.$transaction.mockImplementation(fn => fn(db)); db.$executeRaw.mockResolvedValue(1);
  db.asyncTask.findFirst.mockResolvedValue(task()); db.asyncTask.findMany.mockResolvedValue([]); db.asyncTask.count.mockResolvedValue(0);
  db.asyncTask.create.mockImplementation(({ data }) => Promise.resolve(task(data))); db.asyncTask.updateMany.mockResolvedValue({ count: 1 });
  settings.mockResolvedValue({ vlm: { provider: 'openai', model: 'configured-model', apiKey: 'unit-provider-key', baseUrl: 'https://unit.invalid/v1' } });
  analyze.mockResolvedValue(result);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('production Omni evidence read path', () => {
  it('authenticates service and current scope, but never mutates even an expired job', async () => {
    db.asyncTask.findFirst.mockResolvedValue(task({ status: 'RUNNING', expiresAt: new Date(0) }));
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const value = OmniAnalysisWorkflowEvidence.parse(await response.json());
    expect(value).toMatchObject({ source: source(), source_basis: 'authenticated_request', analysis: { status: 'running', expired: true }, workflow: null, eligible_for_publication: false });
    expect(value.missing_evidence).toContain('current_source');
    expect(db.asyncTask.findFirst.mock.calls[0][0].where).toEqual({ id: 'job-1', workspaceId: 'workspace-1', kind: OMNI_KIND });
    expect(db.asyncTask.updateMany).not.toHaveBeenCalled(); expect(db.asyncTask.create).not.toHaveBeenCalled();
    expect(db.asyncTask.count).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
  });
  it('rejects absent or wrong bearer before reading a job', async () => {
    expect((await GET(request(''), context())).status).toBe(401);
    expect((await GET(request('Bearer ' + token + 'wrong'), context())).status).toBe(401);
    expect(db.asyncTask.findFirst).not.toHaveBeenCalled();
  });
  it('rejects revoked membership despite a valid service bearer', async () => {
    db.brandWorkspace.findFirst.mockResolvedValue({ ownerId: 'owner' }); db.membership.findUnique.mockResolvedValue({ role: 'VIEWER' });
    expect((await GET(request(), context())).status).toBe(403); expect(db.asyncTask.findFirst).not.toHaveBeenCalled();
  });
  it.each([{ workspaceId: 'foreign-workspace' }, { kind: 'OTHER' }, { inputJson: { ...meta(), user_id: 'foreign-user' } }])('does not expose another scope or actor %#', async patch => {
    db.asyncTask.findFirst.mockResolvedValue(task(patch)); expect((await GET(request(), context())).status).toBe(404);
  });
  it('keeps a historical completed job source unknown and does not expose result text or service actor', async () => {
    db.asyncTask.findFirst.mockResolvedValue(task({ status: 'SUCCEEDED', resultJson: result, inputJson: { payload_hash: payloadHash(input), user_id: 'service-user' } }));
    const value = await getJobWorkflowEvidence('job-1');
    expect(value).toMatchObject({ source: null, source_basis: 'unavailable', analysis: { status: 'completed', model_version: 'configured-model' },
      ai_review: 'unknown', human_review: 'unknown', publication: 'unknown', workflow: null, eligible_for_publication: false });
    expect(value.missing_evidence).toContain('source_identity');
    for (const secret of ['service-user', input.image_base64, input.title, input.description, result.reason, payloadHash(input), 'unit-provider-key']) expect(JSON.stringify(value)).not.toContain(secret);
  });
  it('does not turn injected review/rights/provenance into approval or policy evidence', () => {
    const value = omniWorkflowEvidence(task({ status: 'SUCCEEDED', resultJson: { ...result, human_review: 'approved' },
      inputJson: { ...meta(), reviewer_id: 'actor', provenance: 'assistant_editorial_review', permissions: { display: 'allowed', export: 'allowed' }, publication: 'published' } }) as Parameters<typeof omniWorkflowEvidence>[0]);
    expect(value).toMatchObject({ human_review: 'unknown', ai_review: 'unknown', publication: 'unknown', workflow: null, eligible_for_publication: false, analysis: { model_version: null } });
  });
});

describe('minimal future source retention', () => {
  it('adds only a source summary at admission and leaves the old API response compatible', async () => {
    db.asyncTask.findFirst.mockResolvedValue(null);
    const response = await submit(input), saved = db.asyncTask.create.mock.calls[0][0].data.inputJson;
    expect(saved.source_identity).toEqual(source()); expect(OmniAnalysisJob.parse(response.job)).toEqual(response.job);
    expect(response.job).not.toHaveProperty('workflow'); expect(response.job).not.toHaveProperty('source_identity');
  });
  it('retains the same accepted summary on replay, without rewriting history or recharging', async () => {
    const row = task({ status: 'SUCCEEDED', resultJson: result, inputJson: retainedOmniAnalysisMetadata(meta()) }); db.asyncTask.findFirst.mockResolvedValue(row);
    expect((await submit(input)).created).toBe(false);
    expect(db.asyncTask.create).not.toHaveBeenCalled(); expect(db.asyncTask.updateMany).not.toHaveBeenCalled(); expect(db.asyncTask.count).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    await expect(submit({ ...input, revision: 8 })).rejects.toThrow('request_id_conflict');
  });
  it.each(['success', 'failure'])('strips all request text and bytes but retains summary after worker %s', async outcome => {
    if (outcome === 'failure') analyze.mockRejectedValue(new Error('private provider failure'));
    await processAnalysis('job-1');
    const terminal = db.asyncTask.updateMany.mock.calls.map(call => call[0].data).find(value => value.inputJson);
    expect(terminal.status).toBe(outcome === 'success' ? 'SUCCEEDED' : 'FAILED');
    expect(terminal.inputJson).toEqual({ payload_hash: payloadHash(input), user_id: 'service-user', source_identity: source() });
    expect(JSON.stringify(terminal.inputJson)).not.toContain(input.image_base64); expect(terminal.inputJson).not.toHaveProperty('request');
    expect(analyze).toHaveBeenCalledOnce();
  });
  it.each(['poll', 'sweep'])('retains only summary through the existing %s expiration cleanup', async path => {
    const row = task({ expiresAt: new Date(0) }); db.asyncTask.findFirst.mockResolvedValue(row); db.asyncTask.findMany.mockResolvedValue([row]);
    if (path === 'poll') await getJob('job-1'); else await sweepAnalysis();
    const metaAfter = db.asyncTask.updateMany.mock.calls[0][0].data.inputJson;
    expect(metaAfter).toEqual({ payload_hash: payloadHash(input), user_id: 'service-user', source_identity: source() }); expect(analyze).not.toHaveBeenCalled();
  });
  it('does not reconstruct missing historical identity or retain malformed/unrecognized fields', () => {
    expect(retainedOmniAnalysisMetadata({ ...meta(), source_identity: undefined })).toEqual({ payload_hash: payloadHash(input), user_id: 'service-user' });
    expect(retainedOmniAnalysisMetadata({ ...meta(), source_identity: { ...source(), image_base64: input.image_base64 } })).not.toHaveProperty('source_identity');
  });
});
