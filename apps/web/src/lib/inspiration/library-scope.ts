export type LibraryScope={id:string;kind:'WORKSPACE'|'SHARED';ownerId:string;legacyWorkspaceId:string|null};
export type LibraryInput=LibraryScope|string;
/** A bare old identifier always means a private workspace, never a shared library. */
export function libraryScope(value:LibraryInput):LibraryScope {
  return typeof value==='string'?{id:value,kind:'WORKSPACE',ownerId:'',legacyWorkspaceId:value}:value;
}
export function sourceLibrary(value:LibraryScope){return {id:value.id,kind:value.kind};}
