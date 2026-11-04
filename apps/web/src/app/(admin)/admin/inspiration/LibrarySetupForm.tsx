"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { InspirationLibraryCreateInput, InspirationLibraryCreateResult } from "@brandai/contracts";
import { Button } from "@brandai/ui";

type Workspace = { id: string; name: string; ownerId: string };
type Props = { libraryId: string | null; activeLibraryId: string | null; enabled: boolean; configured: boolean; initialized: boolean; conflict: boolean; boundOwnerId: string | null; workspaces: Workspace[] };

export function LibrarySetupForm(props: Props) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [initialized, setInitialized] = useState(props.initialized);
  const [message, setMessage] = useState("");
  const submitting = useRef(false);
  const candidates = props.workspaces.filter(ws => !props.boundOwnerId || ws.ownerId === props.boundOwnerId);
  const selected = candidates.find(ws => ws.id === workspaceId);
  const ownerId = selected?.ownerId ?? props.boundOwnerId;
  const covered = props.workspaces.filter(ws => ws.ownerId === ownerId);

  async function initialize() {
    if (submitting.current || uncertain || initialized || props.conflict || !props.libraryId || !selected || !confirmed) return;
    submitting.current = true; setBusy(true); setMessage("");
    try {
      const input = InspirationLibraryCreateInput.parse({ libraryId: props.libraryId, ownerId: selected.ownerId, workspaceId: selected.id });
      const response = await fetch("/api/admin/inspiration/libraries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) {
        if (response.status >= 500) throw new Error("uncertain");
        const data = await response.json().catch(() => ({}));
        setMessage(typeof data.error === "string" ? data.error : "初始化未完成，请刷新页面核对权限和配置。");
        return;
      }
      const result = InspirationLibraryCreateResult.parse(await response.json());
      if (result.sourceLibrary.id !== props.libraryId || result.sourceLibrary.kind !== "SHARED") throw new Error("uncertain");
      setInitialized(true);
      setMessage(result.created ? "共享库已初始化。请继续核对启用与接收状态；当前操作没有导入素材。" : "该共享库已经初始化，本次没有重复创建。请继续核对启用与接收状态。");
    } catch {
      setUncertain(true);
      setMessage("请求结果暂未确认，可能已经完成。请刷新读取后台状态后再操作，系统不会自动重复提交。");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <section className="mt-6 space-y-5 rounded-2xl border border-border bg-card p-5" aria-label="共享灵感库初始化">
    <dl className="space-y-2 text-sm">
      <div><dt className="inline text-muted-foreground">待初始化库标识：</dt><dd className="inline break-all">{props.libraryId || "尚未配置"}</dd></div>
      <div><dt className="inline text-muted-foreground">浏览功能：</dt><dd className="inline">{props.enabled ? "已启用" : "尚未启用"}</dd></div>
      <div><dt className="inline text-muted-foreground">共享接收连接：</dt><dd className="inline">{props.configured ? "已配置，仍需真实接收验证" : "尚未配置"}</dd></div>
      <div><dt className="inline text-muted-foreground">初始化状态：</dt><dd className="inline">{props.conflict ? "库身份不一致，已阻止初始化" : initialized ? "已初始化" : "尚未初始化"}</dd></div>
      <div><dt className="inline text-muted-foreground">此库启用状态：</dt><dd className="inline">{props.libraryId && props.activeLibraryId === props.libraryId ? "已配置为当前共享库" : "尚未作为当前共享库启用"}</dd></div>
    </dl>
    {props.libraryId && props.activeLibraryId !== props.libraryId && <p role="status" className="text-sm">初始化后还需启用：请由部署管理员通过正常部署将此库启用。准备和初始化不会切换用户当前灵感库。</p>}
    {!props.libraryId && <p role="status" className="text-sm">请先由部署管理员配置公司共享库标识，再刷新此页。当前操作不会修改部署配置。</p>}
    {props.conflict && <p role="alert" className="text-sm text-destructive">已有库与永久归属记录不一致，请联系维护人员核对；此处不会覆盖或改绑已有库。</p>}
    {!initialized && !props.conflict && props.libraryId && <>
      <label className="block text-sm">选择公司内的一个品牌
        <select aria-label="选择公司品牌" className="mt-2 block w-full rounded-xl border border-border bg-background p-3" value={workspaceId} disabled={busy || uncertain} onChange={event => { setWorkspaceId(event.target.value); setConfirmed(false); setMessage(""); }}>
          <option value="">请选择并核对公司范围</option>
          {candidates.map(ws => <option key={ws.id} value={ws.id}>{ws.name} · {ws.id}</option>)}
        </select>
      </label>
      {!candidates.length && <p role="status" className="text-sm">没有可用品牌，请先核对公司所有者和品牌状态。</p>}
    </>}
    {ownerId && <div className="text-sm"><p className="font-medium">当前同公司品牌（按品牌所有者归属）</p><ul className="mt-2 list-inside list-disc break-words text-muted-foreground">{covered.map(ws => <li key={ws.id}>{ws.name} · {ws.id}</li>)}</ul><p className="mt-2 text-muted-foreground">此列表用于核对归属，不向任何账号授予新的品牌权限。以后同一所有者下的品牌也按现有权限使用此库。</p></div>}
    {!initialized && !props.conflict && props.libraryId && <>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={!selected || busy || uncertain} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对公司与品牌范围。库标识将永久绑定该公司所有者，不能改绑；本次只初始化共享库，不搬移品牌私有案例。</span></label>
      <Button type="button" disabled={!selected || !confirmed || busy || uncertain} onClick={() => void initialize()}>{busy ? "正在初始化…" : "确认初始化共享库"}</Button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <div className="flex flex-wrap gap-4 text-sm"><button type="button" className="text-primary underline" disabled={busy} onClick={() => window.location.reload()}>刷新后台状态</button><Link href="/studio" className="text-primary underline">返回工作台选择品牌并查看灵感库</Link></div>
  </section>;
}
