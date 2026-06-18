"use client";

import { useRef, useState } from "react";
import { AssetCategory } from "@brandai/contracts";
import { Button, Spinner, FieldLabel } from "@brandai/ui";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "@/lib/client";

type Phase = "queued" | "uploading" | "saving" | "done" | "error";

interface UploadItem {
  id: string;
  file: File;
  progress: number;
  phase: Phase;
  error?: string;
}

/**
 * Upload the file (and create the Asset row) in one multipart POST to the
 * server, using XHR so we keep upload progress. The browser sets the multipart
 * boundary, so we must NOT set the content-type header manually.
 */
function uploadToServer(
  url: string,
  fd: FormData,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(xhr.responseText || `上传失败 ${xhr.status}`));
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(fd);
  });
}

export function AssetUploader({
  wsId,
  onDone,
}: {
  wsId: string;
  onDone: () => void;
}) {
  const [category, setCategory] = useState<AssetCategory>("PRODUCT");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (id: string, p: Partial<UploadItem>) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...p } : it)),
    );

  async function uploadOne(item: UploadItem, cat: AssetCategory) {
    try {
      patch(item.id, { phase: "uploading" });
      const fd = new FormData();
      fd.append("file", item.file);
      fd.append("category", cat);
      await uploadToServer(
        `/api/workspaces/${wsId}/assets/upload`,
        fd,
        (pct) => patch(item.id, { progress: pct }),
      );
      patch(item.id, { phase: "saving", progress: 100 });
      patch(item.id, { phase: "done" });
    } catch (e) {
      patch(item.id, {
        phase: "error",
        error: e instanceof Error ? e.message : "上传失败",
      });
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const cat = category;
    const next: UploadItem[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      phase: "queued" as Phase,
    }));
    setItems((prev) => [...next, ...prev]);
    await Promise.all(next.map((it) => uploadOne(it, cat)));
    onDone();
  }

  const busy = items.some(
    (i) => i.phase !== "done" && i.phase !== "error",
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <FieldLabel>资产分类 · CATEGORY</FieldLabel>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as AssetCategory)}
          className="h-10 w-full max-w-xs rounded-xl border border-foreground/15 bg-background px-4 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c] ?? c}
            </option>
          ))}
        </select>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-14 text-center transition-colors ${
          dragging
            ? "border-accent bg-muted"
            : "border-foreground/15 bg-muted/40 hover:border-accent"
        }`}
      >
        <span className="font-serif text-2xl text-foreground">
          拖拽文件到此处，或点击选择
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          多文件上传 · 直传对象存储
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card px-4 py-3 text-sm"
            >
              <span className="flex-1 truncate">{it.file.name}</span>
              {it.phase === "error" ? (
                <span className="text-destructive">{it.error}</span>
              ) : it.phase === "done" ? (
                <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-accent">
                  已入库
                </span>
              ) : (
                <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <Spinner />
                  {it.phase === "uploading"
                    ? `${it.progress}%`
                    : it.phase === "saving"
                      ? "保存中"
                      : "准备中"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          选择文件
        </Button>
        {busy ? (
          <span className="text-xs text-muted-foreground">上传中…</span>
        ) : null}
      </div>
    </div>
  );
}
