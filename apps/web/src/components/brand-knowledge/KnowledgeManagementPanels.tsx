"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset, BrandRule, ComplianceTerm, RuleSnapshotSummary, RestoreRuleSnapshotResult } from "@brandai/contracts";
import { VI } from "@brandai/contracts";
import { Button, Input, Textarea } from "@brandai/ui";
import { apiFetch } from "../../lib/client";
import { knowledgeValue } from "./knowledge-state";

const fieldClass = "rounded-xl border border-border bg-background px-3 py-2 text-sm";
const cardClass = "space-y-4 rounded-2xl border border-border bg-card p-5";
const endpoint = (ws: string, suffix: string) => `/api/workspaces/${encodeURIComponent(ws)}/${suffix}`;
const csv = (value: string) => value.split(/[,，]/).map(part => part.trim()).filter(Boolean);
const errorText = (value: unknown) => value instanceof Error ? value.message : "操作失败，请重试。";
function ErrorMessage({ error }: { error: unknown }) { return error ? <p role="alert" className="text-sm text-destructive">{errorText(error)}</p> : null; }

export function ManualRuleForm({ wsId, canEdit, onSaved }: { wsId: string; canEdit: boolean; onSaved: () => void }) {
  const [type, setType] = useState<BrandRule["type"]>("copy");
  const [strength, setStrength] = useState<BrandRule["strength"]>("WEAK");
  const [summary, setSummary] = useState("");
  const [value, setValue] = useState("{}");
  const create = useMutation({ mutationFn: () => {
    if (!canEdit || !summary.trim()) throw new Error("请填写规则说明，且需要编辑权限。");
    return apiFetch(endpoint(wsId, "rules"), { method: "POST", body: JSON.stringify({ type, strength, summary: summary.trim(), value: knowledgeValue(value) }) });
  }, onSuccess: onSaved });
  return <form className={cardClass} onSubmit={event => { event.preventDefault(); create.mutate(); }}>
    <h3 className="text-sm font-medium">手动添加待确认规则</h3>
    <div className="flex flex-wrap gap-3"><label className="space-x-2 text-sm">类别 <select className={fieldClass} value={type} disabled={!canEdit} onChange={event => setType(event.target.value as BrandRule["type"])}>
      {([["logo", "Logo"], ["color", "颜色"], ["font", "字体"], ["layout", "设计指南"], ["imagery", "图像"], ["copy", "文案语气"], ["graphic", "设计元素"]] as const).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label><label className="space-x-2 text-sm">强度 <select className={fieldClass} value={strength} disabled={!canEdit} onChange={event => setStrength(event.target.value as BrandRule["strength"])}><option value="WEAK">弱约束</option><option value="STRONG">强约束</option><option value="FORBIDDEN">禁用约束</option></select></label></div>
    <Textarea aria-label="新规则说明" placeholder="写清楚可执行的品牌要求" value={summary} onChange={event => setSummary(event.target.value)} required disabled={!canEdit} />
    <details><summary className="cursor-pointer text-xs text-muted-foreground">补充结构化信息（可选）</summary><Textarea className="mt-2 font-mono text-xs" aria-label="新规则结构化信息" value={value} onChange={event => setValue(event.target.value)} disabled={!canEdit} /></details>
    <ErrorMessage error={create.error} /><Button type="submit" disabled={!canEdit || create.isPending || !summary.trim()}>{create.isPending ? "保存中…" : "保存为草稿"}</Button>
  </form>;
}

export function KnowledgeManagementPanels({ wsId, canEdit, panel, onRulesChanged }: {
  wsId: string; canEdit: boolean; panel: "restrictions" | "versions"; onRulesChanged: () => void;
}) {
  return panel === "versions" ? <SnapshotsPanel wsId={wsId} canEdit={canEdit} onRulesChanged={onRulesChanged} />
    : <div className="space-y-6"><ProhibitionsPanel wsId={wsId} canEdit={canEdit} /><TermsPanel wsId={wsId} canEdit={canEdit} /></div>;
}

function SnapshotsPanel({ wsId, canEdit, onRulesChanged }: { wsId: string; canEdit: boolean; onRulesChanged: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(""); const [note, setNote] = useState(""); const [message, setMessage] = useState("");
  const list = useQuery({ queryKey: ["rule-snapshots", wsId], queryFn: () => apiFetch<{ snapshots: RuleSnapshotSummary[] }>(endpoint(wsId, "rules/snapshots")) });
  const save = useMutation({ mutationFn: () => {
    if (!canEdit) throw new Error("当前权限只能查看版本。");
    return apiFetch<RuleSnapshotSummary>(endpoint(wsId, "rules/snapshots"), { method: "POST", body: JSON.stringify({ label: label.trim(), note: note.trim() || undefined }) });
  }, onSuccess: result => { setLabel(""); setNote(""); setMessage(`已保存「${result.label}」：${result.ruleCount} 条已启用规则。`); void list.refetch(); } });
  const restore = useMutation({ mutationFn: (id: string) => {
    if (!canEdit) throw new Error("当前权限只能查看版本。");
    return apiFetch<RestoreRuleSnapshotResult>(endpoint(wsId, `rules/snapshots/${encodeURIComponent(id)}/restore`), { method: "POST" });
  }, onSuccess: result => { setMessage(`已恢复 ${result.restored} 条规则，停用 ${result.retired} 条；恢复前的状态已自动备份。`); void list.refetch(); void qc.invalidateQueries({ queryKey: ["rules", wsId] }); onRulesChanged(); } });
  return <section className={cardClass} aria-label="规则版本快照">
    <h2 className="font-medium">规则版本快照</h2><p className="text-xs text-muted-foreground">快照只保存已确认的品牌规则，不包含禁用项和词库。恢复前会自动备份当前规则。</p>
    {canEdit && <form className="space-y-3" onSubmit={event => { event.preventDefault(); save.mutate(); }}><Input aria-label="快照名称" placeholder="版本名称" value={label} maxLength={120} required onChange={event => setLabel(event.target.value)} /><Textarea aria-label="快照备注" placeholder="备注（可选）" value={note} maxLength={500} onChange={event => setNote(event.target.value)} /><Button type="submit" disabled={!label.trim() || save.isPending || restore.isPending}>{save.isPending ? "保存中…" : "保存当前规则版本"}</Button></form>}
    <ErrorMessage error={list.error ?? save.error ?? restore.error} />{message && <p role="status" className="text-sm text-primary">{message}</p>}
    {list.isLoading ? <p role="status">正在读取版本…</p> : !list.data?.snapshots.length ? <p className="text-sm text-muted-foreground">还没有版本快照。</p> : <ul className="space-y-3">{list.data.snapshots.map(snapshot => <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/50 p-4"><div><p className="text-sm font-medium">{snapshot.label} · {snapshot.ruleCount} 条规则</p><p className="mt-1 text-xs text-muted-foreground">{snapshot.createdAt.slice(0, 16).replace("T", " ")} {snapshot.note}</p></div>
      {canEdit && <Button type="button" variant="outline" disabled={restore.isPending || save.isPending} onClick={() => { if (window.confirm(`恢复「${snapshot.label}」？当前已启用规则将被此版本替换，不在版本中的规则会停用；恢复前会自动备份。`)) restore.mutate(snapshot.id); }}>恢复此版本</Button>}
    </li>)}</ul>}
  </section>;
}

function TermsPanel({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const empty = { type: "FORBIDDEN" as ComplianceTerm["type"], term: "", reason: "", replacement: "" };
  const [form, setForm] = useState(empty); const [editing, setEditing] = useState<string | null>(null); const [message, setMessage] = useState("");
  const list = useQuery({ queryKey: ["knowledge-terms", wsId], queryFn: () => apiFetch<ComplianceTerm[]>(endpoint(wsId, "terms")) });
  const save = useMutation({ mutationFn: () => {
    if (!canEdit || !form.term.trim()) throw new Error("请填写词条，且需要编辑权限。");
    return apiFetch(endpoint(wsId, "terms" + (editing ? "/" + encodeURIComponent(editing) : "")), { method: editing ? "PUT" : "POST", body: JSON.stringify({ ...form, term: form.term.trim(), replacement: form.replacement || undefined }) });
  }, onSuccess: () => { setForm(empty); setEditing(null); setMessage("词条已保存。"); void list.refetch(); } });
  const remove = useMutation({ mutationFn: (id: string) => {
    if (!canEdit) throw new Error("当前权限只能查看词库。");
    return apiFetch(endpoint(wsId, `terms/${encodeURIComponent(id)}`), { method: "DELETE" });
  }, onSuccess: () => { setMessage("词条已删除。"); void list.refetch(); } });
  return <section className={cardClass} aria-label="禁用词与慎用词">
    <h2 className="font-medium">禁用词与慎用词</h2>
    {canEdit && <form className="grid gap-3" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="flex gap-3"><select aria-label="词条类型" className={fieldClass} value={form.type} onChange={event => setForm({ ...form, type: event.target.value as ComplianceTerm["type"] })}><option value="FORBIDDEN">禁用</option><option value="CAUTION">慎用</option></select><Input aria-label="词条内容" placeholder="词条" value={form.term} required onChange={event => setForm({ ...form, term: event.target.value })} /></div>
      <Input aria-label="词条原因" placeholder="原因" value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} /><Input aria-label="词条替代表达" placeholder="替代表达（可选）" value={form.replacement} onChange={event => setForm({ ...form, replacement: event.target.value })} />
      <div className="flex gap-2"><Button type="submit" disabled={save.isPending || remove.isPending || !form.term.trim()}>{editing ? "保存词条修改" : "添加词条"}</Button>{editing && <Button type="button" variant="outline" onClick={() => { setEditing(null); setForm(empty); }}>取消编辑</Button>}</div>
    </form>}
    <ErrorMessage error={list.error ?? save.error ?? remove.error} />{message && <p role="status" className="text-sm text-primary">{message}</p>}
    {list.isLoading ? <p role="status">正在读取词库…</p> : !list.data?.length ? <p className="text-sm text-muted-foreground">暂无词条。</p> : <ul className="space-y-3">{list.data.map(term => <li key={term.id} className="rounded-xl bg-muted/50 p-4"><div className="flex flex-wrap justify-between gap-3"><div><p className="text-sm font-medium">{term.term} · {term.type === "FORBIDDEN" ? "禁用" : "慎用"}</p><p className="mt-1 text-xs text-muted-foreground">{term.reason}{term.replacement ? ` · 建议：${term.replacement}` : ""}</p></div>{canEdit && <div className="flex gap-2"><Button type="button" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => { setEditing(term.id); setForm({ type: term.type, term: term.term, reason: term.reason, replacement: term.replacement ?? "" }); }}>编辑词条</Button><Button type="button" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => { if (window.confirm(`删除词条「${term.term}」？`)) remove.mutate(term.id); }}>删除词条</Button></div>}</div></li>)}</ul>}
  </section>;
}

