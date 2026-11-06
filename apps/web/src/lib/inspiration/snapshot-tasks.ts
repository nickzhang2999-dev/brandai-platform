export const SNAPSHOT_INTENT_MS=24*60*60_000;
export type SnapshotTaskInput={trigger?:string;userId?:string;workspaceId?:string;snapshotSessionId?:string;snapshotStartedAt?:string;snapshotChunks?:number;syncClaimId?:string};
export class InspirationSyncClaimLost extends Error {constructor(){super('inspiration_sync_claim_lost');}}
export function continueSnapshotInput(input:SnapshotTaskInput,sessionId:string,now=new Date()):SnapshotTaskInput {
  if(!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)||input.snapshotSessionId&&input.snapshotSessionId!==sessionId)throw new Error('snapshot_intent_conflict');
  const started=input.snapshotStartedAt?Date.parse(input.snapshotStartedAt):now.getTime(),chunks=(input.snapshotChunks??0)+1;
  if(!Number.isFinite(started)||started>now.getTime()+60_000||now.getTime()-started>=SNAPSHOT_INTENT_MS||!Number.isInteger(chunks)||chunks<1||chunks>20000)throw new Error('snapshot_intent_expired');
  return {...input,snapshotSessionId:sessionId,snapshotStartedAt:new Date(started).toISOString(),snapshotChunks:chunks};
}
