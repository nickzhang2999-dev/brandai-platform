"use client";

import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Asset } from "@brandai/contracts";
import { VI } from "@brandai/contracts";
import {
  Badge,
  Button,
  FieldLabel,
  Input,
  Panel,
  SectionHeading,
  Spinner,
  StyleTag,
  Textarea,
} from "@brandai/ui";
import { apiFetch, assetThumbUrl } from "@/lib/client";

/**
 * Rule-level prohibition manager (P1.1). Distinct from `ComplianceTerm`
 * (word-level). Captures severity, scope tags, affects-generation /
 * affects-validation toggles, optional positive/negative example assets and
 * a suggested alternative.
 */

type Severity = VI.ProhibitionSeverity;
type Status = VI.ProhibitionStatus;
type Rule = VI.ProhibitionRule;

const SEVERITIES: Severity[] = ["HIGH", "MEDIUM", "LOW"];
const STATUSES: Status[] = ["ACTIVE", "INACTIVE", "PENDING"];

const SEVERITY_TONE: Record<Severity, "danger" | "risk" | "neutral"> = {
  HIGH: "danger",
  MEDIUM: "risk",
  LOW: "neutral",
};

function blankDraft(): VI.CreateProhibitionRuleInput {
  return {
    severity: "MEDIUM",
    affectsGeneration: true,
    affectsValidation: true,
    description: "",
    scope: [],
    applicableChannels: [],
    status: "ACTIVE",
  };
}

