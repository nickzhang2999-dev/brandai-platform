vi.mock("@/lib/studio-writing-notifications", () => ({ listWritingNotifications: async () => [] }));
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({chats:vi.fn(),generations:vi.fn(),tasks:vi.fn(),uploads:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationChat:{findMany:f.chats},generation:{findMany:f.generations},asyncTask:{findMany:f.tasks},studioMaterialUpload:{findMany:f.uploads}}}));
vi.mock('@/lib/brand-preview',()=>({BRAND_PREVIEW_PROJECT_NAME:'hidden'}));
vi.mock('@/lib/studio-notifications',()=>({listStudioGenerationNotifications:async()=>[]}));
vi.mock('@/lib/studio-layer-notifications',()=>({listStudioLayerNotifications:async()=>[]}));
vi.mock('@/lib/studio-workflow-notifications',()=>({listStudioWorkflowNotifications:async()=>[]}));
vi.mock('@/lib/studio-copywriting-notifications',()=>({listCopywritingNotifications:async()=>[]}));
import {listInspirationNotifications} from '@/lib/inspiration/notifications';
import {listWorkspaceNotifications} from '@/lib/notifications';
import {AsyncTaskKind,NotificationItem} from '@brandai/contracts';
const row={id:'chat',workspaceId:'ws',userId:'user',conversationId:'conversation',status:'SUCCEEDED',updatedAt:new Date('2026-10-22T00:00:00Z')};
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('INSPIRATION_ENABLED','true');f.chats.mockResolvedValue([row]);f.generations.mockResolvedValue([]);f.tasks.mockResolvedValue([]);f.uploads.mockResolvedValue([]);});
afterEach(()=>vi.unstubAllEnvs());
describe('private inspiration completion notifications',()=>{
  it('does not query when disabled or no authenticated user is supplied',async()=>{vi.stubEnv('INSPIRATION_ENABLED','false');expect(await listInspirationNotifications('ws','user',20)).toEqual([]);vi.stubEnv('INSPIRATION_ENABLED','true');expect(await listWorkspaceNotifications('ws')).toEqual([]);expect(f.chats).not.toHaveBeenCalled();});
  it('queries only the current user and workspace terminal metadata',async()=>{
    const result=await listInspirationNotifications('ws','user',20);
    expect(f.chats).toHaveBeenCalledWith({where:{workspaceId:'ws',userId:'user',status:{in:['SUCCEEDED','FAILED']}},select:{id:true,workspaceId:true,userId:true,conversationId:true,status:true,updatedAt:true},orderBy:{updatedAt:'desc'},take:20});
    expect(NotificationItem.parse(result[0])).toMatchObject({id:'inspiration-chat:chat',kind:'INSPIRATION_CHAT',title:'灵感问答已完成',href:'/inspiration?workspaceId=ws&conversationId=conversation'});expect(AsyncTaskKind.parse('INSPIRATION_CHAT')).toBe('INSPIRATION_CHAT');
  });
  it('does not include another user, another workspace or in-flight task even from an unexpected data result',async()=>{f.chats.mockResolvedValue([{...row,userId:'other'},{...row,workspaceId:'other'},{...row,status:'RUNNING'}]);expect(await listInspirationNotifications('ws','user',20)).toEqual([]);});
  it('never reflects question, answer, source evidence or provider error into a failed notification',async()=>{f.chats.mockResolvedValue([{...row,status:'FAILED',question:'private-question',answer:'withdrawn-text',error:'secret-provider-value',citations:[{title:'private-source'}]}]);const result=await listInspirationNotifications('ws','user',20);expect(result[0]).toMatchObject({status:'FAILED',title:'灵感问答未完成'});for(const secret of ['private-question','withdrawn-text','secret-provider-value','private-source'])expect(JSON.stringify(result)).not.toContain(secret);});
  it('bounds database retrieval and encodes conversation links',async()=>{f.chats.mockResolvedValue([{...row,conversationId:'id&workspaceId=other'}]);const result=await listInspirationNotifications('ws','user',500);expect(f.chats.mock.calls[0]![0].take).toBe(100);const url=new URL(result[0]!.href!,'http://localhost');expect(url.searchParams.get('workspaceId')).toBe('ws');expect(url.searchParams.get('conversationId')).toBe('id&workspaceId=other');});
  it('merges private inspiration results into the shared notification center for the same user',async()=>{const result=await listWorkspaceNotifications('ws',30,'user','studio');expect(result).toHaveLength(1);expect(result[0]!.kind).toBe('INSPIRATION_CHAT');expect(f.chats.mock.calls[0]![0].where.userId).toBe('user');});
});
