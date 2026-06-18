"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ComplianceTerm } from "@brandai/contracts";
import {
  Badge,
  Button,
  FieldLabel,
  Input,
  Panel,
  SectionHeading,
  Spinner,
  StyleTag,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";

type TermType = "FORBIDDEN" | "CAUTION";

interface DraftState {
  term: string;
  reason: string;
  replacement: string;
  type: TermType;
}

const EMPTY: DraftState = {
  term: "",
  reason: "",
  replacement: "",
  type: "FORBIDDEN",
};

/**
 * M5 · 品牌禁用词库 / 慎用词库管理 — full CRUD over ComplianceTerm.
 * These rows feed the `termLib` passed to `ai.complianceCheck` by the
 * precheck / recheck routes.
 */
export function ComplianceTermEntry({ wsId }: { wsId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: terms } = useQuery({
    queryKey: ["terms", wsId],
    queryFn: () =>
      apiFetch<ComplianceTerm[]>(`/api/workspaces/${wsId}/terms`),
  });

  const reset = () => {
    setDraft(EMPTY);
    setEditingId(null);
    setError(null);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        workspaceId: wsId,
        type: draft.type,
        term: draft.term,
        reason: draft.reason || "品牌方录入",
        replacement: draft.replacement || undefined,
      });
      return editingId
        ? apiFetch<ComplianceTerm>(
            `/api/workspaces/${wsId}/terms/${editingId}`,
            { method: "PUT", body },
          )
        : apiFetch<ComplianceTerm>(`/api/workspaces/${wsId}/terms`, {
            method: "POST",
            body,
          });
    },
    onSuccess: () => {
      reset();
      qc.invalidateQueries({ queryKey: ["terms", wsId] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "保存失败"),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean }>(`/api/workspaces/${wsId}/terms/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      if (editingId) reset();
      qc.invalidateQueries({ queryKey: ["terms", wsId] });
    },
  });

  const forbidden = (terms ?? []).filter((t) => t.type === "FORBIDDEN");
  const caution = (terms ?? []).filter((t) => t.type === "CAUTION");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel className="flex flex-col gap-6">
        <SectionHeading
          eyebrow={editingId ? "EDIT TERM · 词级" : "NEW TERM · 词级"}
          title={editingId ? "编辑词条" : "新增词条"}
          action={
            editingId ? (
              <Button variant="ghost" size="sm" onClick={reset}>
                取消编辑
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-1.5">
          <FieldLabel>词 *</FieldLabel>
          <Input
            value={draft.term}
            onChange={(e) =>
              setDraft((d) => ({ ...d, term: e.target.value }))
            }
            placeholder="例如：最佳 / 国家级"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>类型</FieldLabel>
          <select
            value={draft.type}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                type: e.target.value as TermType,
              }))
            }
            className="h-10 w-full rounded-xl border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="FORBIDDEN">违禁 FORBIDDEN</option>
            <option value="CAUTION">慎用 CAUTION</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>原因</FieldLabel>
          <Input
            value={draft.reason}
            onChange={(e) =>
              setDraft((d) => ({ ...d, reason: e.target.value }))
            }
            placeholder="广告法极限词"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>建议替换（可选）</FieldLabel>
          <Input
            value={draft.replacement}
            onChange={(e) =>
              setDraft((d) => ({ ...d, replacement: e.target.value }))
            }
            placeholder="优选"
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        <div>
          <Button
            size="sm"
            disabled={!draft.term || save.isPending}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {save.isPending ? <Spinner /> : null}
            {editingId ? "保存修改" : "添加"}
          </Button>
        </div>
      </Panel>

      <Panel className="flex flex-col gap-6">
        <SectionHeading
          eyebrow="LIBRARY · 词库"
          title={`词库（${terms?.length ?? 0}）`}
        />
        {terms && terms.length > 0 ? (
          <div className="flex flex-col gap-6">
            <TermGroup
              title="禁用词库"
              tone="danger"
              label="违禁"
              items={forbidden}
              editingId={editingId}
              onEdit={(t) => {
                setDraft({
                  term: t.term,
                  reason: t.reason,
                  replacement: t.replacement ?? "",
                  type: t.type,
                });
                setEditingId(t.id);
                setError(null);
              }}
              onDelete={(id) => remove.mutate(id)}
            />
            <TermGroup
              title="慎用词库"
              tone="risk"
              label="慎用"
              items={caution}
              editingId={editingId}
              onEdit={(t) => {
                setDraft({
                  term: t.term,
                  reason: t.reason,
                  replacement: t.replacement ?? "",
                  type: t.type,
                });
                setEditingId(t.id);
                setError(null);
              }}
              onDelete={(id) => remove.mutate(id)}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-foreground/15 bg-card/50 px-6 py-14 text-center">
            <FieldLabel className="text-accent">EMPTY · 待录入</FieldLabel>
            <p className="font-serif text-lg text-foreground/80">
              尚未录入禁用 / 慎用词
            </p>
            <p className="max-w-xs text-sm text-muted-foreground">
              用左侧表单建立第一个词条，词库会注入生成前预检与生成后复检。
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function TermGroup({
  title,
  tone,
  label,
  items,
  editingId,
  onEdit,
  onDelete,
}: {
  title: string;
  tone: "danger" | "risk";
  label: string;
  items: ComplianceTerm[];
  editingId: string | null;
  onEdit: (t: ComplianceTerm) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <FieldLabel>{title}</FieldLabel>
        <span className="font-mono text-xs text-muted-foreground">
          {items.length}
        </span>
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {items.map((t) => (
            <li
              key={t.id}
              className={`flex items-center justify-between gap-3 rounded-2xl border bg-muted px-4 py-3 text-sm transition-colors ${
                editingId === t.id
                  ? "border-accent"
                  : "border-foreground/10"
              }`}
            >
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={tone}>{label}</Badge>
                <span className="font-serif text-foreground">{t.term}</span>
                {t.replacement ? (
                  <StyleTag>→ {t.replacement}</StyleTag>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {t.reason}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(t)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(t.id)}
                >
                  删除
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">尚未录入。</p>
      )}
    </div>
  );
}
