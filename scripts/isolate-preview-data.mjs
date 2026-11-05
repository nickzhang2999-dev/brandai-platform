/** Opt-in preview isolation. Does not change deployment configuration, stop
 * services, touch source rows, or print connection strings. Run after pausing
 * preview admission. A failed copy leaves the empty target for inspection. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertRuntimeDataScope } from "../apps/web/runtime-data-scope.mjs";

const root=process.cwd(),requireDb=createRequire(resolve(root,"packages/db/package.json"));
const {PrismaClient}=requireDb("@prisma/client");
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const scope=process.env.NOVART_TARGET_DATA_SCOPE;
if(!scope||!/^novart_preview_[a-z0-9_]{1,40}$/.test(scope))throw new Error("Explicit preview target scope required");
const url=new URL(process.env.DATABASE_URL);
if((url.searchParams.get("schema")||"public")!=="public")throw new Error("Source must be the legacy public schema");
url.searchParams.set("schema",scope);
assertRuntimeDataScope({NOVART_DATA_SCOPE:scope,DATABASE_URL:url.toString(),BRANDAI_QUEUE_PREFIX:scope});
const source=new PrismaClient(),target=new PrismaClient({datasources:{db:{url:url.toString()}}});
const mode=process.argv[2]||"plan";
let stage="preflight";
try {
  const schemas=await source.$queryRawUnsafe("SELECT nspname FROM pg_namespace WHERE nspname=$1",scope);
  if(mode==="prepare") {
    if(schemas.length)throw new Error("Target exists; refusing to replace it");
    await source.$executeRawUnsafe(`CREATE SCHEMA ${qi(scope)}`);
    await source.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${qi(scope)} FROM PUBLIC`);
    stage="migrations";
    execFileSync(process.execPath,[requireDb.resolve("prisma/build/index.js"),"migrate","deploy","--schema",resolve(root,"packages/db/prisma/schema.prisma")],
      {cwd:root,env:{...process.env,DATABASE_URL:url.toString()},stdio:"pipe",timeout:180000,windowsHide:true});
    const seed={};
    for(const {tablename:t} of await target.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename<>'_prisma_migrations'",scope))
      seed[t]=(await target.$queryRawUnsafe(`SELECT count(*)::int n,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) hash FROM ${qi(scope)}.${qi(t)} t`))[0];
    await target.$executeRawUnsafe(`CREATE TABLE ${qi(scope)}."_NovartIsolation" (id integer PRIMARY KEY, state text NOT NULL, seed jsonb NOT NULL)`);
    await target.$executeRawUnsafe(`INSERT INTO ${qi(scope)}."_NovartIsolation" VALUES (1,'prepared',$1::jsonb)`,JSON.stringify(seed));
    console.log(JSON.stringify({prepared:true,scope}));
  } else if(mode==="copy") {
    if(!schemas.length)throw new Error("Prepare target first");
    const receipt=await target.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='120s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      const q=(sql,...args)=>tx.$queryRawUnsafe(sql,...args);
      const statusTables=await q("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='status' AND table_name <> 'StudioConversationMessage'");
      for(const {table_name:t} of statusTables) {
        const [{n}]=await q(`SELECT count(*)::int n FROM public.${qi(t)} WHERE status::text IN ('PENDING','RUNNING')`);
        if(n)throw new Error("Active source jobs must settle before copying");
      }
      stage="migration-comparison";
      const migrations=await q(`SELECT migration_name,checksum FROM ${qi(scope)}."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL EXCEPT SELECT migration_name,checksum FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
      if(migrations.length)throw new Error("Source and target migrations differ");
      const [marker]=await q(`SELECT state,seed FROM ${qi(scope)}."_NovartIsolation" WHERE id=1 FOR UPDATE`);
      if(marker?.state!=="prepared")throw new Error("Target is not a fresh prepared copy");
      const tables=await q("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename NOT IN ('_prisma_migrations','_NovartIsolation') ORDER BY tablename",scope);
      const foreignKeys=await q("SELECT c.relname AS tablename,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND k.contype='f'",scope);
      const triggers=await q("SELECT c.relname AS tablename,t.tgname,t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal",scope);
      for(const {tablename:t} of tables) {
        stage="empty-target";
        const [current]=await q(`SELECT count(*)::int n,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) hash FROM ${qi(scope)}.${qi(t)} t`);
        if(current.n!==marker.seed[t]?.n||current.hash!==marker.seed[t]?.hash)throw new Error("Target changed after preparation; refusing to overwrite data");
      }
      for(const fk of foreignKeys)await tx.$executeRawUnsafe(`ALTER TABLE ${qi(scope)}.${qi(fk.tablename)} DROP CONSTRAINT ${qi(fk.conname)}`);
      for(const t of triggers)await tx.$executeRawUnsafe(`ALTER TABLE ${qi(scope)}.${qi(t.tablename)} DISABLE TRIGGER ${qi(t.tgname)}`);
      // Only the exact migration seed verified above is replaced. No target
      // user changes can be overwritten, even on a repeated operator command.
      for(const {tablename:t} of tables)if(marker.seed[t].n)await tx.$executeRawUnsafe(`DELETE FROM ${qi(scope)}.${qi(t)}`);
      const counts={};
      for(const {tablename:t} of tables) {
        stage="copy-"+t;
        const cols=await q("SELECT a.attname,ty.typtype::text AS typtype,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type ty ON ty.oid=a.atttypid WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",scope,t);
        const names=cols.map(c=>qi(c.attname)).join(","),values=cols.map(c=>c.typtype==="e"?`${qi(c.attname)}::text::${c.type}`:qi(c.attname)).join(",");
        await tx.$executeRawUnsafe(`INSERT INTO ${qi(scope)}.${qi(t)} (${names}) SELECT ${values} FROM public.${qi(t)}`);
        const hashes=await q(`SELECT 'source' side,count(*)::int n,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) hash FROM public.${qi(t)} t UNION ALL SELECT 'target',count(*)::int,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) FROM ${qi(scope)}.${qi(t)} t`);
        if(hashes[0].n!==hashes[1].n||hashes[0].hash!==hashes[1].hash)throw new Error("Copied rows failed integrity verification");
        counts[t]=hashes[0].n;
      }
      stage="foreign-key-validation";
      for(const fk of foreignKeys)await tx.$executeRawUnsafe(`ALTER TABLE ${qi(scope)}.${qi(fk.tablename)} ADD CONSTRAINT ${qi(fk.conname)} ${fk.definition}`);
      for(const t of triggers)if(t.enabled!=="D")await tx.$executeRawUnsafe(`ALTER TABLE ${qi(scope)}.${qi(t.tablename)} ENABLE ${t.enabled==="A"?"ALWAYS ":t.enabled==="R"?"REPLICA ":""}TRIGGER ${qi(t.tgname)}`);
      const escaped=await q("SELECT count(*)::int n FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class f ON f.oid=k.confrelid JOIN pg_namespace fn ON fn.oid=f.relnamespace WHERE n.nspname=$1 AND k.contype='f' AND fn.nspname<>$1",scope);
      if(escaped[0].n)throw new Error("Foreign keys escaped the preview schema");
      await tx.$executeRawUnsafe(`UPDATE ${qi(scope)}."_NovartIsolation" SET state='copied' WHERE id=1`);
      return {scope,counts,foreignKeys:foreignKeys.length,sourceRowsModified:0};
    },{isolationLevel:"RepeatableRead",timeout:240000});
    console.log(JSON.stringify({copied:true,...receipt}));
  } else if(mode==="plan") {
    console.log(JSON.stringify({scope,targetExists:!!schemas.length,requiresPausedPreview:true,requiresSeparateObjectCopy:true,sourceRowsModified:0}));
  } else throw new Error("Unknown operation");
} catch(error) {
  console.error(JSON.stringify({failed:true,stage,code:/^P\d+$/.test(error?.code??"")?error.code:null}));
  process.exitCode=1;
} finally {await source.$disconnect();await target.$disconnect();}
