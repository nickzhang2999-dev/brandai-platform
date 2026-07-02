"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Generation,
  GenerationVersion,
  ListMembersResponse,
  Project,
  ProjectAssetLink,
  SizeSpec,
  WorkspaceRole,
} from "@brandai/contracts";
import { CHANNEL_SIZES } from "@brandai/contracts";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { planTiers, upgradeContactEmail } from "@/lib/brandai-mock";
import {
  getReferences,
  removeReference,
  subscribeReferences,
  type RefAsset,
} from "@/lib/reference-tray";
import { useBrand } from "../brand-context";
import { MaskPaintCanvas } from "./MaskPaintCanvas";
import { OpenCanvas } from "./OpenCanvas";

/**
 * P05 · AI 工作台 — 左画布 + 变体条，右 prompt 面板。真实出图（CLAUDE.md §2，
 * server-authoritative）：提交 → POST /generations(202, 落 PENDING + 入队) →
 * 客户端轮询 GET /generations/[id]?jobId= → worker→apps/ai→真 provider 出图 →
 * GenerationVersion.imageUrl 浮现。客户端中间态有界，超时给出口。
 */
const SCENE_TYPES: { value: string; label: string }[] = [
  { value: "SOCIAL_POSTER", label: "社交海报" },
  { value: "ECOM_MAIN", label: "电商主图" },
  { value: "SCENE", label: "场景图" },
  { value: "CAMPAIGN_KV", label: "Campaign KV" },
  { value: "SELLING_POINT", label: "卖点图" },
];

// 迁移自 prd_agent 视觉创作 —— 选中图片上方的浮动操作工具条。「局部重画」是特殊项
// （打开蒙版绘制覆盖层 → op=INPAINT + mask），其余项选中后用快捷编辑框补指令即出图。
// 全部走真实 server-authoritative 改图链路（/edit → worker → ai.edit → 真 provider）。
const CANVAS_OPS: { value: string; label: string; mask?: boolean }[] = [
  { value: "INPAINT", label: "局部重画", mask: true },
  { value: "OUTPAINT", label: "扩展" },
  { value: "REPLACE_BACKGROUND", label: "换背景" },
  { value: "RECOLOR", label: "改色" },
  { value: "EDIT_TEXT", label: "改文字" },
  { value: "ADD_ELEMENT", label: "加元素" },
  { value: "REMOVE_ELEMENT", label: "去元素" },
];

const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态

// 版本的“真实像素尺寸”。OpenAI 会把请求画布 snap 到最近的支持档(如 1920×1080 →
// 1536×1024)，generate.worker 把 snap 后的真实字节尺寸落进 params.actualWidth/Height
// (见 generate.worker.ts K5)。局部重画蒙版必须按真实字节尺寸绘制/导出——否则蒙版在
// object-contain 的 <img> 里被拉伸/偏移，_build_inpaint_mask 再 resize 到真实字节时
// 涂抹区错位、provider 改错地方(Codex P2)。缺 actual 时回退请求 width/height。
function versionPixelSize(v: GenerationVersion): {
  width: number;
  height: number;
} {
  const p = (v.params ?? {}) as Record<string, unknown>;
  const aw = typeof p.actualWidth === "number" ? p.actualWidth : null;
  const ah = typeof p.actualHeight === "number" ? p.actualHeight : null;
  return {
    width: aw && ah ? aw : v.width || 1024,
    height: aw && ah ? ah : v.height || 1024,
  };
}

type JobState = {
  generation: Generation;
  job: {
    jobId: string;
    status: string;
    progress: number;
    failedReason?: string;
  };
};

// F11 — read-only quota status (GET /api/workspaces/[wsId]/quota). -1 = 不限.
type QuotaStatus = {
  dailyUsed: number;
  dailyLimit: number;
  periodUsed: number;
  monthlyQuota: number;
  plan: string;
};

// F7 — UI suggestion chips (text content only; not colors).
const SUGGESTED_KEYWORDS = ["简约", "高级感", "科技感", "暖色调", "自然光"];
const MAX_KEYWORDS = 20;

// G1 — parse a template `?style=a,b,c` param into a deduped, capped keyword list.
function parseStyleParam(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const kw = part.trim();
    if (kw && !out.includes(kw) && out.length < MAX_KEYWORDS) out.push(kw);
  }
  return out;
}

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="p-10 text-sm text-muted-foreground">加载中…</div>
      }
    >
      <Workspace />
    </Suspense>
  );
}

