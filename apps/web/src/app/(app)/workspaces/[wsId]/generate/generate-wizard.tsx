"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  BrandRule,
  Generation,
  Project,
  SceneType,
  SizeSpec,
  WorkspaceRole,
} from "@brandai/contracts";
import { CHANNEL_SIZES } from "@brandai/contracts";
import {
  Button,
  Badge,
  Input,
  Textarea,
  Label,
  Spinner,
  Panel,
  SectionHeading,
  FieldLabel,
  MiniStat,
  WorkflowStepper,
  AIInsightPanel,
  GenerationBriefBox,
  ReferenceSourceList,
  type ReferenceSource,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { formatElapsed } from "../../../queue-widget";
import { TextLayerEditor } from "./text-layer-editor";

/** PrecheckResult shape from lib/precheck.ts (stable for the wizard). */
interface PrecheckResult {
  ok: boolean;
  blocking: boolean;
  report: {
    overall: "PASS" | "RISK" | "FORBIDDEN";
    textResults: ComplianceResult[];
    visualResults: ComplianceResult[];
    checkedAt: string;
  };
  results: ComplianceResult[];
}
interface ComplianceResult {
  level: "PASS" | "RISK" | "FORBIDDEN";
  span?: string;
  reason: string;
  replacement?: string;
}

interface JobState {
  jobId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  progress: number;
  failedReason?: string;
}

const SCENE_TYPES: { value: SceneType; label: string; hint: string }[] = [
  { value: "ECOM_MAIN", label: "电商主图", hint: "白底/卖点突出的主图" },
  { value: "SCENE", label: "场景图", hint: "产品置于使用场景" },
  { value: "SOCIAL_POSTER", label: "社媒海报", hint: "社交平台传播海报" },
  { value: "CAMPAIGN_KV", label: "活动 KV", hint: "活动主视觉" },
  { value: "SELLING_POINT", label: "产品卖点图", hint: "卖点拆解说明图" },
];

const STEPS = ["选择项目", "选择类型", "输入卖点与场景", "生成"];

export function GenerateWizard({
  wsId,
  initialProjects,
  confirmedRuleCount,
  confirmedRules,
  myRole,
  onBriefChange,
}: {
  wsId: string;
  initialProjects: Project[];
  confirmedRuleCount: number;
  /**
   * P3.3 — full BrandRule[] (CONFIRMED only) used by the result panel to
   * resolve `params.appliedRuleIds` → readable summaries via the
   * ReferenceSourceList business component. Optional: empty fallback if the
   * server didn't ship it (e.g. legacy callers).
   */
  confirmedRules?: BrandRule[];
  myRole: WorkspaceRole;
  /**
   * P3.3 — emits the current "selling point + scene" brief to the parent so
   * the §6.4 right-rail RuleConstraintsSidebar can highlight rules whose
   * keywords appear in the user's pitch. Optional: wizard works standalone
   * without it.
   */
  onBriefChange?: (brief: { sellingPoint: string; scene: string }) => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(
    initialProjects[0]?.id ?? null,
  );
  const [sceneType, setSceneType] = useState<SceneType | null>(null);
  const [sellingPoint, setSellingPoint] = useState("");
  const [scene, setScene] = useState("");

  // P3.3 — surface brief text to a parent for §6.4 rule-hit highlighting.
  useEffect(() => {
    onBriefChange?.({ sellingPoint, scene });
  }, [sellingPoint, scene, onBriefChange]);
  // M3 — text rendering strategy. "direct" (default) lets the model render any
  // text itself; "layered" steers it to leave clean negative space and render
  // NO text, so the user overlays crisp editable text via the text-layer editor.
  const [textMode, setTextMode] = useState<"direct" | "layered">("direct");
  const [precheck, setPrecheck] = useState<PrecheckResult | null>(null);
  const [genId, setGenId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // §2.1/§2.4 — submission timestamp + live elapsed + 6-minute timeout cap.
  // submittedAt is set the moment the POST resolves (which is <2s now that
  // AI precheck moved to the worker). nowTs ticks each second only while
  // `running`. TIMED_OUT halts polling and surfaces a clear exit panel so
  // the user never stares at an infinite spinner.
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const GENERATION_CAP_MS = 6 * 60_000;
  // P2.0 — multi-size batch. When `multiSize` is on, `targets` drives a
  // 1→N fan-out (one image per size); otherwise the legacy versionCount path.
  const [multiSize, setMultiSize] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [customSizes, setCustomSizes] = useState<SizeSpec[]>([]);
  const [customW, setCustomW] = useState("");
  const [customH, setCustomH] = useState("");

  const targets: SizeSpec[] = useMemo(() => {
    if (!multiSize) return [];
    const presets = CHANNEL_SIZES.filter((s) => selectedKeys.has(s.key));
    return [...presets, ...customSizes];
  }, [multiSize, selectedKeys, customSizes]);

  const { data: projects = initialProjects } = useQuery({
    queryKey: ["projects", wsId],
    queryFn: () =>
      apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
    initialData: initialProjects,
  });

  // Poll the generate job + generation until it terminates.
  const { data: poll } = useQuery({
    queryKey: ["generation", wsId, genId, jobId],
    enabled: !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      const gs = q.state.data?.generation?.status;
      if (s === "FAILED" || gs === "FAILED") return false;
      if (gs === "SUCCEEDED") return false;
      // §2.4 — stop polling at the 6-min cap so the wizard doesn't hammer
      // the server while showing a timeout-exit panel. Reads submittedAt
      // via the latest value at refetch time.
      if (
        submittedAt != null &&
        Date.now() - submittedAt > GENERATION_CAP_MS
      ) {
        return false;
      }
      return 1500;
    },
    queryFn: () =>
      apiFetch<{ generation: Generation; job?: JobState }>(
        `/api/workspaces/${wsId}/generations/${genId}${
          jobId ? `?jobId=${jobId}` : ""
        }`,
      ),
  });

  const generation = poll?.generation ?? null;
  const job = poll?.job ?? null;
  const elapsedMs = submittedAt != null ? nowTs - submittedAt : 0;
  const timedOut =
    submittedAt != null &&
    elapsedMs > GENERATION_CAP_MS &&
    generation?.status !== "SUCCEEDED" &&
    generation?.status !== "FAILED";
  // `running` represents "the wizard is waiting on the server". Once the
  // 6-min cap fires, treat the local UI as no longer running so the result
  // panel can switch to the timeout-exit view (§2.4: never an infinite
  // spinner). The server keeps going independently — its result will land
  // in the activity log + queue widget.
  const running =
    !!genId &&
    generation?.status !== "SUCCEEDED" &&
    generation?.status !== "FAILED" &&
    !timedOut;

  const runPrecheck = useMutation({
    mutationFn: () =>
      apiFetch<PrecheckResult>(
        `/api/workspaces/${wsId}/generations/precheck`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            sceneType,
            sellingPoint,
            scene,
          }),
        },
      ),
    onSuccess: (r) => setPrecheck(r),
  });

  const submit = useMutation({
    mutationFn: () =>
      apiFetch<{
        generation: Generation;
        jobId: string;
      }>(`/api/workspaces/${wsId}/generations`, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          sceneType,
          sellingPoint,
          scene,
          textMode,
          ...(targets.length > 0 ? { targets } : {}),
        }),
      }),
    onSuccess: (r) => {
      setGenId(r.generation.id);
      setJobId(r.jobId);
      setSubmittedAt(Date.now()); // §2.1 — arm the elapsed timer.
      syncGenUrl(r.generation.id);
    },
  });

  const regenerate = useMutation({
    mutationFn: () =>
      apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/generations/${genId}`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      setJobId(r.jobId);
      setSubmittedAt(Date.now()); // re-arm for the re-run
    },
  });

  // P2.0 — retry a single failed size only (re-runs the generation with just
  // that one target). The worker replaces the prior root versions.
  const retrySize = useMutation({
    mutationFn: (size: SizeSpec) =>
      apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/generations/${genId}`,
        { method: "POST", body: JSON.stringify({ targets: [size] }) },
      ),
    onSuccess: (r) => {
      setJobId(r.jobId);
      setSubmittedAt(Date.now());
    },
  });

  const keep = useMutation({
    mutationFn: (versionId: string) =>
      apiFetch<Generation>(
        `/api/workspaces/${wsId}/generations/${genId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ versionId }),
        },
      ),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["generation", wsId, genId],
      }),
  });

  // Stop polling once finished.
  useEffect(() => {
    if (
      generation?.status === "SUCCEEDED" ||
      generation?.status === "FAILED"
    ) {
      setJobId(null);
    }
  }, [generation?.status]);

  // §2.1 — 1-second tick for the live elapsed display while we're waiting
  // on the server. Disabled when idle so we don't re-render every second
  // for no reason.
  useEffect(() => {
    if (!running) return;
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const canGenerate =
    !!projectId &&
    !!sceneType &&
    !(precheck && precheck.blocking);

  function reset() {
    setGenId(null);
    setJobId(null);
    setPrecheck(null);
    setSubmittedAt(null);
    setStep(0);
    syncGenUrl(null);
  }

  // Server-authoritative resume: the generation lives in the DB + job queue, so
  // keep its id in the URL (?gen=). A page refresh re-reads it and resumes the
  // result view (status/versions come from the server) instead of dropping the
  // user back to step 1 — the job was never "stopped", only the client view.
  function syncGenUrl(id: string | null) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("gen", id);
    else url.searchParams.delete("gen");
    window.history.replaceState(null, "", url.toString());
  }

  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("gen");
    if (g) {
      setGenId(g);
      setStep(STEPS.length - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-2xl border border-foreground/10 bg-card/40 px-6 py-5">
        <div className="grid grid-cols-3 gap-6">
          <MiniStat label="PROJECTS" value={projects.length} hint="品牌项目" />
          <MiniStat
            label="RULES"
            value={confirmedRuleCount}
            hint="已确认规则 · 自动拼入生成参数"
          />
          <MiniStat
            label="STEP"
            value={`${step + 1} / ${STEPS.length}`}
            hint={STEPS[step]}
          />
        </div>
      </div>

      <WorkflowStepper
        steps={STEPS.map((s, i) => ({ id: String(i), label: s }))}
        currentId={String(step)}
        onStepClick={(id) => {
          const i = Number(id);
          if (!genId && i <= step) setStep(i);
        }}
      />

      {/* Step 1 — pick / create a project */}
      {step === 0 && !genId ? (
        <ProjectStep
          wsId={wsId}
          projects={projects}
          projectId={projectId}
          setProjectId={setProjectId}
          onNext={() => setStep(1)}
        />
      ) : null}

      {/* Step 2 — scene type */}
      {step === 1 && !genId ? (
        <Panel className="flex flex-col gap-6">
          <SectionHeading eyebrow="SCENE · 场景类型" title="选择生成类型" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SCENE_TYPES.map((t) => {
              const on = sceneType === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setSceneType(t.value)}
                  className={`rounded-2xl border p-5 text-left transition ${
                    on
                      ? "border-accent bg-card shadow-sm"
                      : "border-foreground/10 bg-muted hover:border-accent"
                  }`}
                >
                  <div className="font-serif text-lg">{t.label}</div>
                  <div className="mt-1.5 text-sm text-muted-foreground">
                    {t.hint}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(0)}
            >
              上一步
            </Button>
            <Button
              size="sm"
              disabled={!sceneType}
              onClick={() => setStep(2)}
            >
              下一步
            </Button>
          </div>
        </Panel>
      ) : null}

      {/* Step 3 — selling point + scene */}
      {step === 2 && !genId ? (
        <Panel className="flex flex-col gap-6">
          <SectionHeading
            eyebrow="BRIEF · 创意简报"
            title="输入卖点与场景"
          />
          {/* P3.3 — uses the GenerationBriefBox business component. The
              wizard's two-field semantics (selling point + scene) map onto
              the business component's (sellingPoints + value/brief), with
              scene playing the role of the brief / 创意场景描述. */}
          <GenerationBriefBox
            value={scene}
            onChange={setScene}
            sellingPoints={sellingPoint}
            onSellingPointsChange={(v) => {
              setSellingPoint(v);
              setPrecheck(null);
            }}
          />

          {/* M3 — text rendering strategy. 直接出图 lets the model render text
              (fast, may be imperfect); 图文分层 leaves clean space for crisp
              editable overlay text added afterwards. */}
          <div className="flex flex-col gap-3">
            <FieldLabel>文字方式 · TEXT MODE</FieldLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    value: "direct" as const,
                    label: "直接出图",
                    hint: "模型直接生成含文字的整图，快速便捷，文字可能不够精准。",
                  },
                  {
                    value: "layered" as const,
                    label: "图文分层",
                    hint: "模型只出干净留白背景、不生成文字，之后叠加清晰可编辑的真实文字。",
                  },
                ]
              ).map((m) => {
                const on = textMode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setTextMode(m.value)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      on
                        ? "border-accent bg-card shadow-sm"
                        : "border-foreground/10 bg-muted hover:border-accent"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-serif text-base">{m.label}</span>
                      {on ? <Badge tone="pass">已选</Badge> : null}
                    </div>
                    <div className="mt-1.5 text-sm text-muted-foreground">
                      {m.hint}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(1)}
            >
              上一步
            </Button>
            <Button
              size="sm"
              onClick={() => setStep(3)}
            >
              下一步
            </Button>
          </div>
        </Panel>
      ) : null}

      {/* Step 4 — precheck + generate */}
      {step === 3 && !genId ? (
        <Panel className="flex flex-col gap-6">
          <SectionHeading
            eyebrow="COMPLIANCE · 合规预检"
            title="生成前合规预检"
          />
          <p className="text-sm text-muted-foreground">
            生成前对卖点文案做广告违禁词与品牌规范预检。命中 FORBIDDEN
            将阻止生成，命中 RISK 仅提示，可继续。
          </p>

          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={runPrecheck.isPending}
              onClick={() => runPrecheck.mutate()}
            >
              {runPrecheck.isPending ? <Spinner /> : null}
              运行合规预检
            </Button>
          </div>

          {precheck ? (
            <PrecheckPanel precheck={precheck} />
          ) : (
            <div className="rounded-2xl border border-foreground/10 bg-muted px-5 py-4 text-sm text-muted-foreground">
              尚未预检。建议先运行预检再生成。
            </div>
          )}

          <MultiSizePicker
            multiSize={multiSize}
            setMultiSize={setMultiSize}
            selectedKeys={selectedKeys}
            setSelectedKeys={setSelectedKeys}
            customSizes={customSizes}
            setCustomSizes={setCustomSizes}
            customW={customW}
            setCustomW={setCustomW}
            customH={customH}
            setCustomH={setCustomH}
          />

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(2)}
            >
              上一步
            </Button>
            <Button
              size="sm"
              disabled={
                !canGenerate ||
                submit.isPending ||
                (multiSize && targets.length === 0)
              }
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? <Spinner /> : null}
              {multiSize
                ? `生成 ${targets.length} 个尺寸`
                : "生成多版本"}
            </Button>
          </div>
          {submit.isError
            ? (() => {
                const message = (submit.error as Error).message ?? "";
                // D6 — HIGH-risk lexicon / FORBIDDEN brand rules hard-block
                // with 422. Distinct visual + actionable next step.
                const blocked =
                  /合规|forbidden|FORBIDDEN|禁用|高风险|HIGH/i.test(message);
                return (
                  <div
                    className={
                      blocked
                        ? "flex flex-col gap-3 rounded-2xl border-2 border-destructive/50 bg-destructive/10 px-5 py-4 text-sm text-destructive"
                        : "rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive"
                    }
                  >
                    {blocked ? (
                      <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.25em]">
                        <span aria-hidden>⛔</span>
                        <span>BLOCKED · 合规阻断</span>
                      </div>
                    ) : null}
                    <div className="leading-relaxed">{message}</div>
                    {blocked ? (
                      <div className="text-xs text-destructive/80">
                        修改卖点/场景文案,或调整品牌规则强弱后再试。
                      </div>
                    ) : null}
                  </div>
                );
              })()
            : null}
        </Panel>
      ) : null}

      {/* Results */}
      {genId ? (
        <ResultPanel
          wsId={wsId}
          genId={genId}
          generation={generation}
          job={job}
          running={running}
          elapsedMs={elapsedMs}
          timedOut={timedOut}
          onRegenerate={() => regenerate.mutate()}
          regenerating={regenerate.isPending || running}
          onKeep={(vid) => keep.mutate(vid)}
          keepingId={keep.isPending ? keep.variables ?? null : null}
          onReset={reset}
          submittedTargets={targets}
          onRetrySize={(size) => retrySize.mutate(size)}
          retryingKey={
            retrySize.isPending ? retrySize.variables?.key ?? null : null
          }
          myRole={myRole}
          confirmedRules={confirmedRules ?? []}
        />
      ) : null}
    </div>
  );
}

function ProjectStep({
  wsId,
  projects,
  projectId,
  setProjectId,
  onNext,
}: {
  wsId: string;
  projects: Project[];
  projectId: string | null;
  setProjectId: (id: string) => void;
  onNext: () => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(projects.length === 0);
  const [name, setName] = useState("");
  const [campaign, setCampaign] = useState("");
  const [product, setProduct] = useState("");
  const [channel, setChannel] = useState("");

  const create = useMutation({
    mutationFn: () =>
      apiFetch<Project>(`/api/workspaces/${wsId}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name,
          campaign: campaign || undefined,
          product: product || undefined,
          channel: channel || undefined,
        }),
      }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects", wsId] });
      setProjectId(p.id);
      setCreating(false);
      setName("");
    },
  });

  return (
    <Panel className="flex flex-col gap-6">
      <SectionHeading
        eyebrow="PROJECT · 项目"
        title="选择项目"
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCreating((c) => !c)}
          >
            {creating ? "选择已有项目" : "新建项目"}
          </Button>
        }
      />

      {creating ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label>项目名称 *</Label>
            <Input
              value={name}
              placeholder="春季新品上市"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label>活动</Label>
              <Input
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>商品</Label>
              <Input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>渠道</Label>
              <Input
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={name.trim().length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Spinner /> : null}
            创建并选用
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          还没有项目，先新建一个。
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const on = projectId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className={`rounded-2xl border p-5 text-left transition ${
                  on
                    ? "border-accent bg-card shadow-sm"
                    : "border-foreground/10 bg-muted hover:border-accent"
                }`}
              >
                <div className="font-serif text-lg">{p.name}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {p.campaign ? (
                    <Badge tone="neutral">{p.campaign}</Badge>
                  ) : null}
                  {p.product ? (
                    <Badge tone="neutral">{p.product}</Badge>
                  ) : null}
                  {p.channel ? (
                    <Badge tone="neutral">{p.channel}</Badge>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div>
        <Button
          size="sm"
          disabled={!projectId}
          onClick={onNext}
        >
          下一步
        </Button>
      </div>
    </Panel>
  );
}

function MultiSizePicker({
  multiSize,
  setMultiSize,
  selectedKeys,
  setSelectedKeys,
  customSizes,
  setCustomSizes,
  customW,
  setCustomW,
  customH,
  setCustomH,
}: {
  multiSize: boolean;
  setMultiSize: (v: boolean) => void;
  selectedKeys: Set<string>;
  setSelectedKeys: (s: Set<string>) => void;
  customSizes: SizeSpec[];
  setCustomSizes: (s: SizeSpec[]) => void;
  customW: string;
  setCustomW: (v: string) => void;
  customH: string;
  setCustomH: (v: string) => void;
}) {
  function toggle(key: string) {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedKeys(next);
  }
  function addCustom() {
    const w = parseInt(customW, 10);
    const h = parseInt(customH, 10);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0)
      return;
    setCustomSizes([
      ...customSizes,
      { key: `custom_${w}x${h}`, label: "自定义", width: w, height: h },
    ]);
    setCustomW("");
    setCustomH("");
  }
  const count = selectedKeys.size + customSizes.length;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-foreground/10 bg-muted p-5">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={multiSize}
          onChange={(e) => setMultiSize(e.target.checked)}
        />
        多尺寸批量生成（一次产出每个尺寸各一张，共享同一品牌约束）
      </label>
      {multiSize ? (
        <>
          <div className="flex flex-wrap gap-2">
            {CHANNEL_SIZES.map((s) => {
              const on = selectedKeys.has(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggle(s.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    on
                      ? "border-accent bg-accent text-ink"
                      : "border-foreground/15 text-muted-foreground hover:border-accent"
                  }`}
                >
                  {s.label} · {s.width}×{s.height}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label>自定义宽</Label>
              <Input
                value={customW}
                inputMode="numeric"
                placeholder="W"
                className="w-24"
                onChange={(e) => setCustomW(e.target.value)}
              />
            </div>
            <span className="pb-2 text-muted-foreground">×</span>
            <div className="flex flex-col gap-1">
              <Label>自定义高</Label>
              <Input
                value={customH}
                inputMode="numeric"
                placeholder="H"
                className="w-24"
                onChange={(e) => setCustomH(e.target.value)}
              />
            </div>
            <Button size="sm" variant="ghost" onClick={addCustom}>
              添加自定义尺寸
            </Button>
          </div>
          {customSizes.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {customSizes.map((s, i) => (
                <span
                  key={`${s.key}_${i}`}
                  className="flex items-center gap-2 rounded-full border border-accent bg-accent px-3 py-1.5 text-xs text-ink"
                >
                  {s.width}×{s.height}
                  <button
                    type="button"
                    onClick={() =>
                      setCustomSizes(customSizes.filter((_, j) => j !== i))
                    }
                    className="opacity-70 hover:opacity-100"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <span className="text-xs text-muted-foreground">
            已选 {count} 个尺寸{count === 0 ? "（至少选 1 个）" : ""}
          </span>
        </>
      ) : null}
    </div>
  );
}

function PrecheckPanel({ precheck }: { precheck: PrecheckResult }) {
  // P3.3 — wired to the AIInsightPanel business component. Compose:
  //   conclusion: 总体结论 + 命中计数
  //   evidence : 每条风险条目 (level + span + reason)
  //   suggestions: 替代表达 (when present)
  const all = [
    ...precheck.results,
    ...precheck.report.textResults,
    ...precheck.report.visualResults,
  ];
  const tone: "pass" | "risk" | "danger" =
    precheck.report.overall === "FORBIDDEN"
      ? "danger"
      : precheck.report.overall === "RISK"
        ? "risk"
        : "pass";

  const counts = all.reduce(
    (acc, r) => {
      acc[r.level] = (acc[r.level] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const conclusion = precheck.blocking
    ? `存在 FORBIDDEN 命中,已阻止生成(违禁 ${counts.FORBIDDEN ?? 0} · 风险 ${counts.RISK ?? 0})。`
    : all.length === 0
      ? "未发现合规风险,可以放心生成。"
      : `命中 ${all.length} 项 — 违禁 ${counts.FORBIDDEN ?? 0} · 风险 ${counts.RISK ?? 0} · 通过 ${counts.PASS ?? 0}。`;

  const evidence = all.map((r) => {
    const head = `[${r.level}]${r.span ? ` 「${r.span}」` : ""}`;
    return `${head} ${r.reason}`;
  });

  const suggestions = all
    .map((r) => r.replacement)
    .filter((s): s is string => !!s && s.length > 0);

  return (
    <AIInsightPanel
      conclusion={conclusion}
      tone={tone}
      evidence={evidence.length > 0 ? evidence : undefined}
      suggestions={suggestions.length > 0 ? suggestions : undefined}
    />
  );
}

function ResultPanel({
  wsId,
  genId,
  generation,
  job,
  running,
  elapsedMs,
  timedOut,
  onRegenerate,
  regenerating,
  onKeep,
  keepingId,
  onReset,
  submittedTargets,
  onRetrySize,
  retryingKey,
  myRole,
  confirmedRules,
}: {
  wsId: string;
  genId: string;
  generation: Generation | null;
  job: JobState | null;
  running: boolean;
  elapsedMs: number;
  timedOut: boolean;
  onRegenerate: () => void;
  regenerating: boolean;
  onKeep: (versionId: string) => void;
  keepingId: string | null;
  onReset: () => void;
  submittedTargets: SizeSpec[];
  onRetrySize: (size: SizeSpec) => void;
  retryingKey: string | null;
  myRole: WorkspaceRole;
  confirmedRules: BrandRule[];
}) {
  const versions = useMemo(
    () => generation?.versions ?? [],
    [generation],
  );
  // P2.0 — multi-size results group by the submitted target list. A target
  // with no matching produced version is treated as a failed size and gets a
  // single-size retry button.
  const isMultiSize = submittedTargets.length > 0;
  const versionByKey = useMemo(() => {
    const m = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      const k = (v.params as Record<string, unknown>)?.targetKey;
      if (typeof k === "string") m.set(k, v);
    }
    return m;
  }, [versions]);
  return (
    <Panel className="flex flex-col gap-6">
      <SectionHeading
        eyebrow="RESULT · 生成结果"
        title="生成结果"
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={regenerating}
              onClick={onRegenerate}
            >
              {regenerating ? <Spinner /> : null}
              重新生成
            </Button>
            <Button size="sm" variant="ghost" onClick={onReset}>
              新建一次生成
            </Button>
          </div>
        }
      />

      {running ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-muted px-5 py-4">
          <div className="flex items-center gap-3">
            <Spinner />
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              生成中 · {generation?.status ?? job?.status ?? "PENDING"} ·{" "}
              {job?.progress ?? 0}%
            </span>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            已用时 {formatElapsed(elapsedMs)}
          </span>
        </div>
      ) : null}
      {timedOut ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-5 py-4 text-sm text-warning">
          <div className="flex items-center justify-between font-mono text-xs uppercase tracking-[0.25em]">
            <span>等待超时 · &gt; 6 分钟</span>
            <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
          </div>
          <p className="leading-relaxed text-foreground/80">
            服务器仍可能在后台完成任务,可刷新本页或到右下角队列 / 运行日志查看结果。
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onReset}>新建一次生成</Button>
            <Button size="sm" variant="outline" onClick={onRegenerate}>
              重试本次
            </Button>
          </div>
        </div>
      ) : null}
      {generation?.status === "FAILED" ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          生成失败：{generation?.error ?? job?.failedReason ?? "未知错误"}
        </div>
      ) : null}
      {generation?.status === "SUCCEEDED" && generation.durationMs != null ? (
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
          总耗时 · {formatElapsed(generation.durationMs)}
        </div>
      ) : null}

      {/* P2.0 — multi-size: group by submitted target; show retry per failed
          size. Otherwise the legacy same-size grid. */}
      {isMultiSize ? (
        <div className="flex flex-col gap-5">
          {submittedTargets.map((t, ti) => {
            const v = versionByKey.get(t.key);
            return (
              <div
                key={`${t.key}_${ti}`}
                className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-muted p-5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    {t.label} · {t.width}×{t.height}
                  </span>
                  {v ? (
                    <Badge tone="pass">已出图</Badge>
                  ) : !running ? (
                    <Badge tone="danger">失败</Badge>
                  ) : (
                    <Badge tone="neutral">生成中</Badge>
                  )}
                </div>
                {v ? (
                  <div className="max-w-xs">
                    <VersionCard
                      wsId={wsId}
                      genId={genId}
                      v={v}
                      running={running}
                      keepingId={keepingId}
                      onKeep={onKeep}
                      myRole={myRole}
                      confirmedRules={confirmedRules}
                    />
                  </div>
                ) : !running ? (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-destructive">
                      该尺寸生成失败。
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={retryingKey === t.key || running}
                      onClick={() => onRetrySize(t)}
                    >
                      {retryingKey === t.key ? <Spinner /> : null}
                      重试该尺寸
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : versions.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {versions.map((v) => (
            <VersionCard
              key={v.id}
              wsId={wsId}
              genId={genId}
              v={v}
              running={running}
              keepingId={keepingId}
              onKeep={onKeep}
              myRole={myRole}
              confirmedRules={confirmedRules}
            />
          ))}
        </div>
      ) : !running ? (
        <p className="text-sm text-muted-foreground">
          暂无版本。可点击「重新生成」再次出图。
        </p>
      ) : null}
    </Panel>
  );
}

const ROLE_RANK: Record<string, number> = {
  OWNER: 3,
  EDITOR: 2,
  REVIEWER: 1,
  VIEWER: 0,
};
const REVIEW_LABEL: Record<string, string> = {
  PENDING: "待送审",
  SUBMITTED: "待审批",
  APPROVED: "已通过",
  REJECTED: "已驳回",
};
function reviewTone(s?: string): "pass" | "risk" | "danger" | "neutral" {
  if (s === "APPROVED") return "pass";
  if (s === "SUBMITTED") return "risk";
  if (s === "REJECTED") return "danger";
  return "neutral";
}

function VersionCard({
  wsId,
  genId,
  v,
  running,
  keepingId,
  onKeep,
  myRole,
  confirmedRules,
}: {
  wsId: string;
  genId: string;
  v: NonNullable<Generation["versions"]>[number];
  running: boolean;
  keepingId: string | null;
  onKeep: (versionId: string) => void;
  myRole: WorkspaceRole;
  confirmedRules: BrandRule[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const rank = ROLE_RANK[myRole] ?? 0;
  // G6 — approval workflow gates (mirror the server: 送审=EDITOR+, 审批=REVIEWER+).
  const reviewStatus = v.reviewStatus ?? "PENDING";
  const canSubmit = rank >= 2 && (reviewStatus === "PENDING" || reviewStatus === "REJECTED");
  const canReview = rank >= 1 && reviewStatus === "SUBMITTED";

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["generation", wsId, genId] });

  const submitReview = useMutation({
    mutationFn: () =>
      apiFetch(`/api/workspaces/${wsId}/generations/${genId}/versions/${v.id}/submit`, {
        method: "POST",
      }),
    onSuccess: refresh,
    onError: (e) => setReviewErr(e instanceof Error ? e.message : String(e)),
  });
  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") =>
      apiFetch(`/api/workspaces/${wsId}/generations/${genId}/versions/${v.id}/review`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSuccess: refresh,
    onError: (e) => setReviewErr(e instanceof Error ? e.message : String(e)),
  });
  const params = (v.params ?? {}) as Record<string, unknown>;
  // P3.3 — also accept `appliedRules` (newer field name) so seeded/legacy
  // payloads both light up the ReferenceSourceList. The seed in
  // scripts/p3-seed-business.sql uses the `appliedRules` shape.
  const ruleIds = Array.isArray(params.appliedRuleIds)
    ? (params.appliedRuleIds as string[])
    : Array.isArray(params.appliedRules)
      ? (params.appliedRules as string[])
      : [];
  const referenceItems: ReferenceSource[] = useMemo(() => {
    if (ruleIds.length === 0) return [];
    const byId = new Map(confirmedRules.map((r) => [r.id, r]));
    return ruleIds.map((id) => {
      const r = byId.get(id);
      return {
        id,
        kind: "rule" as const,
        label: r ? r.summary : id,
      };
    });
  }, [ruleIds, confirmedRules]);
  const label =
    typeof params.targetLabel === "string"
      ? (params.targetLabel as string)
      : `版本 ${v.index + 1}`;
  // Auto post-generation visual compliance verdict (set by the generate
  // worker). Visible-only — does NOT gate "选择入库".
  const overall = v.complianceReport?.overall;
  const complianceTone =
    overall === "FORBIDDEN"
      ? "danger"
      : overall === "RISK"
        ? "risk"
        : "pass";
  // Per-image brand-consistency score (0–100) carried inside complianceReport.
  const score = v.complianceReport?.score;
  const scoreTone =
    score == null
      ? "neutral"
      : score >= 80
        ? "pass"
        : score >= 60
          ? "risk"
          : "danger";
  return (
    <div className="flex flex-col gap-3">
      <div
        className={`relative aspect-square overflow-hidden rounded-2xl border bg-muted shadow-sm ${
          v.isFinal
            ? "border-accent ring-2 ring-accent"
            : "border-foreground/10"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={v.imageUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-serif text-base">{label}</span>
          <span className="flex items-center gap-1.5">
            {score != null ? (
              <Badge tone={scoreTone} className="font-mono">
                品牌契合 {score}
              </Badge>
            ) : null}
            {overall ? (
              <Badge tone={complianceTone}>合规 {overall}</Badge>
            ) : null}
            <Badge tone={reviewTone(reviewStatus)}>
              {REVIEW_LABEL[reviewStatus] ?? reviewStatus}
            </Badge>
            {v.isFinal ? <Badge tone="pass">已入库</Badge> : null}
          </span>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {v.width}×{v.height} · 应用规则 {ruleIds.length} 条
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={v.isFinal || keepingId === v.id || running}
            onClick={() => onKeep(v.id)}
          >
            {keepingId === v.id ? <Spinner /> : null}
            {v.isFinal ? "已选择入库" : "选择入库"}
          </Button>
          {/* M3 — open the 图文分层 text-layer editor for this image. Works for
              any version, but pairs with the layered text mode's clean
              backgrounds. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={running}
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? "收起" : "加文字"}
          </Button>
        </div>

        {/* G6 — approval actions (gated by workspace role) */}
        {canSubmit || canReview ? (
          <div className="flex flex-wrap gap-2">
            {canSubmit ? (
              <Button
                size="sm"
                variant="outline"
                disabled={submitReview.isPending || running}
                onClick={() => {
                  setReviewErr(null);
                  submitReview.mutate();
                }}
              >
                {submitReview.isPending ? <Spinner /> : null}
                送审
              </Button>
            ) : null}
            {canReview ? (
              <>
                <Button
                  size="sm"
                  disabled={decide.isPending || running}
                  onClick={() => {
                    setReviewErr(null);
                    decide.mutate("APPROVED");
                  }}
                >
                  批准
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={decide.isPending || running}
                  onClick={() => {
                    setReviewErr(null);
                    decide.mutate("REJECTED");
                  }}
                >
                  驳回
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {reviewErr ? (
          <span className="text-xs text-destructive">{reviewErr}</span>
        ) : null}
      </div>
      {editing ? (
        <TextLayerEditor
          wsId={wsId}
          genId={genId}
          versionId={v.id}
          width={v.width}
          height={v.height}
          onSaved={() =>
            qc.invalidateQueries({ queryKey: ["generation", wsId, genId] })
          }
        />
      ) : null}

      {/* P3.3 — surfaces which rules were compiled into this version's prompt
          (params.appliedRuleIds / appliedRules). Uses the ReferenceSourceList
          business component, previously orphaned. */}
      {referenceItems.length > 0 ? (
        <ReferenceSourceList
          title="引用来源 · 规则"
          items={referenceItems}
          className="!gap-2 !p-3 text-xs"
        />
      ) : null}
    </div>
  );
}
