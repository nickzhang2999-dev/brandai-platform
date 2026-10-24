import { beforeEach, describe, expect, it, vi } from 'vitest';
const db=vi.hoisted(()=>({findUnique:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{asyncTask:{findUnique:db.findUnique}}}));
import { getTask } from '../src/lib/async-tasks';
describe('generic task polling preserves inspiration conversation privacy',()=>{
  beforeEach(()=>{db.findUnique.mockResolvedValue({id:'task',workspaceId:'ws',kind:'INSPIRATION_CHAT',inputJson:{userId:'author',conversationId:'private'},resultJson:{answer:'private text'},status:'SUCCEEDED',progress:100,refCount:0,createdAt:new Date(),updatedAt:new Date()});});
  it('rejects a different workspace',async()=>expect(await getTask('other','task','author')).toBeNull());
  it('never exposes service-only image jobs through browser task polling',async()=>{db.findUnique.mockResolvedValue({id:'task',workspaceId:'ws',kind:'OMNI_INSPIRATION_ANALYSIS'});expect(await getTask('ws','task','author')).toBeNull();});
  it('rejects other workspace members and missing initiator context',async()=>{expect(await getTask('ws','task','member')).toBeNull();expect(await getTask('ws','task')).toBeNull();});
  it('returns only task metadata to its initiator',async()=>{const value=await getTask('ws','task','author');expect(value?.status).toBe('SUCCEEDED');expect(value).not.toHaveProperty('inputJson');expect(value).not.toHaveProperty('result');expect(JSON.stringify(value)).not.toContain('private');});
});