function Workspace() {
  const { wsId, brandName } = useBrand();
  const search = useSearchParams();
  const pathname = usePathname();
  const presetProject = search.get("project");
  // E · 深链/刷新恢复 —— ?gen= 指明当前查看的出图。通知中心与队列 widget 都跳到
  // /workspace?gen=<id>&project=<pid>;刷新也带着它,落到精确那张而非空白/最近。
  const presetGen = search.get("gen");
  // B2 · 首页 brief 透传 — 把首页输入的描述作为出图卖点初始值（仅首屏播种，
  // 不在每次渲染时覆盖用户后续编辑）。
  const presetBrief = search.get("brief");
  // G1 · 模板库带入 — 模板把场景 / 画面类型 / 风格关键词经 query 预填（同 brief
  // 透传：仅在 URL 参数变化的真实导航时播种，不覆盖用户后续手动编辑）。
  const presetScene = search.get("scene");
  const presetSceneType = search.get("sceneType");
  const presetStyle = search.get("style");

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const [projectId, setProjectId] = useState<string | null>(presetProject);
  // React to client-side navigations that change `?project=` (E11/E12 「加入项目」
  // and the homepage brief flow router.push to /workspace?project=… without a
  // remount). Without this the prior project stays selected and reference-tray
  // assets + POST /generations would target the wrong project.
  useEffect(() => {
    if (presetProject) setProjectId(presetProject);
  }, [presetProject]);
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const [sellingPoint, setSellingPoint] = useState(
    presetBrief?.trim()
      ? presetBrief.trim().slice(0, 500)
      : "高端、清透、具有自然光感的护肤新品社交广告主视觉，紫色瓶身为主体，搭配花卉与水光质感。",
  );
  // F2 / L6 — undo/redo for the generation-form state. We track a snapshot of
  // every editable field in a bounded history stack and expose undo/redo that
  // restores a whole snapshot. `applyingHistory` suppresses re-recording while
  // a restore is in flight (so undo→redo round-trips cleanly).
  const applyingHistory = useRef(false);
  // Re-seed 卖点 when a NEW brief arrives via client navigation (the URL param
  // changes). This only fires on a real navigation — typing in the textarea
  // doesn't change `presetBrief`, so manual edits are never clobbered.
  useEffect(() => {
    if (presetBrief?.trim()) setSellingPoint(presetBrief.trim().slice(0, 500));
  }, [presetBrief]);
  const [scene, setScene] = useState(presetScene?.trim() || "夏日自然光场景");
  // Only honor a sceneType the workspace actually offers (avoid a dangling value
  // from a hand-edited URL); otherwise fall back to the default.
  const SCENE_TYPE_VALUES = SCENE_TYPES.map((s) => s.value);
  const [sceneType, setSceneType] = useState(
    presetSceneType && SCENE_TYPE_VALUES.includes(presetSceneType)
      ? presetSceneType
      : "SOCIAL_POSTER",
  );
  const [versionCount, setVersionCount] = useState(4);

  // K5 · P2.0 多尺寸 — 选中的渠道尺寸档位（按 CHANNEL_SIZES.key 跟踪）。≥1 个时
  // POST body 带 targets（每尺寸各出 1 张，AI 服务忽略 versionCount）。
  const [targetKeys, setTargetKeys] = useState<string[]>([]);
  const selectedTargets: SizeSpec[] = useMemo(
    () => CHANNEL_SIZES.filter((s) => targetKeys.includes(s.key)),
    [targetKeys],
  );
  const multiSize = selectedTargets.length > 0;
  function toggleTarget(key: string) {
    setTargetKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // K5 · M3 文本策略 — direct（默认，模型可烤字）/ layered（留干净负空间、不烤字）。
  const [textMode, setTextMode] = useState<"direct" | "layered">("direct");

  // F7 · 风格关键词 (max 20) — threaded into POST /generations as styleKeywords.
  // G1 — seed from a template's `?style=a,b,c` on first render (deduped, capped).
  const [styleKeywords, setStyleKeywords] = useState<string[]>(() =>
    parseStyleParam(presetStyle),
  );
  const [keywordDraft, setKeywordDraft] = useState("");

  function addKeyword(raw: string) {
    const kw = raw.trim();
    if (!kw) return;
    setStyleKeywords((prev) =>
      prev.includes(kw) || prev.length >= MAX_KEYWORDS ? prev : [...prev, kw],
    );
  }
  function removeKeyword(kw: string) {
    setStyleKeywords((prev) => prev.filter((k) => k !== kw));
  }
  function onKeywordKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(keywordDraft);
      setKeywordDraft("");
    } else if (e.key === "Backspace" && !keywordDraft && styleKeywords.length) {
      removeKeyword(styleKeywords[styleKeywords.length - 1]!);
    }
  }

  // G1 — re-seed scene / sceneType / styleKeywords on a fresh template navigation
  // (the URL params change). Only fires on a real navigation, so manual edits are
  // never clobbered (typing in the fields doesn't change these params).
  useEffect(() => {
    if (presetScene?.trim()) setScene(presetScene.trim());
  }, [presetScene]);
  useEffect(() => {
    if (presetSceneType && SCENE_TYPE_VALUES.includes(presetSceneType))
      setSceneType(presetSceneType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSceneType]);
  useEffect(() => {
    const kws = parseStyleParam(presetStyle);
    if (kws.length) setStyleKeywords(kws);
  }, [presetStyle]);

  // F2 / L6 — bounded undo/redo history over the generation-form snapshot.
  // The current snapshot is recomputed from the live field state; an effect
  // pushes it onto the past stack (debounced via a shallow-equality check) so
  // typing coalesces into discrete steps. Undo/redo restore a whole snapshot.
  type FormSnapshot = {
    sellingPoint: string;
    scene: string;
    sceneType: string;
    versionCount: number;
    targetKeys: string[];
    textMode: "direct" | "layered";
    styleKeywords: string[];
  };
  const snapshot: FormSnapshot = useMemo(
    () => ({
      sellingPoint,
      scene,
      sceneType,
      versionCount,
      targetKeys,
      textMode,
      styleKeywords,
    }),
    [
      sellingPoint,
      scene,
      sceneType,
      versionCount,
      targetKeys,
      textMode,
      styleKeywords,
    ],
  );
  const HISTORY_CAP = 50;
  const past = useRef<FormSnapshot[]>([]);
  const future = useRef<FormSnapshot[]>([]);
  const lastSnap = useRef<FormSnapshot>(snapshot);
  const [histVersion, setHistVersion] = useState(0); // re-render on stack change

  function snapEqual(a: FormSnapshot, b: FormSnapshot): boolean {
    return (
      a.sellingPoint === b.sellingPoint &&
      a.scene === b.scene &&
      a.sceneType === b.sceneType &&
      a.versionCount === b.versionCount &&
      a.textMode === b.textMode &&
      a.targetKeys.length === b.targetKeys.length &&
      a.targetKeys.every((k, i) => k === b.targetKeys[i]) &&
      a.styleKeywords.length === b.styleKeywords.length &&
      a.styleKeywords.every((k, i) => k === b.styleKeywords[i])
    );
  }

  function restoreSnapshot(s: FormSnapshot) {
    applyingHistory.current = true;
    setSellingPoint(s.sellingPoint);
    setScene(s.scene);
    setSceneType(s.sceneType);
    setVersionCount(s.versionCount);
    setTargetKeys(s.targetKeys);
    setTextMode(s.textMode);
    setStyleKeywords(s.styleKeywords);
    lastSnap.current = s;
    // Clear the suppression flag after the state updates flush.
    setTimeout(() => {
      applyingHistory.current = false;
    }, 0);
  }

  // Record a new history step whenever the snapshot changes by a real edit.
  useEffect(() => {
    if (applyingHistory.current) return;
    if (snapEqual(snapshot, lastSnap.current)) return;
    past.current.push(lastSnap.current);
    if (past.current.length > HISTORY_CAP) past.current.shift();
    future.current = []; // a fresh edit invalidates the redo branch
    lastSnap.current = snapshot;
    setHistVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  function undo() {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(lastSnap.current);
    setHistVersion((v) => v + 1);
    restoreSnapshot(prev);
  }
  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(lastSnap.current);
    setHistVersion((v) => v + 1);
    restoreSnapshot(next);
  }
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  // Reference histVersion so the toolbar re-renders when stacks change.
  void histVersion;

  // F9 · 参考素材区 — localStorage-backed, scoped to (wsId, projectId), shared
  // with the assets page via reference-tray. Subscribe for cross-page updates.
  const [references, setReferences] = useState<RefAsset[]>([]);
  useEffect(() => {
    if (!projectId) {
      setReferences([]);
      return;
    }
    let cancelled = false;
    // E11/E12 — merge the durable server-side REFERENCE links (source of truth,
    // survives across devices) with the local tray (instant same-tab feedback),
    // de-duped by asset id. A server miss degrades gracefully to tray-only.
    const refresh = () => {
      const tray = getReferences(wsId, projectId);
      setReferences(tray);
      apiFetch<ProjectAssetLink[]>(
        `/api/workspaces/${wsId}/projects/${projectId}/assets?kind=REFERENCE`,
      )
        .then((links) => {
          if (cancelled) return;
          const seen = new Set(tray.map((r) => r.id));
          const fromServer: RefAsset[] = links
            .filter((l) => !seen.has(l.asset.id))
            .map((l) => ({
              id: l.asset.id,
              fileName: l.asset.fileName,
              thumbUrl: assetThumbUrl(wsId, l.asset.id, l.asset.url),
            }));
          if (fromServer.length > 0) {
            setReferences((prev) => [...prev, ...fromServer]);
          }
        })
        .catch(() => {
          /* tray-only fallback */
        });
    };
    refresh();
    const unsub = subscribeReferences(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [wsId, projectId]);
  function dropReference(assetId: string) {
    if (!projectId) return;
    removeReference(wsId, projectId, assetId);
    setReferences((prev) => prev.filter((r) => r.id !== assetId));
    // E11/E12 — also drop the durable server link (best-effort).
    apiFetch(`/api/workspaces/${wsId}/projects/${projectId}/assets`, {
      method: "DELETE",
      body: JSON.stringify({ assetId, kind: "REFERENCE" }),
    }).catch(() => {});
  }

  // F11 · 生成额度展示 — read-only quota status.
  const { data: quota } = useQuery<QuotaStatus>({
    queryKey: ["brandai-quota", wsId],
    queryFn: () => apiFetch<QuotaStatus>(`/api/workspaces/${wsId}/quota`),
    enabled: !!wsId,
  });

  // 历史出图回看 — 进入工作台默认能看到本 Campaign 已生成的图，而不是空态。
  // 接现成的 GET /generations?projectId=（listProjectGenerations，newest first）。
  // 修复「产出蒸发」：刷新/切项目/换设备后历史出图不再消失。
  const { data: history = [] } = useQuery<Generation[]>({
    queryKey: ["brandai-project-gens", wsId, projectId],
    queryFn: () =>
      apiFetch<Generation[]>(
        `/api/workspaces/${wsId}/generations?projectId=${projectId}`,
      ),
    enabled: !!wsId && !!projectId,
  });

  // H9 · 提交制作确认弹窗 — 提交前先汇总将要生成的内容（场景/卖点/数量/尺寸/风格）
  // + 额度提示，确认后再走真实 POST /generations 出图流。
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // H12 · 额度升级弹窗（信息性，无真实计费）。
  const [showUpgrade, setShowUpgrade] = useState(false);

  const [genId, setGenId] = useState<string | null>(presetGen);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const startedAt = useRef<number>(0);
  const [timedOut, setTimedOut] = useState(false);
  // 改图(edit)中间态计时 —— §2.4 有界:改图轮询超过上界给明确出口,绝不无限「改图中…」。
  const editStartedAt = useRef<number>(0);
  // 改图客户端超时后,worker 可能仍在后台完成 —— 记一个有界的「继续观察到」时刻,让
  // 主 generation 查询在此期间即便已 SUCCEEDED 也慢速续轮询,迟到的改图子版本才能
  // 自动浮现,不必整页刷新(Bugbot Medium)。
  const [editWatchUntil, setEditWatchUntil] = useState(0);

  const { data: poll } = useQuery<JobState>({
    queryKey: ["brandai-gen", wsId, genId, jobId],
    queryFn: () =>
      apiFetch<JobState>(
        // jobId 仅在「本次会话刚提交」时存在；回看历史出图（无 job）时省略，
        // 路由会回退到 generation.status（SUCCEEDED），不再拼出 ?jobId=null。
        `/api/workspaces/${wsId}/generations/${genId}${jobId ? `?jobId=${jobId}` : ""}`,
      ),
    enabled: !!genId,
    refetchInterval: (q) => {
      const d = q.state.data;
      const s = d?.job?.status ?? d?.generation.status;
      if (s === "SUCCEEDED" || s === "FAILED") {
        // 改图超时后的有界续观察:generation 虽已终态,仍慢速轮询以捞回迟到的改图子版本。
        return editWatchUntil > Date.now() ? 8000 : false;
      }
      // §2.4 6-min 上界。实时出图(有 jobId)用本地 startedAt;回看历史出图
      // (jobId=null → startedAt=0)改用该 generation 的服务端起始时间
      // (startedAt→createdAt),否则 0 会让仍在跑的历史出图被瞬间判超时而停轮询,
      // 卡死在"生成中"直到整页刷新(Bugbot #3d80902a)。无可解析时间则继续轮询。
      const startMs =
        startedAt.current > 0
          ? startedAt.current
          : Date.parse(
              d?.generation.startedAt ?? d?.generation.createdAt ?? "",
            ) || 0;
      if (startMs > 0 && Date.now() - startMs > POLL_CAP_MS) return false;
      return 2500;
    },
  });

  // 中间态超时只在「本会话实时出图」（有 jobId）时计时；回看历史出图（jobId=null）
  // 不参与计时，否则 startedAt=0 会被瞬间判超时。
  useEffect(() => {
    if (!genId || !jobId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [genId, jobId]);

  // 切换 Campaign 时清掉当前查看的出图，交给下面的「默认展示最近一次」按新项目
  // 重新播种（否则上一个项目的图会残留、且 POST/改图会打到错项目）。
  const prevProjectRef = useRef<string | null>(projectId);
  useEffect(() => {
    if (prevProjectRef.current === projectId) return;
    prevProjectRef.current = projectId;
    // 切项目默认清空当前出图,交给 seed-latest 重新播种。例外:若这次切项目来自
    // URL 深链(presetProject 已等于新 projectId)且带了 ?gen=,尊重深链那张
    // (通知/队列点到的是「另一个 Campaign 的某次出图」时,别被清成最近一次)。
    const deep =
      presetProject === projectId && presetGen ? presetGen : null;
    setGenId(deep);
    setJobId(null);
    setTimedOut(false);
    setActiveVariant(0);
  }, [projectId, presetProject, presetGen]);

  // E · 客户端导航到 ?gen=(已在工作台时点通知/队列) → 切到那次出图。整页加载走
  // genId 初始值;这里只接 URL 变化(soft nav)。
  useEffect(() => {
    if (presetGen && presetGen !== genId) {
      setGenId(presetGen);
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetGen]);

  // E · 反向同步:把当前 Campaign 写回 URL(?project=),让刷新/分享落到同一项目。
  // 用 ref 只在 projectId「真的变了」时写——手动切 <select>、默认选 projects[0]、
  // 「加入项目」程序化导航都覆盖(Codex: 默认/侧边栏/模板入口选中的项目也必须进
  // URL,否则出图成功后 ?gen= 反向同步会产出缺 project 的分享链,刷新/分享时把这
  // 次出图绑到当前最新的 campaign,project 作用域的历史/引用/导出全落错项目)。
  // 深链导航改 ?project= 时本 effect 因 search 变化触发,但此刻 projectId 尚未被
  // 上面的同步 effect 更新(ref===projectId)→直接跳过,不会用旧 projectId 把深链
  // 改回去(Bugbot: stale project in deep link)。
  const lastUrlProjectRef = useRef<string | null>(projectId);
  useEffect(() => {
    if (lastUrlProjectRef.current === projectId) return;
    const prev = lastUrlProjectRef.current;
    lastUrlProjectRef.current = projectId;
    if (!projectId) return;
    // 关键:从「实时地址栏」(window.location.search)读当前 query,而非 useSearchParams()。
    // 用 history.replaceState 做浅层 URL 同步(避免 router.replace 的 RSC 软导航环/抖动),
    // 但 Next 的 useSearchParams() 在 replaceState 后【不会】刷新——若仍从它读旧值,gen
    // 同步会把过时的 ?project= 又写回去,刷新/分享打开错误 Campaign(Bugbot High)。
    // window.location.search 始终反映上一次 replaceState 的真实结果,读它才不串味。
    const cur = new URLSearchParams(window.location.search);
    if (cur.get("project") === projectId) return;
    cur.set("project", projectId);
    // 只有「从一个已同步项目切到另一个」才抹旧 ?gen=(交给下面 gen 反向同步按新项目
    // 重写);首次播种(prev=null,如默认选 projects[0])不抹,避免清掉仅带 ?gen= 的深链。
    if (prev) cur.delete("gen");
    window.history.replaceState(null, "", `${pathname}?${cur.toString()}`);
  }, [projectId, pathname]);

  // E · 反向同步:把当前查看的出图写回 URL(?gen=),让刷新/分享落到精确那张。
  // 实时出图/改图进行中(jobId 仅会话内存在)不写,避免把一次性 job 深链出去。
  useEffect(() => {
    if (jobId) return;
    if (!genId) return;
    // 同上:读实时地址栏(而非 useSearchParams,后者在 replaceState 后不刷新),这样
    // 上面 project 同步刚写入的 ?project= 会被带上,不会用旧 project 覆盖(Bugbot High)。
    const cur = new URLSearchParams(window.location.search);
    if (cur.get("gen") === genId) return;
    cur.set("gen", genId);
    window.history.replaceState(null, "", `${pathname}?${cur.toString()}`);
  }, [genId, jobId, pathname]);

  // E · 浏览器前进/后退(popstate)→ 让 in-app 状态跟随地址栏。上面用 replaceState 做
  // 浅层 URL 同步,这些 URL 变更 Next 的路由/useSearchParams 并不知情;用户 back/forward
  // 到这些历史项时,地址栏是一套值、genId/projectId 仍停在上一次 in-app 选择 → 画布/变体/
  // 分享链三者不一致(Bugbot Medium)。这里监听 popstate,直接从实时地址栏重解析并应用,
  // 同步 prevProjectRef/lastUrlProjectRef 避免「切项目重置 genId」「project 反向同步」两个
  // effect 回头覆盖。
  useEffect(() => {
    const onPop = () => {
      const q = new URLSearchParams(window.location.search);
      const p = q.get("project");
      const g = q.get("gen");
      if (p) {
        lastUrlProjectRef.current = p; // 别让 project 反向同步 effect 再写
        prevProjectRef.current = p; // 别让「切项目重置 genId」effect 清掉下面的 gen
        setProjectId(p);
      }
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
      setGenId(g || null); // g 为空则回落到「展示最近一次」
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 进入工作台默认展示该项目最近一次出图（history newest-first）。仅当本会话
  // 还没有选中/提交任何出图时播种 —— 不覆盖用户的实时提交，也不覆盖手动切换的历史。
  useEffect(() => {
    if (genId) return;
    if (history.length > 0) {
      setGenId(history[0]!.id);
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
    }
  }, [history, genId]);

  // 点击历史缩略图回看某次出图：复用整套机制（轮询无 jobId → 回退 SUCCEEDED，
  // 改图/终选/导出/审阅全部对该历史出图生效）。
  function viewGeneration(id: string) {
    if (id === genId) return;
    setGenId(id);
    setJobId(null);
    setTimedOut(false);
    setActiveVariant(0);
    setSubmitErr(null);
  }

  const status = poll?.job?.status ?? poll?.generation.status ?? null;
  const versions = useMemo(() => poll?.generation.versions ?? [], [poll]);
  const running =
    !!genId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;
  const current = versions[activeVariant] ?? versions[0];

  // —— 修改优化(改图)/ 终选 / 交付归档 ——
  const qc = useQueryClient();
  // 局部重画的目标版本(画布选中的那张出图变体);蒙版覆盖层对它出图。
  const [maskTarget, setMaskTarget] = useState<GenerationVersion | null>(null);
  const [editInstr, setEditInstr] = useState("");
  const [editVid, setEditVid] = useState<string | null>(null);
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "edit" | "final" | "export">(null);
  // 局部重画 —— 蒙版绘制覆盖层开关（迁移自 prd_agent 视觉创作）。
  const [maskOpen, setMaskOpen] = useState(false);

  // 改图 server-authoritative:POST→202→轮询 edit job→成功后刷新主 generation,
  // 新的子版本(parentVersionId)就会出现在变体条里。
  const { data: editPoll } = useQuery<{ job?: { status: string } }>({
    queryKey: ["brandai-edit", wsId, genId, editVid, editJobId],
    queryFn: () =>
      apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${editVid}/edit?jobId=${editJobId}`,
      ),
    enabled: !!editJobId && !!editVid && !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      // §2.4 6-min 上界:改图卡死就停轮询(下面的计时器给出口),不无限转「改图中…」。
      if (
        editStartedAt.current > 0 &&
        Date.now() - editStartedAt.current > POLL_CAP_MS
      )
        return false;
      return 2500;
    },
  });
  // §2.4 改图中间态超时出口:超界则清掉 job(busy 解锁)+ 给可读出口,不卡死工具条。
  useEffect(() => {
    if (!editJobId) return;
    const t = setInterval(() => {
      if (
        editStartedAt.current > 0 &&
        Date.now() - editStartedAt.current > POLL_CAP_MS
      ) {
        setEditJobId(null);
        setEditVid(null);
        setMaskOpen(false);
        setActionErr("改图超时:可能仍在后台,请稍后在变体条查看或重试。");
        // 立即捞一次(可能刚好在超时边界完成)+ 开启有界续观察,让迟到子版本自动浮现。
        qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
        setEditWatchUntil(Date.now() + POLL_CAP_MS);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [editJobId, qc, wsId, genId]);
  useEffect(() => {
    const s = editPoll?.job?.status;
    if (s === "SUCCEEDED") {
      setEditJobId(null);
      setEditVid(null);
      setEditInstr("");
      setMaskOpen(false); // 局部重画成功 → 关闭蒙版覆盖层，新子版本浮现在变体条
      setEditWatchUntil(0); // 正常完成 → 关掉续观察
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } else if (s === "FAILED") {
      setEditJobId(null);
      setMaskOpen(false);
      setActionErr("改图失败,请重试");
    }
  }, [editPoll, qc, wsId, genId]);
  // 切换查看的出图 → 关掉上一张的续观察,避免跨 generation 无谓慢轮询。
  useEffect(() => {
    setEditWatchUntil(0);
  }, [genId]);
  // F11 — refresh the quota bar once a generation completes so the displayed
  // 本周期/今日 用量 matches server-side enforcement without a manual reload.
  const quotaInvalidatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      status === "SUCCEEDED" &&
      genId &&
      quotaInvalidatedRef.current !== genId
    ) {
      quotaInvalidatedRef.current = genId;
      qc.invalidateQueries({ queryKey: ["brandai-quota", wsId] });
      // 让刚出图的这次进入历史缩略条（回看列表 newest-first）。
      qc.invalidateQueries({
        queryKey: ["brandai-project-gens", wsId, projectId],
      });
    }
  }, [status, genId, wsId, projectId, qc]);
  // E · 实时出图到达 SUCCEEDED 后清掉 jobId,让上面的 ?gen= 反向同步把这次出图写回
  // URL(刷新/分享落到刚生成的这张)。否则 submit() 设的 jobId 整个会话不清,
  // 反向同步的 `if (jobId) return` 永远挡住,新出的图分享不出去(Bugbot)。
  // 只在 SUCCEEDED 清:FAILED 仍需保留 jobId,否则轮询会丢掉 ?jobId= 携带的
  // failedReason。改图流同样在终态清 editJobId,此处对齐。
  useEffect(() => {
    if (jobId && status === "SUCCEEDED") setJobId(null);
  }, [status, jobId]);

  // G6 · 审阅 / 批准流 — 拿调用者在本空间的角色，决定显示哪些审核动作。
  // EDITOR/OWNER 可「提交审阅」；REVIEWER/OWNER 可「批准 / 驳回」。
  const { data: membersData } = useQuery<ListMembersResponse>({
    queryKey: ["brandai-members", wsId],
    queryFn: () =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`),
    enabled: !!wsId,
  });
  const myRole: WorkspaceRole | null = membersData?.myRole ?? null;
  const canSubmitReview = myRole === "OWNER" || myRole === "EDITOR";
  const canDecideReview = myRole === "OWNER" || myRole === "REVIEWER";

  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  // 驳回时附理由（可选）。
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  async function submitForReview() {
    if (!current || !genId) return;
    setReviewErr(null);
    setReviewBusy(true);
    try {
      await apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${current.id}/submit`,
        { method: "POST" },
      );
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : "提交审阅失败");
    } finally {
      setReviewBusy(false);
    }
  }

  async function decideReview(
    decision: "APPROVED" | "REJECTED",
    note?: string,
  ) {
    if (!current || !genId) return;
    setReviewErr(null);
    setReviewBusy(true);
    try {
      await apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${current.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            ...(note?.trim() ? { note: note.trim() } : {}),
          }),
        },
      );
      setRejectOpen(false);
      setRejectNote("");
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : "审批失败");
    } finally {
      setReviewBusy(false);
    }
  }

  // 统一的改图提交入口：换背景/改色/局部重画(INPAINT+mask)/扩展(OUTPAINT) 全走这里
  // → POST /edit(202) → 轮询 edit job → 成功后新子版本(parentVersionId)浮现在变体条。
  // 统一改图入口:换背景/改色/局部重画(INPAINT+mask)/扩展(OUTPAINT) 全走这里 →
  // POST /edit(202) → 轮询 edit job → 成功后新子版本随 versions 浮现到画布。
  async function runEdit(
    op: string,
    payload: Record<string, unknown>,
    target?: GenerationVersion,
  ) {
    const v = target ?? current;
    if (!v || !genId) return;
    setActionErr(null);
    setBusy("edit");
    try {
      // 带上源版本“真实像素尺寸” —— 否则 AI /v1/edit 缺 width/height 会默认 1024²,非方图
      // (小红书封面/Banner)会被改成方图却按原比例存/导出,子版本尺寸对不上(Codex P2)。
      // 且必须用 params.actualWidth/Height(OpenAI snap 后的真实字节尺寸)而非请求 width/
      // height,否则局部重画蒙版按请求尺寸导出、_build_inpaint_mask 再 resize 到真实字节
      // 会错位(Codex P2)。payload 显式给的尺寸优先(目前没有,留作扩展)。
      const px = versionPixelSize(v);
      const sized: Record<string, unknown> = {
        width: px.width,
        height: px.height,
        ...payload,
      };
      const r = await apiFetch<{ jobId: string }>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${v.id}/edit`,
        { method: "POST", body: JSON.stringify({ op, payload: sized }) },
      );
      editStartedAt.current = Date.now();
      setEditVid(v.id);
      setEditJobId(r.jobId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "改图提交失败");
    } finally {
      setBusy(null);
    }
  }

  // 局部重画浮动入口:对画布选中的出图变体打开蒙版绘制覆盖层。
  function openMaskPaint(target?: GenerationVersion) {
    const v = target ?? current;
    if (!v?.imageUrl) return;
    setActionErr(null);
    setMaskTarget(v);
    setMaskOpen(true);
  }

  // 蒙版确认 → op=INPAINT + payload.mask(涂抹蒙版 data-URI) + prompt(指令)。
  function confirmMaskEdit(maskDataUri: string, instruction: string) {
    void runEdit(
      "INPAINT",
      { prompt: instruction, mask: maskDataUri },
      maskTarget ?? current,
    );
  }

  // 画布单选某出图变体 → 同步 activeVariant(右下终选/导出/审阅对它生效)。
  const onCanvasSelectVersion = useCallback(
    (versionId: string | null) => {
      if (!versionId) return;
      setActiveVariant((prev) => {
        const idx = versions.findIndex((x) => x.id === versionId);
        return idx >= 0 ? idx : prev;
      });
    },
    [versions],
  );

  // 上传图片到画布:走真实素材上传(R2)→ 公网 URL + 真实尺寸(从 resolution 串解析)。
  const onCanvasUploadImage = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "OTHER");
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error("上传失败");
      const a = (await res.json()) as { url: string; resolution?: string };
      let width: number | undefined;
      let height: number | undefined;
      const m = a.resolution?.match(/(\d+)\D+(\d+)/);
      if (m) {
        width = Number(m[1]);
        height = Number(m[2]);
      }
      return { url: a.url, width, height };
    },
    [wsId],
  );

  async function markFinal() {
    if (!current || !genId) return;
    setActionErr(null);
    setBusy("final");
    try {
      await apiFetch(`/api/workspaces/${wsId}/generations/${genId}`, {
        method: "PATCH",
        body: JSON.stringify({ versionId: current.id }),
      });
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "设为终稿失败");
    } finally {
      setBusy(null);
    }
  }

  async function exportKit() {
    if (!projectId) return;
    const finals = versions.filter((v) => v.isFinal).map((v) => v.id);
    const ids = finals.length > 0 ? finals : current ? [current.id] : [];
    if (ids.length === 0) return;
    setActionErr(null);
    setBusy("export");
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/projects/${projectId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ versionIds: ids }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "导出失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "brandai-delivery.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!projectId) {
      setSubmitErr("请先选择一个项目（没有就去项目页创建）");
      return;
    }
    setSubmitErr(null);
    setSubmitting(true);
    setTimedOut(false);
    setActiveVariant(0);
    try {
      const res = await apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/generations`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            sceneType,
            sellingPoint: sellingPoint.trim(),
            scene: scene.trim(),
            versionCount,
            // K5 / M3 — text rendering strategy ("direct" default | "layered").
            textMode,
            // K5 / P2.0 — only send `targets` when ≥1 size selected (frozen-
            // additive). When present the AI service fans out one image per size
            // and ignores versionCount.
            ...(selectedTargets.length ? { targets: selectedTargets } : {}),
            // F7 — only send when non-empty (frozen-additive optional field).
            ...(styleKeywords.length ? { styleKeywords } : {}),
            // F9 — current project's staged reference asset ids.
            ...(references.length
              ? { referenceAssetIds: references.map((r) => r.id) }
              : {}),
          }),
        },
      );
      startedAt.current = Date.now();
      setGenId(res.generation.id);
      setJobId(res.jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "提交失败";
      setSubmitErr(msg);
      // H12 — a quota 402 surfaces the upgrade dialog so the user has an exit.
      if (/配额|额度|上限|升级/.test(msg)) setShowUpgrade(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        {/* F1 · 顶部项目路径 breadcrumb — 品牌 / 项目名（可切换 + 回项目列表）/ 工作台 */}
        <nav
          aria-label="项目路径"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Link
            href="/campaigns"
            className="font-medium text-foreground transition-colors hover:text-primary"
            title="返回项目列表"
          >
            {brandName}
          </Link>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <span className="inline-flex items-center gap-1">
            <select
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value || null)}
              aria-label="当前项目"
              className="max-w-[16rem] rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground outline-none focus:border-primary/40"
            >
              {projects.length === 0 ? (
                <option value="">无项目，请先去项目页创建</option>
              ) : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Link
              href="/campaigns"
              aria-label="返回项目列表"
              title="返回项目列表"
              className="text-xs text-muted-foreground transition-colors hover:text-primary"
            >
              ↩
            </Link>
          </span>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <span className="font-medium text-foreground">工作台</span>
        </nav>
        <div className="flex items-center gap-3">
          {/* F2 / L6 — undo/redo (生成表单快照)。缩放在画布内自带。 */}
          <Toolbar
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />
          <StatusPill status={status} timedOut={timedOut} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
        {/* Canvas */}
        <div className="flex min-h-0 flex-col bg-background p-4">
          <OpenCanvas
            seedVersions={versions}
            running={running}
            status={status}
            timedOut={timedOut}
            error={
              poll?.job?.failedReason ?? poll?.generation.error ?? undefined
            }
            onSelectVersion={onCanvasSelectVersion}
            activeVersionId={current?.id ?? null}
            onUploadImage={onCanvasUploadImage}
            edit={{
              ops: CANVAS_OPS,
              busy: !!editJobId || busy === "edit",
              instr: editInstr,
              onInstrChange: setEditInstr,
              onRun: (version, op) =>
                void runEdit(op, { prompt: editInstr.trim() }, version),
              onOpenMask: (version) => openMaskPaint(version),
            }}
          />
          {versions.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-3">
              {versions.map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setActiveVariant(i)}
                  className={[
                    "relative h-[82px] w-[118px] overflow-hidden rounded-[18px] border-2 transition-colors",
                    i === activeVariant
                      ? "border-primary"
                      : "border-transparent hover:border-border",
                  ].join(" ")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={v.imageUrl}
                    alt={`变体 ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  {v.isFinal ? (
                    <span className="absolute left-1 top-1 rounded-full bg-success px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                      终稿
                    </span>
                  ) : null}
                  {v.parentVersionId ? (
                    <span className="absolute right-1 top-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      改
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {/* 历史出图回看 —— 本 Campaign 已生成的每一次出图，newest-first。点击即在
              上方画布回看（复用改图/终选/导出/审阅）。修复「产出蒸发」：刷新/切项目
              后历史不再消失。 */}
          {history.length > 0 ? (
            <div className="mt-5 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground">
                  历史出图
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {history.length} 次
                </span>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {history.map((g) => {
                  const cover = g.versions?.find((v) => v.imageUrl)?.imageUrl;
                  const active = g.id === genId;
                  const finalCount = (g.versions ?? []).filter(
                    (v) => v.isFinal,
                  ).length;
                  return (
                    <button
                      key={g.id}
                      onClick={() => viewGeneration(g.id)}
                      title={`${g.scene || g.sceneType} · ${new Date(
                        g.createdAt,
                      ).toLocaleString("zh-CN")}`}
                      className={[
                        "group relative flex h-[88px] w-[116px] shrink-0 flex-col overflow-hidden rounded-[16px] border-2 text-left transition-colors",
                        active
                          ? "border-primary"
                          : "border-transparent hover:border-border",
                      ].join(" ")}
                    >
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cover}
                          alt={g.scene || "历史出图"}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-muted text-[10px] text-muted-foreground">
                          {g.status === "FAILED"
                            ? "失败"
                            : g.status === "PENDING" || g.status === "RUNNING"
                              ? "生成中…"
                              : "无图"}
                        </div>
                      )}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-foreground/70 to-transparent px-1.5 pb-1 pt-3 text-[10px] font-medium text-white">
                        {g.scene || g.sceneType}
                      </span>
                      {(g.versions?.length ?? 0) > 1 ? (
                        <span className="absolute right-1 top-1 rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                          ×{g.versions!.length}
                        </span>
                      ) : null}
                      {finalCount > 0 ? (
                        <span className="absolute left-1 top-1 rounded-full bg-success px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                          终稿
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 修改优化 / 终选 / 交付归档 —— 仅在已出图后对选中变体可用 */}
          {status === "SUCCEEDED" && current ? (
            <div className="mt-4 rounded-2xl border border-border bg-card p-4">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">
                选中图片 · 终选与交付
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                改图操作(局部重画/换背景/扩展…)在画布上选中图片后从其上方工具条触发。
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  onClick={markFinal}
                  disabled={busy === "final" || current.isFinal}
                  className="rounded-full border border-success/40 px-3 py-1.5 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
                >
                  {current.isFinal ? "✓ 已是终稿" : "设为终稿"}
                </button>
                <button
                  onClick={exportKit}
                  disabled={busy === "export"}
                  className="rounded-full border border-primary/40 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-accent-soft disabled:opacity-60"
                >
                  {busy === "export"
                    ? "打包中…"
                    : versions.some((v) => v.isFinal)
                      ? "导出交付包(终稿)"
                      : "导出交付包(当前图)"}
                </button>
              </div>
              {actionErr ? (
                <p className="mt-2 text-xs text-destructive">{actionErr}</p>
              ) : null}

              {/* G6 · 审阅 / 批准流 — 选中变体的审核状态 + 角色门控的动作。 */}
              <ReviewPanel
                version={current}
                myRole={myRole}
                canSubmit={canSubmitReview}
                canDecide={canDecideReview}
                busy={reviewBusy}
                error={reviewErr}
                onSubmit={submitForReview}
                onApprove={() => decideReview("APPROVED")}
                onOpenReject={() => {
                  setReviewErr(null);
                  setRejectNote("");
                  setRejectOpen(true);
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Prompt panel */}
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-border bg-card p-6">
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>需求描述 / 卖点</span>
              <span className="text-xs font-normal text-muted-foreground">
                {sellingPoint.length}/500
              </span>
            </div>
            <textarea
              value={sellingPoint}
              maxLength={500}
              onChange={(e) => setSellingPoint(e.target.value)}
              rows={5}
              className="w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">场景</div>
            <input
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">画面类型</div>
            <div className="flex flex-wrap gap-1.5">
              {SCENE_TYPES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSceneType(s.value)}
                  className={[
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    sceneType === s.value
                      ? "bg-accent-soft font-medium text-primary"
                      : "border border-border text-muted-foreground hover:bg-muted",
                  ].join(" ")}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* 生成数量 — 多尺寸模式下隐藏（每尺寸各出 1 张，AI 服务忽略 versionCount）。 */}
          {multiSize ? (
            <div>
              <div className="mb-2 text-sm font-semibold">生成数量</div>
              <p className="rounded-2xl border border-primary/15 bg-accent-soft/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                多尺寸模式：每个尺寸各出 1 张（共 {selectedTargets.length}{" "}
                张）。
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-2 text-sm font-semibold">生成数量</div>
              <div className="flex gap-1.5">
                {[1, 2, 4, 6].map((n) => (
                  <button
                    key={n}
                    onClick={() => setVersionCount(n)}
                    className={[
                      "h-9 w-12 rounded-xl text-sm transition-colors",
                      versionCount === n
                        ? "bg-accent-soft font-medium text-primary"
                        : "border border-border text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* K5 · 多尺寸渠道档位（P2.0） */}
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>多尺寸渠道</span>
              {targetKeys.length ? (
                <span className="text-xs font-normal text-muted-foreground">
                  已选 {targetKeys.length}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_SIZES.map((s) => {
                const on = targetKeys.includes(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggleTarget(s.key)}
                    aria-pressed={on}
                    className={[
                      "rounded-full px-3 py-1 text-xs transition-colors",
                      on
                        ? "bg-accent-soft font-medium text-primary"
                        : "border border-border text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    {s.label} {s.width}×{s.height}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              不选则按上方生成数量出同尺寸图；选 ≥1 个渠道则每个尺寸各出 1 张。
            </p>
            {multiSize ? (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                注：模型会就近匹配到支持的比例（如 1080×1440 →
                1024×1536），出图后以实际尺寸为准。
              </p>
            ) : null}
          </div>

          {/* K5 · 文本策略（M3 textMode） */}
          <div>
            <div className="mb-2 text-sm font-semibold">文本策略</div>
            <div className="flex gap-1.5">
              {(
                [
                  { value: "direct", label: "直接出图" },
                  { value: "layered", label: "分层留白" },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setTextMode(o.value)}
                  className={[
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    textMode === o.value
                      ? "bg-accent-soft font-medium text-primary"
                      : "border border-border text-muted-foreground hover:bg-muted",
                  ].join(" ")}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              分层留白 = 模型留干净负空间、不烤字，便于后续叠真实文字。
            </p>
          </div>

          {/* F7 · 风格关键词 */}
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>风格关键词</span>
              <span className="text-xs font-normal text-muted-foreground">
                {styleKeywords.length}/{MAX_KEYWORDS}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-background p-2 focus-within:border-primary/40 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]">
              {styleKeywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-primary"
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    aria-label={`移除 ${kw}`}
                    className="text-primary/60 transition-colors hover:text-primary"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                onKeyDown={onKeywordKeyDown}
                onBlur={() => {
                  addKeyword(keywordDraft);
                  setKeywordDraft("");
                }}
                disabled={styleKeywords.length >= MAX_KEYWORDS}
                placeholder={
                  styleKeywords.length >= MAX_KEYWORDS
                    ? "已达上限"
                    : "输入后回车添加…"
                }
                className="min-w-[7rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTED_KEYWORDS.filter((k) => !styleKeywords.includes(k)).map(
                (k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => addKeyword(k)}
                    disabled={styleKeywords.length >= MAX_KEYWORDS}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    + {k}
                  </button>
                ),
              )}
            </div>
          </div>

          {/* F9 · 参考素材区 */}
          {projectId ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>参考素材</span>
                {references.length ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {references.length}/8
                  </span>
                ) : null}
              </div>
              {references.length ? (
                <div className="flex flex-wrap gap-2">
                  {references.map((r) => (
                    <div
                      key={r.id}
                      className="group relative h-16 w-16 overflow-hidden rounded-xl border border-border bg-background"
                    >
                      {r.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.thumbUrl}
                          alt={r.fileName ?? "参考素材"}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          ◇
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => dropReference(r.id)}
                        aria-label="移除参考素材"
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-card/90 text-xs text-muted-foreground shadow-sm transition-colors hover:text-destructive"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                  从素材库『设为参考』添加
                </p>
              )}
            </div>
          ) : null}

          {/* F11 · 生成额度展示 + H12 升级入口 */}
          {quota ? (
            <QuotaBar quota={quota} onUpgrade={() => setShowUpgrade(true)} />
          ) : null}

          {submitErr ? (
            <p className="text-sm text-destructive">{submitErr}</p>
          ) : null}

          <div className="mt-auto">
            <button
              onClick={() => {
                if (!projectId) {
                  setSubmitErr(
                    "请先选择一个项目（没有就去项目页创建）",
                  );
                  return;
                }
                setSubmitErr(null);
                setConfirmSubmit(true);
              }}
              disabled={submitting || running}
              className="h-12 w-full rounded-[18px] bg-gradient-to-br from-primary to-accent text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-70"
            >
              {running ? "AI 正在生成…" : submitting ? "提交中…" : "提交制作"}
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              内容由 AI 生成，请注意核对准确性。
            </p>
          </div>
        </aside>
      </div>

      {/* H9 · 提交制作确认弹窗 */}
      {confirmSubmit ? (
        <ConfirmSubmitDialog
          summary={{
            projectName:
              projects.find((p) => p.id === projectId)?.name ?? "未选择项目",
            sceneType:
              SCENE_TYPES.find((s) => s.value === sceneType)?.label ??
              sceneType,
            scene: scene.trim(),
            sellingPoint: sellingPoint.trim(),
            count: multiSize ? selectedTargets.length : versionCount,
            multiSize,
            targets: selectedTargets.map(
              (t) => `${t.label} ${t.width}×${t.height}`,
            ),
            textMode,
            styleKeywords,
            referenceCount: references.length,
            quota: quota ?? null,
          }}
          submitting={submitting}
          onCancel={() => setConfirmSubmit(false)}
          onConfirm={() => {
            setConfirmSubmit(false);
            void submit();
          }}
        />
      ) : null}

      {/* H12 · 额度升级弹窗 */}
      {showUpgrade ? (
        <UpgradeDialog
          quota={quota ?? null}
          onClose={() => setShowUpgrade(false)}
        />
      ) : null}

      {/* G6 · 驳回弹窗 — 可选附理由（reviewNote），走真实 review 端点。 */}
      {rejectOpen ? (
        <RejectDialog
          note={rejectNote}
          submitting={reviewBusy}
          error={reviewErr}
          onChange={setRejectNote}
          onCancel={() => {
            setRejectOpen(false);
            setReviewErr(null);
          }}
          onConfirm={() => void decideReview("REJECTED", rejectNote)}
        />
      ) : null}

      {/* 局部重画 · 蒙版绘制覆盖层（迁移自 prd_agent 视觉创作）。涂抹重绘区 + 指令 →
          op=INPAINT + payload.mask 走真实改图链路；提交中保持打开给出反馈，终态自动关闭。 */}
      {maskOpen && (maskTarget ?? current)?.imageUrl ? (
        <MaskPaintCanvas
          imageSrc={(maskTarget ?? current)!.imageUrl}
          imageWidth={versionPixelSize((maskTarget ?? current)!).width}
          imageHeight={versionPixelSize((maskTarget ?? current)!).height}
          submitting={!!editJobId || busy === "edit"}
          onConfirm={confirmMaskEdit}
          onCancel={() => setMaskOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * G6 · 审阅 / 批准面板 — 显示选中变体的 reviewStatus（PENDING / SUBMITTED /
 * APPROVED / REJECTED）+ 审核理由（reviewNote），并按调用者角色门控动作：
 *   - EDITOR / OWNER 可对 PENDING / REJECTED 版本「提交审阅」（→ SUBMITTED）。
 *   - REVIEWER / OWNER 可对 SUBMITTED 版本「批准 / 驳回」。
 * 终稿（isFinal）不再可审。全部接真实 submit / review 端点，语义 token only。
 */
function ReviewPanel({
  version,
  myRole,
  canSubmit,
  canDecide,
  busy,
  error,
  onSubmit,
  onApprove,
  onOpenReject,
}: {
  version: GenerationVersion;
  myRole: WorkspaceRole | null;
  canSubmit: boolean;
  canDecide: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onApprove: () => void;
  onOpenReject: () => void;
}) {
  const rs = version.reviewStatus ?? "PENDING";
  const meta: Record<string, { tone: Tone; label: string }> = {
    PENDING: { tone: "muted", label: "待提交审阅" },
    SUBMITTED: { tone: "primary", label: "审阅中" },
    APPROVED: { tone: "success", label: "已批准" },
    REJECTED: { tone: "danger", label: "已驳回" },
  };
  const m = meta[rs] ?? meta.PENDING!;

  // 可提交：PENDING / REJECTED 且非终稿（与 submit 端点的职责分离一致）。
  const submittable =
    canSubmit && !version.isFinal && (rs === "PENDING" || rs === "REJECTED");
  // 可审批：仅 SUBMITTED。
  const decidable = canDecide && rs === "SUBMITTED";

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">
          审阅状态
        </span>
        <Pill tone={m.tone}>{m.label}</Pill>
      </div>

      {version.reviewNote ? (
        <p className="mt-2 rounded-xl bg-muted px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">审核意见：</span>
          {version.reviewNote}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {submittable ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded-full bg-gradient-to-br from-primary to-accent px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.22)] disabled:opacity-60"
          >
            {busy ? "提交中…" : rs === "REJECTED" ? "重新提交审阅" : "提交审阅"}
          </button>
        ) : null}
        {decidable ? (
          <>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="rounded-full border border-success/40 px-3 py-1.5 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
            >
              批准
            </button>
            <button
              type="button"
              onClick={onOpenReject}
              disabled={busy}
              className="rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
            >
              驳回
            </button>
          </>
        ) : null}
      </div>

      {/* 诚实空态：既不能提交也不能审批时，说明原因。 */}
      {!submittable && !decidable ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {rs === "SUBMITTED"
            ? myRole
              ? "等待审核角色（审核 / 所有者）批准或驳回。"
              : "等待审核。"
            : rs === "APPROVED"
              ? "该版本已批准，可设为终稿并导出交付。"
              : myRole && !canSubmit
                ? "你的角色（查看）无提交审阅权限。"
                : "出图后可提交审阅。"}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * G6 · 驳回弹窗 — 驳回时可选附审核意见（reviewNote，≤500），走真实 review 端点
 * （decision=REJECTED）。语义 token only。
 */
function RejectDialog({
  note,
  submitting,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  note: string;
  submitting: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">驳回版本</div>
        <p className="mt-1 text-sm text-muted-foreground">
          可填写驳回理由，便于编辑修改后重新提交审阅。
        </p>
        <textarea
          value={note}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          placeholder="如：主体偏色、负空间不足、文案需调整…"
          className="mt-4 w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        <div className="mt-1 text-right text-[11px] text-muted-foreground">
          {note.length}/500
        </div>
        {error ? (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-full bg-destructive px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-destructive/90 disabled:opacity-70"
          >
            {submitting ? "驳回中…" : "确认驳回"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * H9 · 提交制作确认弹窗 — summarize exactly what will be generated before firing
 * the real POST /generations flow, plus an honest note that it consumes quota.
 * Read-only summary; the actual generation is unchanged. Semantic tokens only.
 */
function ConfirmSubmitDialog({
  summary,
  submitting,
  onCancel,
  onConfirm,
}: {
  summary: {
    projectName: string;
    sceneType: string;
    scene: string;
    sellingPoint: string;
    count: number;
    multiSize: boolean;
    targets: string[];
    textMode: "direct" | "layered";
    styleKeywords: string[];
    referenceCount: number;
    quota: QuotaStatus | null;
  };
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const q = summary.quota;
  const periodText =
    q == null
      ? null
      : q.monthlyQuota === -1
        ? "本周期不限"
        : `本周期已用 ${q.periodUsed}/${q.monthlyQuota}`;
  const remaining =
    q && q.monthlyQuota !== -1 ? q.monthlyQuota - q.periodUsed : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">确认提交制作</div>
        <p className="mt-1 text-sm text-muted-foreground">
          确认后将提交至 AI 受控出图，请核对生成内容。
        </p>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">项目</dt>
          <dd className="font-medium">{summary.projectName}</dd>
          <dt className="text-muted-foreground">画面类型</dt>
          <dd>{summary.sceneType}</dd>
          <dt className="text-muted-foreground">场景</dt>
          <dd>{summary.scene || "—"}</dd>
          <dt className="text-muted-foreground">生成数量</dt>
          <dd>
            {summary.multiSize
              ? `${summary.count} 张（多尺寸，每尺寸 1 张）`
              : `${summary.count} 张`}
          </dd>
          {summary.multiSize && summary.targets.length ? (
            <>
              <dt className="text-muted-foreground">尺寸</dt>
              <dd>{summary.targets.join("、")}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">文本策略</dt>
          <dd>{summary.textMode === "layered" ? "分层留白" : "直接出图"}</dd>
          {summary.styleKeywords.length ? (
            <>
              <dt className="text-muted-foreground">风格关键词</dt>
              <dd>{summary.styleKeywords.join("、")}</dd>
            </>
          ) : null}
          {summary.referenceCount ? (
            <>
              <dt className="text-muted-foreground">参考素材</dt>
              <dd>{summary.referenceCount} 张</dd>
            </>
          ) : null}
        </dl>

        <div className="mt-4 rounded-2xl bg-accent-soft/60 p-3.5 text-xs leading-relaxed text-foreground/80">
          <p className="line-clamp-3">
            <span className="font-medium text-foreground">需求 / 卖点：</span>
            {summary.sellingPoint || "（未填写）"}
          </p>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          本次出图将消耗生成额度
          {periodText ? `（${periodText}` : ""}
          {periodText && remaining != null
            ? `，剩余 ${Math.max(0, remaining)}）`
            : periodText
              ? "）"
              : ""}
          。
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-full bg-gradient-to-br from-primary to-accent px-5 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)] disabled:opacity-70"
          >
            {submitting ? "提交中…" : "确认出图"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * H12 · 额度升级弹窗 — show the current quota (from GET /quota) + plan tiers.
 * Phase-1 has no real billing, so tiers are informational and the CTA is
 * "contact to upgrade" (honest — never fakes a payment). Semantic tokens only.
 */
function UpgradeDialog({
  quota,
  onClose,
}: {
  quota: QuotaStatus | null;
  onClose: () => void;
}) {
  const currentPlan = quota?.plan ?? null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">升级套餐 · 提升出图额度</div>
        <p className="mt-1 text-sm text-muted-foreground">
          按品牌规范受控出图，额度越高可批量产出越多营销物料。
        </p>

        {quota ? (
          <div className="mt-4 rounded-2xl border border-border bg-background p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前套餐</span>
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                {quota.plan}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              本周期{" "}
              <span className="font-medium text-foreground">
                {quota.periodUsed}/
                {quota.monthlyQuota === -1 ? "不限" : quota.monthlyQuota}
              </span>{" "}
              · 今日{" "}
              <span className="font-medium text-foreground">
                {quota.dailyUsed}/
                {quota.dailyLimit === -1 ? "不限" : quota.dailyLimit}
              </span>
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {planTiers.map((tier) => {
            const isCurrent = currentPlan === tier.planKey;
            return (
              <div
                key={tier.planKey}
                className={[
                  "flex flex-col rounded-2xl border p-4",
                  tier.highlight
                    ? "border-primary/40 bg-accent-soft/40"
                    : "border-border bg-background",
                ].join(" ")}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{tier.name}</span>
                  {isCurrent ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                      当前
                    </span>
                  ) : tier.highlight ? (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                      推荐
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-lg font-semibold text-primary">
                  {tier.priceLabel}
                </div>
                <ul className="mt-3 flex flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
                  {tier.features.map((f) => (
                    <li key={f} className="flex gap-1.5">
                      <span className="text-primary">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-5 rounded-2xl bg-accent-soft/60 p-3.5 text-xs leading-relaxed text-foreground/80">
          一期为内部专属部署，套餐升级请联系{" "}
          <a
            href={`mailto:${upgradeContactEmail}`}
            className="font-medium text-primary underline underline-offset-2"
          >
            {upgradeContactEmail}
          </a>
          。在线自助计费将在后续多租户版本提供。
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            知道了
          </button>
          <a
            href={`mailto:${upgradeContactEmail}?subject=BrandAI 套餐升级咨询`}
          >
            <button
              type="button"
              className="rounded-full bg-gradient-to-br from-primary to-accent px-5 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)]"
            >
              联系升级
            </button>
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * F2 / L6 — workspace top toolbar: undo/redo for the generation-form state and
 * zoom controls (in / out / reset 100% / fit) for the big preview. Pure
 * client-side; buttons disable at their bounds. Uses semantic tokens only.
 */
function Toolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const btn =
    "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="撤销"
        title="撤销 (表单)"
        className={btn}
      >
        ↶
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label="重做"
        title="重做 (表单)"
        className={btn}
      >
        ↷
      </button>
    </div>
  );
}

function StatusPill({
  status,
  timedOut,
}: {
  status: string | null;
  timedOut: boolean;
}) {
  if (timedOut) return <Pill tone="warning">超时，请重试</Pill>;
  if (!status) return null;
  const map: Record<string, { tone: Tone; label: string }> = {
    PENDING: { tone: "muted", label: "已受理 · 排队中" },
    RUNNING: { tone: "primary", label: "生成中…" },
    SUCCEEDED: { tone: "success", label: "已完成" },
    FAILED: { tone: "danger", label: "失败" },
  };
  const m = map[status] ?? { tone: "muted" as Tone, label: status };
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

type Tone = "muted" | "primary" | "success" | "danger" | "warning";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const map: Record<Tone, string> = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    danger: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

// F11 — compact period/day usage with a violet bar. -1 = 不限. H12 — 升级入口.
function QuotaBar({
  quota,
  onUpgrade,
}: {
  quota: {
    dailyUsed: number;
    dailyLimit: number;
    periodUsed: number;
    monthlyQuota: number;
    plan: string;
  };
  onUpgrade: () => void;
}) {
  const { periodUsed, monthlyQuota, dailyUsed, dailyLimit, plan } = quota;
  const monthlyText = monthlyQuota === -1 ? "不限" : monthlyQuota;
  const dailyText = dailyLimit === -1 ? "不限" : dailyLimit;
  const pct =
    monthlyQuota > 0
      ? Math.min(100, Math.round((periodUsed / monthlyQuota) * 100))
      : monthlyQuota === -1
        ? 0
        : 100;
  return (
    <div className="rounded-2xl border border-border bg-background p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">生成额度</span>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
            {plan}
          </span>
          <button
            type="button"
            onClick={onUpgrade}
            className="rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-accent-soft"
          >
            升级
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        本周期{" "}
        <span className="font-medium text-foreground">
          {periodUsed}/{monthlyText}
        </span>{" "}
        · 今日{" "}
        <span className="font-medium text-foreground">
          {dailyUsed}/{dailyText}
        </span>
      </p>
      {monthlyQuota !== -1 ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-accent-soft">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
