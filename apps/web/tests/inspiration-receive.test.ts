import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {DAILY_IMAGE_LIMIT_AUTOMATIC,DAILY_IMAGE_LIMIT_MANUAL} from '../src/lib/inspiration/sync-status';
import { InspirationReceiveStatus } from '@brandai/contracts';
const mocks=vi.hoisted(()=>({ user:vi.fn(), role:vi.fn(), find:vi.fn(), create:vi.fn(), update:vi.fn(), upsert:vi.fn(), lock:vi.fn(), transaction:vi.fn(), enabled:vi.fn(), configured:vi.fn() }));
vi.mock('@brandai/db',()=>({prisma:{$transaction:mocks.transaction,inspirationLibraryTask:{findFirst:mocks.find}}}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message);}},requireUser:mocks.user,ok:(data:unknown,init?:ResponseInit)=>Response.json(data,init),handleError:(error:{status?:number;message:string})=>Response.json({error:error.message},{status:error.status??500})}));
vi.mock('@/lib/workspace',()=>({requireWorkspaceRole:mocks.role}));
vi.mock('@/lib/inspiration/service',()=>({requireEnabled:()=>{if(!mocks.enabled())throw Object.assign(new Error('disabled'),{status:503});}}));
vi.mock('@/lib/inspiration/config',()=>({contentSyncMode:()=> 'manual',inspirationEnabled:mocks.enabled,syncConfigured:mocks.configured}));
vi.mock('@/lib/inspiration/replica',()=>({lockWorkspace:mocks.lock}));
vi.mock('@/lib/inspiration/library',()=>({resolveLibrary:async(id:string)=>({id,kind:'WORKSPACE',ownerId:'user',legacyWorkspaceId:id}),ensureLibrary:vi.fn(),sourceLibrary:(x:{id:string;kind:string})=>({id:x.id,kind:x.kind}),canReceiveLibrary:async(_library:unknown,_user:unknown,role:string)=>role==='OWNER'}));
import { GET, POST } from '../src/app/api/workspaces/[wsId]/inspiration/sync/route';

type Task={id:string;workspaceId:string;inspirationLibraryId:string;status:'PENDING'|'RUNNING'|'SUCCEEDED'|'FAILED';createdAt:Date;updatedAt:Date;expiresAt:Date|null;inputJson:unknown;error?:string};
let task:Task|null, nextId:number, tail:Promise<unknown>;
const context=(wsId='workspace-a')=>({params:Promise.resolve({wsId})});
const req=()=>new Request('https://example.invalid/api/workspaces/workspace-a/inspiration/sync',{method:'POST'});
const now=()=>new Date('2026-11-02T06:00:00Z');
beforeEach(()=>{
  vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(now());task=null;nextId=0;tail=Promise.resolve();
  mocks.enabled.mockReturnValue(true);mocks.configured.mockReturnValue(true);mocks.user.mockResolvedValue({id:'user'});mocks.role.mockResolvedValue({role:'OWNER'});
  mocks.find.mockImplementation(async({where})=>task && task.inspirationLibraryId===where.inspirationLibraryId
    && (!where.OR || task.status!=='PENDING' || (task.inputJson as {trigger?:string})?.trigger==='manual')
    && (!where.status || (where.status.in.includes(task.status)&&!!task.expiresAt&&task.expiresAt>now()))?task:null);
  mocks.create.mockImplementation(async({data})=>task={...data,id:`task-${++nextId}`,status:'PENDING',createdAt:now(),updatedAt:now()});
  mocks.update.mockImplementation(async({where,data})=>{expect(where.id).toBe(task?.id);if(where.status&&where.status!==task!.status)return {count:0};Object.assign(task!,data);return {count:1};});
  mocks.transaction.mockImplementation((fn)=>{const next=tail.then(()=>fn({inspirationState:{upsert:mocks.upsert},inspirationLibraryTask:{findFirst:mocks.find,create:mocks.create,updateMany:mocks.update}}));tail=next.catch(()=>{});return next;});
});
afterEach(()=>vi.useRealTimers());

