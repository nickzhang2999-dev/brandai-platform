import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ user:vi.fn(), role:vi.fn(), enabled:vi.fn(), setup:vi.fn(), transaction:vi.fn(), execute:vi.fn(), brands:vi.fn(), identity:vi.fn(), library:vi.fn(), owner:vi.fn(), createIdentity:vi.fn(), createLibrary:vi.fn(), dailyFind:vi.fn(),dailyCreate:vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiException:class extends Error { constructor(public status:number,message:string){super(message);} },
  requireUser:f.user, ok:(value:unknown,init?:ResponseInit)=>Response.json(value,init),
  handleError:(error:{status?:number;message:string})=>Response.json({error:error.message},{status:error.status??500}),
}));
vi.mock('@/lib/workspace',()=>({requireWorkspaceRole:f.role}));
vi.mock('@/lib/inspiration/service',()=>({requireEnabled:f.enabled}));
vi.mock('@/lib/inspiration/library',()=>({sharedLibrarySetupId:f.setup,sourceLibrary:(v:{id:string;kind:string})=>({id:v.id,kind:v.kind})}));
vi.mock('../../../packages/db/src/index',()=>({prisma:{$transaction:f.transaction}}));
import { POST } from '../src/app/api/workspaces/[wsId]/inspiration/library/setup/route';

const context=()=>({params:Promise.resolve({wsId:'brand'})});
const request=(body:unknown={})=>new Request('https://test.invalid/api/workspaces/brand/inspiration/library/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const denied=(status:number)=>Object.assign(new Error('Denied'),{status});
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv('INSPIRATION_SHARED_SETUP_OWNER_ID','company-owner');
  vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET','');vi.stubEnv('INSPIRATION_DAILY_RECEIPTS_ENABLED','true');vi.stubEnv('INSPIRATION_RECEIPT_OWNER_ID','company-owner');
  f.user.mockResolvedValue({id:'company-owner'});f.role.mockResolvedValue({workspace:{ownerId:'company-owner'},role:'OWNER'});
  f.setup.mockReturnValue('configured-library');f.brands.mockResolvedValue([{ownerId:'company-owner'}]);f.identity.mockResolvedValue(null);f.library.mockResolvedValue(null);f.owner.mockResolvedValue({isActive:true});
  f.createLibrary.mockImplementation(async({data})=>data);
  f.dailyFind.mockResolvedValue(null);f.dailyCreate.mockImplementation(async({data})=>data);
  f.transaction.mockImplementation(async(run:(tx:unknown)=>unknown)=>run({$executeRaw:f.execute,$queryRaw:f.brands,inspirationLibraryIdentity:{findUnique:f.identity,create:f.createIdentity},inspirationLibrary:{findUnique:f.library,create:f.createLibrary},user:{findUnique:f.owner},inspirationDailyPolicy:{findUnique:f.dailyFind,create:f.dailyCreate}}));
});
afterEach(()=>vi.unstubAllEnvs());

