import { describe, it, expect } from 'vitest';
import { InspirationChatInput, InspirationBookmarkInput } from '../src/inspiration';
const requestId='c78bfd95-d837-47de-a13c-aae41b32ea3f';
describe('inspiration input contracts',()=>{
  it('requires durable request identity and trims user question',()=>{expect(InspirationChatInput.parse({requestId,question:' 包装案例 '})).toEqual({requestId,question:'包装案例'});expect(InspirationChatInput.safeParse({question:'问题'}).success).toBe(false);});
  it('rejects explicit null and path identities',()=>{for(const input of [{requestId,question:'问题',caseIds:null},{requestId,question:'问题',conversationId:null},{requestId,question:'问题',caseIds:['../x']}])expect(InspirationChatInput.safeParse(input).success).toBe(false);});
  it('requires saved revision and rejects null project',()=>{expect(InspirationBookmarkInput.safeParse({caseId:'a',revision:0}).success).toBe(false);expect(InspirationBookmarkInput.safeParse({caseId:'a',revision:1,projectId:null}).success).toBe(false);expect(InspirationBookmarkInput.parse({caseId:'a',revision:1,note:' 借鉴 '})).toEqual({caseId:'a',revision:1,note:'借鉴'});});
});
