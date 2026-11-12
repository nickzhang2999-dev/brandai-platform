import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";
import { UsersTable } from "./UsersTable";

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) redirect("/studio");
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <UsersTable initial={await listAdminUsers()} currentUserId={session.user.id} />
    </div>
  );
}