function splitCsv(s: string): string[] {
  return s
    .split(/[,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function ProhibitionRuleEntry({ wsId }: { wsId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<VI.CreateProhibitionRuleInput>(blankDraft());
  const [editingId, setEditingId] = useState<string | null>(null);

  const rules = useQuery({
    queryKey: ["prohibitions", wsId],
    queryFn: () => apiFetch<Rule[]>(`/api/workspaces/${wsId}/prohibitions`),
  });
  const assets = useQuery({
    queryKey: ["assets", wsId],
    queryFn: () => apiFetch<Asset[]>(`/api/workspaces/${wsId}/assets`),
  });

  const create = useMutation({
    mutationFn: (body: VI.CreateProhibitionRuleInput) =>
      apiFetch<Rule>(`/api/workspaces/${wsId}/prohibitions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setDraft(blankDraft());
      qc.invalidateQueries({ queryKey: ["prohibitions", wsId] });
    },
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: VI.UpdateProhibitionRuleInput }) =>
      apiFetch<Rule>(`/api/workspaces/${wsId}/prohibitions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["prohibitions", wsId] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/workspaces/${wsId}/prohibitions/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["prohibitions", wsId] }),
  });

  const assetById = useMemo(
    () => new Map((assets.data ?? []).map((a) => [a.id, a])),
    [assets.data],
  );

  return (
    <div className="flex flex-col gap-10">
      <Panel className="flex flex-col gap-6">
        <SectionHeading eyebrow="NEW RULE · 规则级" title="新建禁用规范" />
        <DraftForm
          value={draft}
          onChange={setDraft}
          assets={assets.data ?? []}
        />
        <div>
          <Button
            size="sm"
            disabled={!draft.description.trim() || create.isPending}
            onClick={() => create.mutate(draft)}
          >
            {create.isPending ? <Spinner /> : null}
            新建
          </Button>
        </div>
      </Panel>

      <div className="flex flex-col gap-5">
        <SectionHeading
          eyebrow="LIBRARY · 已配置"
          title={`已有规范（${rules.data?.length ?? 0}）`}
        />
        {rules.isLoading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : null}
        {(rules.data ?? []).map((r) => (
          <div
            key={r.id}
            className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm"
          >
            {editingId === r.id ? (
              <EditingRow
                rule={r}
                assets={assets.data ?? []}
                onCancel={() => setEditingId(null)}
                onSave={(body) => patch.mutate({ id: r.id, body })}
                saving={patch.isPending}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                  <StyleTag>{r.status}</StyleTag>
                  {r.affectsGeneration ? (
                    <Badge tone="strong">影响生成</Badge>
                  ) : null}
                  {r.affectsValidation ? (
                    <Badge tone="strong">影响校验</Badge>
                  ) : null}
                  {r.scope.map((s) => (
                    <StyleTag key={s}>{s}</StyleTag>
                  ))}
                </div>
                <p className="text-sm leading-relaxed text-foreground">
                  {r.description}
                </p>
                {r.alternativeSuggestion ? (
                  <p className="text-xs text-muted-foreground">
                    替代建议：
                    <span className="text-accent">
                      {r.alternativeSuggestion}
                    </span>
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  {r.positiveExampleAssetId ? (
                    <ExampleAssetTag
                      label="正例"
                      asset={assetById.get(r.positiveExampleAssetId)}
                    />
                  ) : null}
                  {r.negativeExampleAssetId ? (
                    <ExampleAssetTag
                      label="反例"
                      asset={assetById.get(r.negativeExampleAssetId)}
                    />
                  ) : null}
                </div>
                <div className="flex gap-2 border-t border-foreground/10 pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingId(r.id)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={del.isPending}
                    onClick={() => {
                      if (confirm("删除该规范？")) del.mutate(r.id);
                    }}
                  >
                    删除
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
        {(rules.data?.length ?? 0) === 0 && !rules.isLoading ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
            <FieldLabel className="text-accent">EMPTY · 待配置</FieldLabel>
            <p className="font-serif text-xl text-foreground/80">
              尚未配置禁用规范
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              用上方表单录入第一条规则级禁用规范，它会注入生成前预检与生成后复检。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftForm({
  value,
  onChange,
  assets,
}: {
  value: VI.CreateProhibitionRuleInput;
  onChange: (v: VI.CreateProhibitionRuleInput) => void;
  assets: Asset[];
}) {
  function set<K extends keyof VI.CreateProhibitionRuleInput>(
    k: K,
    v: VI.CreateProhibitionRuleInput[K],
  ) {
    onChange({ ...value, [k]: v });
  }
  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-1.5">
        <FieldLabel>描述 *</FieldLabel>
        <Textarea
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="例如：包装图禁用红色 Logo 在白底外"
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <SelectField
          label="severity"
          value={value.severity}
          onChange={(v) => set("severity", v as Severity)}
          options={SEVERITIES}
        />
        <SelectField
          label="status"
          value={value.status ?? "ACTIVE"}
          onChange={(v) => set("status", v as Status)}
          options={STATUSES}
        />
        <div className="flex flex-col gap-1.5">
          <FieldLabel>scope（逗号分隔）</FieldLabel>
          <Input
            value={value.scope.join(", ")}
            onChange={(e) => set("scope", splitCsv(e.target.value))}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-foreground/80">
          <input
            type="checkbox"
            checked={value.affectsGeneration}
            onChange={(e) => set("affectsGeneration", e.target.checked)}
            className="h-4 w-4 rounded border-foreground/20 text-primary accent-primary"
          />
          影响生成
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground/80">
          <input
            type="checkbox"
            checked={value.affectsValidation}
            onChange={(e) => set("affectsValidation", e.target.checked)}
            className="h-4 w-4 rounded border-foreground/20 text-primary accent-primary"
          />
          影响校验
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel>applicableChannels（逗号分隔）</FieldLabel>
        <Input
          value={value.applicableChannels.join(", ")}
          onChange={(e) =>
            set("applicableChannels", splitCsv(e.target.value))
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel>替代建议</FieldLabel>
        <Input
          value={value.alternativeSuggestion ?? ""}
          onChange={(e) => set("alternativeSuggestion", e.target.value)}
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <AssetPicker
          label="正例资产"
          assets={assets}
          value={value.positiveExampleAssetId ?? null}
          onChange={(v) => set("positiveExampleAssetId", v ?? undefined)}
        />
        <AssetPicker
          label="反例资产"
          assets={assets}
          value={value.negativeExampleAssetId ?? null}
          onChange={(v) => set("negativeExampleAssetId", v ?? undefined)}
        />
      </div>
    </div>
  );
}

function EditingRow({
  rule,
  assets,
  onCancel,
  onSave,
  saving,
}: {
  rule: Rule;
  assets: Asset[];
  onCancel: () => void;
  onSave: (body: VI.UpdateProhibitionRuleInput) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<VI.CreateProhibitionRuleInput>({
    severity: rule.severity,
    affectsGeneration: rule.affectsGeneration,
    affectsValidation: rule.affectsValidation,
    description: rule.description,
    scope: rule.scope,
    positiveExampleAssetId: rule.positiveExampleAssetId,
    negativeExampleAssetId: rule.negativeExampleAssetId,
    alternativeSuggestion: rule.alternativeSuggestion,
    applicableChannels: rule.applicableChannels,
    status: rule.status,
  });
  return (
    <div className="flex flex-col gap-3">
      <DraftForm value={draft} onChange={setDraft} assets={assets} />
      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? <Spinner /> : null}
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function AssetPicker({
  label,
  assets,
  value,
  onChange,
}: {
  label: string;
  assets: Asset[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-10 w-full rounded-xl border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">— 未关联 —</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.fileName}
          </option>
        ))}
      </select>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-xl border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function ExampleAssetTag({
  label,
  asset,
}: {
  label: string;
  asset?: Asset;
}) {
  if (!asset) return null;
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-foreground/10 bg-muted px-2.5 py-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetThumbUrl(asset.workspaceId, asset.id, asset.url)}
        alt={asset.fileName}
        className="h-12 w-12 rounded-xl object-cover"
      />
      <div className="flex flex-col text-xs">
        <span className="font-mono uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </span>
        <span className="text-foreground/80">{asset.fileName}</span>
      </div>
    </div>
  );
}
