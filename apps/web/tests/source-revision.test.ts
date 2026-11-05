import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSourceRevision } from "@/lib/workers/source-revision";
const roots:string[]=[];
function root(git=false){const dir=mkdtempSync(join(tmpdir(),"novart-revision-test-"));roots.push(dir);if(git)mkdirSync(join(dir,".git"));return dir;}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
describe("runtime source identity",()=>{
  it("does not spawn Git in an immutable image",async()=>{vi.useFakeTimers();const run=vi.fn();const stop=watchSourceRevision("a".repeat(40),vi.fn(),root(),run);await vi.advanceTimersByTimeAsync(60000);expect(run).not.toHaveBeenCalled();stop();});
  it("restarts a mounted checkout on drift without overlapping probes",async()=>{
    vi.useFakeTimers();vi.spyOn(console,"log").mockImplementation(()=>{});let resolve!:(value:any)=>void;
    const run=vi.fn().mockImplementation(()=>new Promise(done=>{resolve=done})),shutdown=vi.fn().mockResolvedValue(undefined);
    const stop=watchSourceRevision("a".repeat(40),shutdown,root(true),run);
    await vi.advanceTimersByTimeAsync(45000);expect(run).toHaveBeenCalledOnce();resolve({stdout:"b".repeat(40)});
    await vi.advanceTimersByTimeAsync(45000);expect(shutdown).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledOnce();stop();
  });
  it("reports a missing Git capability once, with no raw error leakage",async()=>{
    vi.useFakeTimers();const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const run=vi.fn().mockRejectedValue(Object.assign(new Error("private-command"),{code:"ENOENT"}));
    const stop=watchSourceRevision("a".repeat(40),vi.fn(),root(true),run);await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledOnce();expect(warn).toHaveBeenCalledOnce();expect(JSON.stringify(warn.mock.calls)).not.toContain("private-command");stop();
  });
});
