"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@brandai/ui";

export function AccountNavActions() {
  const router = useRouter();
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => router.back()}>
        ← 返回上一页
      </Button>
      <Link href="/workspace">
        <Button>返回 AI 工作台</Button>
      </Link>
    </div>
  );
}