describe('one-click workspace-scoped inspiration reception',()=>{
  it('durably queues once under concurrent clicks and replays the same running identity',async()=>{
    const replies=await Promise.all([POST(req(),context()),POST(req(),context())]);
    expect(replies.map(x=>x.status)).toEqual([202,202]);expect(await replies[0]!.json()).toEqual(await replies[1]!.json());
    expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.lock).toHaveBeenCalledTimes(2);
    expect(task?.inputJson).toEqual({trigger:'manual',userId:'user',workspaceId:'workspace-a'});
    task!.status='RUNNING';const again=await POST(req(),context());expect((await again.json()).id).toBe('task-1');expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.role).toHaveBeenCalledWith('workspace-a','user','VIEWER');
  });
  it('confirms an existing automatic queue item without creating a second import',async()=>{
    await POST(req(),context());task!.inputJson={trigger:'automatic'};mocks.create.mockClear();
    await POST(req(),context());expect(task!.inputJson).toEqual({trigger:'manual',userId:'user',workspaceId:'workspace-a'});expect(mocks.create).not.toHaveBeenCalled();
  });
  it('keeps the fixed snapshot root, initial deadline and chunk counter when reconfirming pending work',async()=>{
    await POST(req(),context());
    const pinned={trigger:'automatic',snapshotSessionId:'fixed-session',snapshotStartedAt:'2026-11-02T05:00:00.000Z',snapshotChunks:17};
    task!.inputJson=pinned;mocks.create.mockClear();mocks.update.mockClear();
    const version=task!.updatedAt;
    expect((await POST(req(),context())).status).toBe(202);
    expect(task!.inputJson).toEqual({...pinned,trigger:'manual',userId:'user',workspaceId:'workspace-a'});
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:task!.id,status:'PENDING',updatedAt:version})}));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not replace a running snapshot actor or its pinned continuation on another receive click',async()=>{
    await POST(req(),context());task!.status='RUNNING';
    const original={trigger:'manual',userId:'original-actor',workspaceId:'original-brand',snapshotSessionId:'fixed-session',snapshotStartedAt:'2026-11-02T05:00:00.000Z',snapshotChunks:17};
    task!.inputJson=original;mocks.update.mockClear();mocks.create.mockClear();
    expect((await POST(req(),context())).status).toBe(202);
    expect(task!.inputJson).toEqual(original);expect(mocks.update).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not overwrite a continuation advanced after the pending task was read',async()=>{
    await POST(req(),context());const original={trigger:'manual',userId:'original',snapshotSessionId:'fixed-session',snapshotStartedAt:'2026-11-02T05:00:00.000Z',snapshotChunks:17};task!.inputJson=original;
    mocks.update.mockImplementationOnce(async({where})=>{
      expect(where.updatedAt).toEqual(now());task!.updatedAt=new Date(now().getTime()+1);task!.inputJson={...original,snapshotChunks:18};
      return {count:0};
    });
    expect((await POST(req(),context())).status).toBe(202);expect(task!.inputJson).toEqual({...original,snapshotChunks:18});
  });
  it('keeps reception available for old automatic or untagged pending work, then restores confirmed progress',async()=>{
    await POST(req(),context());
    for(const inputJson of [{trigger:'automatic'},null]){
      task!.inputJson=inputJson;
      const data=InspirationReceiveStatus.parse(await (await GET(req(),context())).json());
      expect(data.task).toBeNull();expect(data.canReceive).toBe(true);
      expect(mocks.find.mock.calls.at(-1)![0].where.OR).toEqual([{status:{not:'PENDING'}},{inputJson:{path:['trigger'],equals:'manual'}}]);
    }
    await POST(req(),context());
    expect((await (await GET(req(),context())).json()).task).toMatchObject({id:'task-1',status:'PENDING'});expect(mocks.create).toHaveBeenCalledOnce();
  });
  it.each(['RUNNING','SUCCEEDED','FAILED'] as const)('does not hide older automatic %s receipts',async status=>{
    await POST(req(),context());task!.inputJson={trigger:'automatic'};task!.status=status;
    expect((await (await GET(req(),context())).json()).task).toMatchObject({id:'task-1',status});
  });
  it('does not let another workspace reuse a task or read its receipt',async()=>{
    await POST(req(),context());const response=await GET(req(),context('workspace-b'));
    expect((await response.json()).task).toBeNull();expect(mocks.role).toHaveBeenCalledWith('workspace-b','user','VIEWER');
    expect(mocks.find.mock.calls.every(([arg])=>arg.where.kind==='INSPIRATION_SYNC')).toBe(true);
  });
  it.each([401,403,404])('returns authorization failure %s before writing any queue state',async(status)=>{
    mocks.role.mockRejectedValue(Object.assign(new Error('access denied'),{status}));
    expect((await POST(req(),context())).status).toBe(status);expect(mocks.transaction).not.toHaveBeenCalled();
    expect((await GET(req(),context())).status).toBe(status);expect(mocks.find).not.toHaveBeenCalled();
  });
  it('projects expired work as failed without GET writes, and permits a new bounded reception',async()=>{
    await POST(req(),context());task!.expiresAt=new Date(now().getTime()-1);mocks.transaction.mockClear();mocks.update.mockClear();
    const result=InspirationReceiveStatus.parse(await (await GET(req(),context())).json());
    expect(result.task).toMatchObject({id:'task-1',status:'FAILED'});expect(result.task?.error).toContain('超时');
    expect(task!.status).toBe('PENDING');expect(mocks.transaction).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();
    await POST(req(),context());expect(task!.id).toBe('task-2');expect(task!.expiresAt!.getTime()-now().getTime()).toBe(360000);
  });
  it('exposes safe progress, role capability, and no provider diagnostics',async()=>{
    await POST(req(),context());task!.status='FAILED';task!.error='private-token-response';mocks.role.mockResolvedValue({role:'VIEWER'});
    const response=await GET(req(),context());expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data=InspirationReceiveStatus.parse(await response.json());expect(data.canReceive).toBe(false);expect(data.mode).toBe('manual');expect(data.task?.error).toContain('接收未完成');expect(JSON.stringify(data)).not.toContain('private-');
    expect(mocks.find.mock.calls.at(-1)![0].select).not.toHaveProperty('inputJson');
  });
  it('keeps the quota explanation and renders it for current manual mode rather than an obsolete automatic promise',async()=>{
    await POST(req(),context());task!.status='FAILED';task!.error=DAILY_IMAGE_LIMIT_AUTOMATIC;
    const result=InspirationReceiveStatus.parse(await (await GET(req(),context())).json());
    expect(result.task?.error).toBe(DAILY_IMAGE_LIMIT_MANUAL);expect(result.task?.error).not.toContain('发布连接');
  });
  it('keeps the safe storage-capacity explanation without exposing task internals',async()=>{
    await POST(req(),context());task!.status='FAILED';task!.error='灵感库存储容量不足，已保存接收进度，已有内容保留。';
    task!.inputJson={trigger:'manual',snapshotSessionId:'private-session',snapshotChunks:19};
    const result=InspirationReceiveStatus.parse(await (await GET(req(),context())).json());
    expect(result.task?.error).toBe(task!.error);expect(JSON.stringify(result)).not.toContain('private-session');
  });
  it('keeps disabled or unconfigured reception unavailable',async()=>{
    mocks.enabled.mockReturnValue(false);expect((await POST(req(),context())).status).toBe(503);
    expect((await (await GET(req(),context())).json()).canReceive).toBe(false);expect(mocks.find).not.toHaveBeenCalled();
    mocks.enabled.mockReturnValue(true);mocks.configured.mockReturnValue(false);expect((await POST(req(),context())).status).toBe(503);expect(mocks.create).not.toHaveBeenCalled();
  });
});
