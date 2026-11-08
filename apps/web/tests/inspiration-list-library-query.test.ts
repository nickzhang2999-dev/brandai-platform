import { beforeEach, describe, expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({user:vi.fn(),role:vi.fn(),list:vi.fn()}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message);}},requireUser:f.user,ok:(v:unknown,init?:ResponseInit)=>Response.json(v,init),handleError:(e:{status?:number;message:string})=>Response.json({error:e.message},{status:e.status??500})}));
vi.mock('@/lib/workspace',()=>({requireWorkspaceRole:f.role}));
vi.mock('@/lib/inspiration/service',()=>({listCases:f.list}));
import { GET } from '../src/app/api/workspaces/[wsId]/inspiration/route';
const ctx=()=>({params:Promise.resolve({wsId:'brand'})});
beforeEach(()=>{vi.resetAllMocks();f.user.mockResolvedValue({id:'owner'});f.role.mockResolvedValue({role:'OWNER'});f.list.mockResolvedValue({cases:[]});});
describe('explicit library list selection',()=>{
  it('preserves default selection and forwards explicit IDs to the owner-scoped service',async()=>{
    expect((await GET(new Request('https://test.invalid/inspiration'),ctx())).status).toBe(200);
    expect(f.list.mock.calls[0]![2]).toBeUndefined();
    expect((await GET(new Request('https://test.invalid/inspiration?libraryId=shared'),ctx())).status).toBe(200);
    expect(f.list.mock.calls[1]![0]).toBe('brand');expect(f.list.mock.calls[1]![2]).toBe('shared');
  });
  it.each(['libraryId=','libraryId=bad%2Fid','libraryId=one&libraryId=two'])('rejects invalid selection %s before data lookup',async query=>{
    expect((await GET(new Request('https://test.invalid/inspiration?'+query),ctx())).status).toBe(422);expect(f.list).not.toHaveBeenCalled();
  });
  it('does not bypass membership or swallow service ownership rejection',async()=>{
    f.role.mockRejectedValueOnce(Object.assign(new Error('denied'),{status:403}));expect((await GET(new Request('https://test.invalid/inspiration?libraryId=shared'),ctx())).status).toBe(403);expect(f.list).not.toHaveBeenCalled();
    f.list.mockRejectedValueOnce(Object.assign(new Error('foreign'),{status:404}));expect((await GET(new Request('https://test.invalid/inspiration?libraryId=foreign'),ctx())).status).toBe(404);
  });
});
