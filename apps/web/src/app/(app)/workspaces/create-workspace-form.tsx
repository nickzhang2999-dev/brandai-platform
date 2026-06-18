"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CreateWorkspaceInput,
  type BrandWorkspace,
} from "@brandai/contracts";
import { Button, Input, Label, Spinner } from "@brandai/ui";
import { apiFetch } from "@/lib/client";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = CreateWorkspaceInput.parse({
        name,
        industry: industry || undefined,
        websiteUrl: websiteUrl || undefined,
      });
      return apiFetch<BrandWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
    },
    onSuccess: (ws) => {
      router.push(`/workspaces/${ws.id}`);
      router.refresh();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "创建失败"),
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        mutation.mutate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ws-name">品牌名称 *</Label>
        <Input
          id="ws-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：晨光文具"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ws-industry">行业</Label>
        <Input
          id="ws-industry"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          placeholder="例如：快消 / 美妆 / 3C"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ws-url">官网 URL</Label>
        <Input
          id="ws-url"
          type="url"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          placeholder="https://example.com"
        />
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      <Button type="submit" disabled={mutation.isPending || !name}>
        {mutation.isPending ? <Spinner /> : null}
        创建并进入
      </Button>
    </form>
  );
}
