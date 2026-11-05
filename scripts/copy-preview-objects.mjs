/** Copy-only, opt-in physical storage isolation. Never deletes source objects. */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { scopedObjectKey } from "../apps/web/runtime-data-scope.mjs";
const r=createRequire(resolve(process.cwd(),"apps/web/package.json"));r("tsx/cjs");
const {S3Client,ListObjectsV2Command,HeadObjectCommand,CopyObjectCommand}=r("@aws-sdk/client-s3");
const {getEffectiveStorage}=r("./src/lib/settings.ts");
const scope=process.env.NOVART_TARGET_DATA_SCOPE;
if(!scope)throw new Error("Explicit target scope required");
const env={NOVART_DATA_SCOPE:scope};scopedObjectKey("preflight",env);
const copy=process.argv[2]==="copy";
let client,stage="configuration";
try {
  const c=await getEffectiveStorage();if(!c.configured)throw new Error("Storage unavailable");
  client=new S3Client({region:c.region,endpoint:c.endpoint,forcePathStyle:c.forcePathStyle,credentials:{accessKeyId:c.accessKey,secretAccessKey:c.secretKey}});
  stage="inventory";
  let cursor,bytes=0;const objects=[];
  do {
    const page=await client.send(new ListObjectsV2Command({Bucket:c.bucket,MaxKeys:1000,ContinuationToken:cursor}),{abortSignal:AbortSignal.timeout(30000)});
    for(const o of page.Contents??[])if(o.Key&&!o.Key.startsWith("deployments/")){objects.push(o);bytes+=o.Size??0;}
    if(objects.length>10000||bytes>4*1024**3)throw new Error("Copy budget exceeded");
    cursor=page.IsTruncated?page.NextContinuationToken:null;
  }while(cursor);
  if(!copy)console.log(JSON.stringify({scope,objects:objects.length,bytes,sourceObjectsModified:0}));
  else {
    let copied=0,existing=0;stage="copy";
    for(let start=0;start<objects.length;start+=3)await Promise.all(objects.slice(start,start+3).map(async o=>{
      const key=scopedObjectKey(o.Key,env),params={Bucket:c.bucket,Key:key};
      let current;
      try{current=await client.send(new HeadObjectCommand(params),{abortSignal:AbortSignal.timeout(30000)});}
      catch(e){if(!["NotFound","NoSuchKey"].includes(e.name))throw e;}
      if(current){if(current.ContentLength!==o.Size||current.ETag!==o.ETag)throw new Error("Existing destination differs; refusing overwrite");existing++;return;}
      await client.send(new CopyObjectCommand({...params,CopySource:`/${encodeURIComponent(c.bucket)}/${o.Key.split('/').map(encodeURIComponent).join('/')}`,CopySourceIfMatch:o.ETag}),{abortSignal:AbortSignal.timeout(60000)});
      const verified=await client.send(new HeadObjectCommand(params),{abortSignal:AbortSignal.timeout(30000)});
      if(verified.ContentLength!==o.Size||verified.ETag!==o.ETag)throw new Error("Copied object failed integrity verification");
      copied++;
    }));
    console.log(JSON.stringify({scope,objects:objects.length,bytes,copied,existing,verified:true,sourceObjectsModified:0}));
  }
}catch(e){console.error(JSON.stringify({failed:true,stage,status:e?.$metadata?.httpStatusCode??null}));process.exitCode=1;}
finally{client?.destroy();}
