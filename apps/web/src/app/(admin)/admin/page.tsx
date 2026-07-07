import { redirect } from "next/navigation";

/**
 * /admin has no page of its own — land on the first console tab. The layout
 * (and each target page) enforces the admin gate, so this bare redirect is safe.
 */
export default function AdminIndexPage() {
  redirect("/admin/settings");
}