describe('deployment-selected owner shared library setup',()=>{
  it('keeps library-only behavior when no initial target is configured',async()=>{
    expect((await POST(request(),context())).status).toBe(201);expect(f.dailyFind).not.toHaveBeenCalled();expect(f.dailyCreate).not.toHaveBeenCalled();
  });
  it.each(['100','200','300','400','500'])('initializes the explicit server target %s without quality claims',async target=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET',target);
    expect((await POST(request(),context())).status).toBe(201);
    expect(f.dailyCreate).toHaveBeenCalledWith({data:{ownerId:'company-owner',target:Number(target),startDay:expect.any(String),startedAt:expect.any(Date)}});
    expect(f.execute.mock.calls.some(call=>call[0].join('').includes('SELECT DISTINCT'))).toBe(true);
    expect(f.createIdentity.mock.invocationCallOrder[0]).toBeGreaterThan(f.dailyCreate.mock.invocationCallOrder[0]!);
  });
  it.each(['0','50','501','unlimited','500.0','1e2'])('rejects invalid server target %s before transaction',async target=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET',target);expect((await POST(request(),context())).status).toBe(503);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('requires accounting to be enabled for this exact owner',async()=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET','500');vi.stubEnv('INSPIRATION_RECEIPT_OWNER_ID','other-owner');
    expect((await POST(request(),context())).status).toBe(503);expect(f.dailyCreate).not.toHaveBeenCalled();expect(f.createIdentity).not.toHaveBeenCalled();
  });
  it('initializes missing policy even when shared library already exists',async()=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET','500');f.identity.mockResolvedValue({ownerId:'company-owner'});f.library.mockResolvedValue({id:'configured-library',kind:'SHARED',ownerId:'company-owner'});
    expect((await POST(request(),context())).status).toBe(200);expect(f.dailyCreate).toHaveBeenCalledOnce();expect(f.createLibrary).not.toHaveBeenCalled();
  });
  it('replays an existing matching policy without rebaselining or changing quality',async()=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET','500');const policy={target:500,qualityDay:'2026-11-01',qualityEvidence:'existing evidence',qualityReviewedBy:'reviewer'};f.dailyFind.mockResolvedValue(policy);
    expect((await POST(request(),context())).status).toBe(201);expect(f.dailyCreate).not.toHaveBeenCalled();expect(f.execute.mock.calls.some(call=>call[0].join('').includes('SELECT DISTINCT'))).toBe(false);expect(policy.qualityEvidence).toBe('existing evidence');
  });
  it('refuses to relabel an existing 100 policy as 500 or write a library identity',async()=>{
    vi.stubEnv('INSPIRATION_SHARED_INITIAL_DAILY_TARGET','500');f.dailyFind.mockResolvedValue({target:100});expect((await POST(request(),context())).status).toBe(409);expect(f.dailyCreate).not.toHaveBeenCalled();expect(f.createIdentity).not.toHaveBeenCalled();
  });
  it('requires normal authenticated active user before tenant lookup',async()=>{
    f.user.mockRejectedValue(denied(401));expect((await POST(request(),context())).status).toBe(401);expect(f.role).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([403,404])('preserves workspace membership failure %i',async status=>{
    f.role.mockRejectedValue(denied(status));expect((await POST(request(),context())).status).toBe(status);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('rejects an OWNER membership when the session is not the real workspace owner',async()=>{
    f.role.mockResolvedValue({workspace:{ownerId:'actual-owner'},role:'OWNER'});expect((await POST(request(),context())).status).toBe(403);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('rejects a genuine owner from another company before reading any library',async()=>{
    f.user.mockResolvedValue({id:'other-owner'});f.role.mockResolvedValue({workspace:{ownerId:'other-owner'},role:'OWNER'});
    expect((await POST(request(),context())).status).toBe(403);expect(f.setup).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['','invalid owner','x'.repeat(129)])('fails closed without valid configured owner %s',async owner=>{
    vi.stubEnv('INSPIRATION_SHARED_SETUP_OWNER_ID',owner);expect((await POST(request(),context())).status).toBe(503);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('requires server-selected library and enabled feature',async()=>{
    f.setup.mockReturnValue(null);expect((await POST(request(),context())).status).toBe(503);expect(f.transaction).not.toHaveBeenCalled();
    f.enabled.mockImplementation(()=>{throw denied(404);});expect((await POST(request(),context())).status).toBe(404);
  });
  it.each([{ownerId:'victim'},{libraryId:'another'},{workspaceId:'foreign'},{admin:true},[],null,''])('rejects client-selected setup input %j',async body=>{
    expect((await POST(request(body),context())).status).toBe(422);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON without creating identities',async()=>{
    const req=new Request('https://test.invalid',{method:'POST',body:'{'});expect((await POST(req,context())).status).toBe(400);expect(f.transaction).not.toHaveBeenCalled();
  });
  it('creates only configured company identity and takes both existing locks',async()=>{
    const response=await POST(request(),context());expect(response.status).toBe(201);expect(await response.json()).toEqual({sourceLibrary:{id:'configured-library',kind:'SHARED'},created:true});
    expect(f.role).toHaveBeenCalledWith('brand','company-owner','OWNER');
    expect(f.execute.mock.calls[0]![0].join('')).toContain('pg_advisory_xact_lock');expect(f.execute.mock.calls[0]![1]).toBe('inspiration-library:configured-library');
    expect(f.brands.mock.calls[0]![0].join('')).toContain('FOR SHARE');expect(f.brands.mock.calls[0]![1]).toBe('brand');
    expect(f.createIdentity).toHaveBeenCalledWith({data:{id:'configured-library',ownerId:'company-owner'}});
    expect(f.execute.mock.invocationCallOrder[0]).toBeLessThan(f.brands.mock.invocationCallOrder[0]!);expect(f.brands.mock.invocationCallOrder[0]).toBeLessThan(f.createIdentity.mock.invocationCallOrder[0]!);
  });
  it.each([{rows:[]},{rows:[{ownerId:'transferred-owner'}]}])('rechecks deleted/transferred workspace inside transaction %j',async ({rows})=>{
    f.brands.mockResolvedValue(rows);expect((await POST(request(),context())).status).toBe(409);expect(f.createIdentity).not.toHaveBeenCalled();expect(f.createLibrary).not.toHaveBeenCalled();
  });
  it('refuses a permanent recipient previously bound to another owner',async()=>{
    f.identity.mockResolvedValue({ownerId:'old-owner'});expect((await POST(request(),context())).status).toBe(409);expect(f.createIdentity).not.toHaveBeenCalled();expect(f.createLibrary).not.toHaveBeenCalled();
  });
  it.each([{kind:'WORKSPACE',ownerId:'company-owner'},{kind:'SHARED',ownerId:'other-owner'}])('refuses existing library scope conflicts %j',async existing=>{
    f.library.mockResolvedValue(existing);expect((await POST(request(),context())).status).toBe(409);expect(f.createIdentity).not.toHaveBeenCalled();expect(f.createLibrary).not.toHaveBeenCalled();
  });
  it('rechecks disabled owner before writing',async()=>{
    f.owner.mockResolvedValue({isActive:false});expect((await POST(request(),context())).status).toBe(404);expect(f.createIdentity).not.toHaveBeenCalled();
  });
  it('is idempotent without changing owner, reader configuration or library data',async()=>{
    f.identity.mockResolvedValue({ownerId:'company-owner'});f.library.mockResolvedValue({id:'configured-library',kind:'SHARED',ownerId:'company-owner'});
    const response=await POST(request(),context());expect(response.status).toBe(200);expect((await response.json()).created).toBe(false);expect(f.createIdentity).not.toHaveBeenCalled();expect(f.createLibrary).not.toHaveBeenCalled();
  });
});
