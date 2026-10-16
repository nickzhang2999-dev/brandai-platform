"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@brandai/ui";
import { useBrand } from "../brand-context";

export function AccountNavActions() {
  const router = useRouter();
  const { wsId } = useBrand();
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => router.back()}>
        ← 返回上一页
      </Button>
      <Link href={`/studio?${new URLSearchParams({ workspaceId: wsId })}`}>
        <Button>返回 AI 工作台</Button>
      </Link>
    </div>
  );
}
