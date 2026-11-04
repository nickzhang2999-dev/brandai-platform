import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const React = createRequire(new URL('../package.json',import.meta.url))('react');
const f=vi.hoisted(()=>({admin:vi.fn(),library:vi.fn(),identity:vi.fn(),workspaces:vi.fn(),libraryId:vi.fn()}));
vi.mock('@/lib/admin',()=>({requireAdmin:f.admin}));
vi.mock('@/lib/inspiration/library',()=>({sharedLibrarySetupId:f.libraryId,sharedLibraryId:()=>null}));
vi.mock('@/lib/inspiration/config',()=>({inspirationEnabled:()=>true,syncConfigured:()=>true}));
vi.mock('../../../packages/db/src/index',()=>({prisma:{inspirationLibrary:{findUnique:f.library},inspirationLibraryIdentity:{findUnique:f.identity},brandWorkspace:{findMany:f.workspaces}}}));
vi.mock('../src/app/(admin)/admin/inspiration/LibrarySetupForm',()=>({LibrarySetupForm:()=>null}));
import Page from '../src/app/(admin)/admin/inspiration/page';
import {LibrarySetupForm} from '../src/app/(admin)/admin/inspiration/LibrarySetupForm';
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('React',React);f.admin.mockResolvedValue({id:'admin'});f.libraryId.mockReturnValue('company-library');f.library.mockResolvedValue(null);f.identity.mockResolvedValue(null);f.workspaces.mockResolvedValue([{id:'brand',name:'Brand',ownerId:'owner'}]);});
afterEach(()=>vi.unstubAllGlobals());
describe('admin inspiration metadata',()=>{
  it('rejects non administrators before reading any metadata',async()=>{f.admin.mockRejectedValue(new Error('denied'));await expect(Page()).rejects.toThrow('denied');expect(f.library).not.toHaveBeenCalled();expect(f.identity).not.toHaveBeenCalled();expect(f.workspaces).not.toHaveBeenCalled();});
  it('selects only active owner brand identifiers and names, without emails or credentials',async()=>{const page=await Page();expect(f.workspaces).toHaveBeenCalledWith({where:{owner:{isActive:true}},select:{id:true,name:true,ownerId:true},orderBy:[{name:'asc'},{id:'asc'}]});const form=React.Children.toArray(page.props.children).find((e:{type:unknown})=>e.type===LibrarySetupForm);expect(form.props.initialized).toBe(false);expect(form.props.conflict).toBe(false);});
  it('fails closed when the stored permanent identity disagrees with the library',async()=>{f.library.mockResolvedValue({kind:'SHARED',ownerId:'owner'});f.identity.mockResolvedValue({ownerId:'other'});const page=await Page();const form=React.Children.toArray(page.props.children).find((e:{type:unknown})=>e.type===LibrarySetupForm);expect(form.props.conflict).toBe(true);expect(form.props.initialized).toBe(false);});
});
