import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ admin: vi.fn(), execute: vi.fn(), brands: vi.fn(), identity: vi.fn(), library: vi.fn(), owner: vi.fn(), createIdentity: vi.fn(), createLibrary: vi.fn() }));
vi.mock('@/lib/admin', () => ({ requireAdmin: f.admin }));
vi.mock('@/lib/inspiration/library', () => ({ sharedLibrarySetupId: () => 'company-library', sourceLibrary: (v: {id:string;kind:string}) => ({id:v.id,kind:v.kind}) }));
vi.mock('@/lib/api', () => ({ ApiException: class extends Error { constructor(public status:number,message:string){super(message);} }, parse: (s:{parse:(v:unknown)=>unknown},v:unknown)=>s.parse(v), ok:(v:unknown,init?:ResponseInit)=>Response.json(v,init), handleError:(e:{status?:number;message:string})=>Response.json({error:e.message},{status:e.status??500}) }));
vi.mock('../../../packages/db/src/index', () => ({ prisma: { $transaction: async (run:(tx:unknown)=>unknown) => run({ $executeRaw:f.execute,$queryRaw:f.brands,inspirationLibraryIdentity:{findUnique:f.identity,create:f.createIdentity},inspirationLibrary:{findUnique:f.library,create:f.createLibrary},user:{findUnique:f.owner} }) } }));
import { POST } from '../src/app/api/admin/inspiration/libraries/route';
const request = (extra={}) => new Request('https://test.invalid/api/admin/inspiration/libraries',{method:'POST',body:JSON.stringify({libraryId:'company-library',ownerId:'owner',workspaceId:'brand',...extra})});
beforeEach(()=>{vi.resetAllMocks();f.admin.mockResolvedValue({id:'admin'});f.brands.mockResolvedValue([{ownerId:'owner'}]);f.identity.mockResolvedValue(null);f.library.mockResolvedValue(null);f.owner.mockResolvedValue({isActive:true});f.createLibrary.mockResolvedValue({id:'company-library',kind:'SHARED'});});
describe('administrator shared library setup',()=>{
  it('requires administrator before reading ownership or writing',async()=>{f.admin.mockRejectedValue(Object.assign(new Error('Denied'),{status:403}));expect((await POST(request())).status).toBe(403);expect(f.brands).not.toHaveBeenCalled();expect(f.createIdentity).not.toHaveBeenCalled();});
  it('locks and validates selected workspace ownership before creating the permanent identity',async()=>{expect((await POST(request())).status).toBe(201);expect(f.brands).toHaveBeenCalledTimes(1);expect(f.createIdentity).toHaveBeenCalledWith({data:{id:'company-library',ownerId:'owner'}});});
  it.each([{rows:[]},{rows:[{ownerId:'different-owner'}]}])('rejects deleted or transferred workspace without writes',async ({rows})=>{f.brands.mockResolvedValue(rows);expect((await POST(request())).status).toBe(409);expect(f.createIdentity).not.toHaveBeenCalled();expect(f.createLibrary).not.toHaveBeenCalled();});
  it('cannot rebind a permanent identity',async()=>{f.identity.mockResolvedValue({ownerId:'original-owner'});expect((await POST(request())).status).toBe(409);expect(f.createLibrary).not.toHaveBeenCalled();});
  it('is idempotent for the same owner and source',async()=>{f.identity.mockResolvedValue({ownerId:'owner'});f.library.mockResolvedValue({id:'company-library',kind:'SHARED',ownerId:'owner'});const response=await POST(request());expect(response.status).toBe(200);expect((await response.json()).created).toBe(false);expect(f.createLibrary).not.toHaveBeenCalled();});
});
