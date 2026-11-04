import { prisma } from "@brandai/db";
import { requireAdmin } from "@/lib/admin";
import { sharedLibraryId, sharedLibrarySetupId } from "@/lib/inspiration/library";
import { inspirationEnabled, syncConfigured } from "@/lib/inspiration/config";
import { LibrarySetupForm } from "./LibrarySetupForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "共享灵感库 · 管理后台" };

export default async function AdminInspirationPage() {
  await requireAdmin();
  const libraryId = sharedLibrarySetupId();
  const activeLibraryId = sharedLibraryId();
  const [library, identity, workspaces] = await Promise.all([
    libraryId ? prisma.inspirationLibrary.findUnique({ where: { id: libraryId }, select: { kind: true, ownerId: true } }) : null,
    libraryId ? prisma.inspirationLibraryIdentity.findUnique({ where: { id: libraryId }, select: { ownerId: true } }) : null,
    prisma.brandWorkspace.findMany({ where: { owner: { isActive: true } }, select: { id: true, name: true, ownerId: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
  ]);
  const conflict = Boolean(library && (library.kind !== "SHARED" || identity?.ownerId !== library.ownerId));
  return <div className="mx-auto max-w-2xl px-6 py-10">
    <h1 className="text-2xl font-semibold">公司共享灵感库</h1>
    <p className="mt-2 text-sm text-muted-foreground">同一公司内具有品牌访问权限的成员可引用共享案例；其他公司及未登录访客无法访问。</p>
    <LibrarySetupForm libraryId={libraryId} activeLibraryId={activeLibraryId} enabled={inspirationEnabled()} configured={syncConfigured("SHARED")}
      initialized={Boolean(library && !conflict)} conflict={conflict} boundOwnerId={identity?.ownerId ?? library?.ownerId ?? null} workspaces={workspaces} />
  </div>;
}