function ProhibitionsPanel({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const empty = { description: "", severity: "MEDIUM" as VI.ProhibitionRule["severity"], status: "PENDING" as VI.ProhibitionRule["status"], affectsGeneration: true, affectsValidation: true, scope: "", applicableChannels: "", alternativeSuggestion: "", positiveExampleAssetId: "", negativeExampleAssetId: "" };
  const [form, setForm] = useState(empty); const [editing, setEditing] = useState<string | null>(null); const [message, setMessage] = useState("");
  const list = useQuery({ queryKey: ["knowledge-prohibitions", wsId], queryFn: () => apiFetch<VI.ProhibitionRule[]>(endpoint(wsId, "prohibitions")) });
  const assets = useQuery({ queryKey: ["knowledge-example-assets", wsId], queryFn: () => apiFetch<Asset[]>(endpoint(wsId, "assets?libraryKind=ALL")), enabled: canEdit });
  const save = useMutation({ mutationFn: () => {
    if (!canEdit) throw new Error("当前权限只能查看禁用规范。");
    const body = VI.CreateProhibitionRuleInput.parse({ ...form, description: form.description.trim(), scope: csv(form.scope), applicableChannels: csv(form.applicableChannels), alternativeSuggestion: editing ? form.alternativeSuggestion : form.alternativeSuggestion || undefined,
      positiveExampleAssetId: editing ? form.positiveExampleAssetId : form.positiveExampleAssetId || undefined, negativeExampleAssetId: editing ? form.negativeExampleAssetId : form.negativeExampleAssetId || undefined });
    return apiFetch(endpoint(wsId, "prohibitions" + (editing ? "/" + encodeURIComponent(editing) : "")), { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
  }, onSuccess: () => { setForm(empty); setEditing(null); setMessage("禁用规范已保存。"); void list.refetch(); } });
  const remove = useMutation({ mutationFn: (id: string) => {
    if (!canEdit) throw new Error("当前权限只能查看禁用规范。");
    return apiFetch(endpoint(wsId, `prohibitions/${encodeURIComponent(id)}`), { method: "DELETE" });
  }, onSuccess: () => { setMessage("禁用规范已删除。"); void list.refetch(); } });
  const exampleOptions = (selected: string) => <><option value="">未设置</option>{selected && !assets.data?.some(asset => asset.id === selected) && <option value={selected}>保留当前示例</option>}{assets.data?.map(asset => <option value={asset.id} key={asset.id}>{asset.fileName}</option>)}</>;
  return <section className={cardClass} aria-label="禁用规范">
    <h2 className="font-medium">禁用规范</h2><p className="text-xs text-muted-foreground">用于视觉、结构和场景的边界约束；词语层面的限制在下方词库管理。待确认不会作为已启用规范。</p>
    {canEdit && <form className="space-y-3" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <Textarea aria-label="禁用规范说明" required placeholder="描述禁止或应避免的行为" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} />
      <div className="flex flex-wrap gap-3"><label className="space-x-2 text-sm">级别 <select className={fieldClass} value={form.severity} onChange={event => setForm({ ...form, severity: event.target.value as typeof form.severity })}><option value="HIGH">高</option><option value="MEDIUM">中</option><option value="LOW">低</option></select></label><label className="space-x-2 text-sm">状态 <select className={fieldClass} value={form.status} onChange={event => setForm({ ...form, status: event.target.value as typeof form.status })}><option value="PENDING">待确认</option><option value="ACTIVE">已启用</option><option value="INACTIVE">已停用</option></select></label></div>
      <div className="flex gap-5 text-sm"><label><input type="checkbox" checked={form.affectsGeneration} onChange={event => setForm({ ...form, affectsGeneration: event.target.checked })} /> 用于生成约束</label><label><input type="checkbox" checked={form.affectsValidation} onChange={event => setForm({ ...form, affectsValidation: event.target.checked })} /> 用于合规检查</label></div>
      <Input aria-label="禁用规范适用范围" placeholder="适用范围，逗号分隔（可选）" value={form.scope} onChange={event => setForm({ ...form, scope: event.target.value })} /><Input aria-label="禁用规范适用渠道" placeholder="适用渠道，逗号分隔（可选）" value={form.applicableChannels} onChange={event => setForm({ ...form, applicableChannels: event.target.value })} /><Input aria-label="禁用规范替代建议" placeholder="替代建议（可选）" value={form.alternativeSuggestion} onChange={event => setForm({ ...form, alternativeSuggestion: event.target.value })} />
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">正面示例素材<select className={fieldClass} value={form.positiveExampleAssetId} onChange={event => setForm({ ...form, positiveExampleAssetId: event.target.value })}>{exampleOptions(form.positiveExampleAssetId)}</select></label><label className="grid gap-1 text-sm">反面示例素材<select className={fieldClass} value={form.negativeExampleAssetId} onChange={event => setForm({ ...form, negativeExampleAssetId: event.target.value })}>{exampleOptions(form.negativeExampleAssetId)}</select></label></div>
      <ErrorMessage error={assets.error} /><div className="flex gap-2"><Button type="submit" disabled={save.isPending || remove.isPending || !form.description.trim()}>{editing ? "保存规范修改" : "添加禁用规范"}</Button>{editing && <Button type="button" variant="outline" onClick={() => { setEditing(null); setForm(empty); }}>取消编辑</Button>}</div>
    </form>}
    <ErrorMessage error={list.error ?? save.error ?? remove.error} />{message && <p role="status" className="text-sm text-primary">{message}</p>}
    {list.isLoading ? <p role="status">正在读取禁用规范…</p> : !list.data?.length ? <p className="text-sm text-muted-foreground">暂无禁用规范。</p> : <ul className="space-y-3">{list.data.map(rule => <li key={rule.id} className="rounded-xl bg-muted/50 p-4"><p className="text-sm font-medium">{rule.description}</p><p className="mt-1 text-xs text-muted-foreground">{{ HIGH: "高", MEDIUM: "中", LOW: "低" }[rule.severity]}风险 · {{ ACTIVE: "已启用", INACTIVE: "已停用", PENDING: "待确认" }[rule.status]}{rule.scope.length ? ` · ${rule.scope.join("、")}` : ""}{rule.alternativeSuggestion ? ` · 建议：${rule.alternativeSuggestion}` : ""}</p>{canEdit && <div className="mt-3 flex gap-2"><Button type="button" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => { setEditing(rule.id); setForm({ description: rule.description, severity: rule.severity, status: rule.status, affectsGeneration: rule.affectsGeneration, affectsValidation: rule.affectsValidation, scope: rule.scope.join("，"), applicableChannels: rule.applicableChannels.join("，"), alternativeSuggestion: rule.alternativeSuggestion ?? "", positiveExampleAssetId: rule.positiveExampleAssetId ?? "", negativeExampleAssetId: rule.negativeExampleAssetId ?? "" }); }}>编辑规范</Button><Button type="button" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => { if (window.confirm(`删除规范「${rule.description}」？`)) remove.mutate(rule.id); }}>删除规范</Button></div>}</li>)}</ul>}
  </section>;
}
