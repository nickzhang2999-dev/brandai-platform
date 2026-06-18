"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BrandRule } from "@brandai/contracts";
import { VI } from "@brandai/contracts";
import {
  Button,
  Input,
  Label,
  Spinner,
  Textarea,
  VIFieldGroup,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";

/**
 * VI module form (P1.1). Inline editor for the strongly-typed `structured`
 * payload of a BrandRule. Every VI module now renders a real, schema-driven
 * field set: the six core modules (logo / color / font / product / copy_tone /
 * layout) plus the remaining modules (graphic / imagery / channel_size /
 * prohibition / common_asset / brand_profile / ai_constraint), each built
 * directly from its `@brandai/contracts` zod schema.
 *
 * State is controlled (no react-hook-form yet to keep the bundle slim); the
 * matching zod schema runs on submit and on the server via the rules PATCH
 * route. Failures show inline error chips next to the offending field.
 */

type Module = VI.ModuleName;

const MODULE_LABEL: Record<Module, string> = {
  logo: "Logo 规范",
  color: "色彩规范",
  font: "字体规范",
  graphic: "辅助图形",
  imagery: "影像风格",
  layout: "版式构图",
  product: "产品展示",
  copy_tone: "文案语气",
  channel_size: "渠道与尺寸",
  prohibition: "禁用规范",
  common_asset: "常用素材",
  brand_profile: "品牌画像",
  ai_constraint: "AI 硬约束",
};

function defaultForModule(m: Module): Record<string, unknown> {
  switch (m) {
    case "logo":
      return {
        clear_space_rule: "",
        minimum_size: { digital: "", print: "" },
        allow_rotation: false,
        allow_distortion: false,
        logo_dont_rules: [] as string[],
      };
    case "color":
      return {
        palette: [] as unknown[],
        deviation_threshold: 5,
        allow_gradient: false,
        brightness_preference: "neutral",
        saturation_preference: "medium",
      };
    case "font":
      return {
        primary_font: "",
        fallback_fonts: [] as string[],
        license_status: "UNKNOWN",
        allow_text_distortion: false,
      };
    case "product":
      return {
        standard_angle: [] as string[],
        prohibited_angle: [] as string[],
        allow_crop: true,
        allow_tilt: false,
        product_scale_rule: "",
      };
    case "copy_tone":
      return {
        tone_keywords: [] as string[],
        prohibited_words: [] as string[],
        preferred_words: [] as string[],
        cta_rule: "",
      };
    case "layout":
      return {
        alignment_preference: "left",
        whitespace_ratio: 0.3,
        grid_system: "",
      };
    case "graphic":
      return {
        pattern_library: [] as string[],
        shape_language: "",
        allow_decoration: false,
        prohibited_graphics: [] as string[],
      };
    case "imagery":
      return {
        style_keywords: [] as string[],
        lighting_rule: "",
        composition_rule: "",
        prohibited_visuals: [] as string[],
      };
    case "channel_size":
      return {
        presets: [] as unknown[],
        default_channels: [] as string[],
      };
    case "prohibition":
      return {
        rules: [] as unknown[],
      };
    case "common_asset":
      return {
        entries: [] as unknown[],
      };
    case "brand_profile":
      return {
        industry: "",
        positioning: "",
        target_audience: "",
        brand_personality: [] as string[],
        voice: "",
      };
    case "ai_constraint":
      return {
        negative_prompt: [] as string[],
        required_elements: [] as string[],
        max_text_length: undefined,
        forbid_real_persons: false,
        forbid_celebrity_likeness: false,
      };
    default:
      return {};
  }
}

function splitCsv(s: string): string[] {
  return s
    .split(/[,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function joinCsv(arr: unknown): string {
  return Array.isArray(arr) ? (arr as string[]).join(", ") : "";
}

export function VIModuleForm({
  wsId,
  rule,
}: {
  wsId: string;
  rule: BrandRule & { structured?: Record<string, unknown> | null };
}) {
  const qc = useQueryClient();
  const moduleName = (VI.RULE_TYPE_TO_MODULE[rule.type] ?? "logo") as Module;
  const initial = useMemo(() => {
    const existing =
      (rule.structured as Record<string, unknown> | null | undefined) ?? null;
    return {
      ...defaultForModule(moduleName),
      ...(existing && existing.module === moduleName ? existing : {}),
    };
  }, [rule.structured, moduleName]);

  const [state, setState] = useState<Record<string, unknown>>(initial);
  const [issues, setIssues] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ structured: { ...state, module: moduleName } }),
      }),
    onSuccess: () => {
      setIssues([]);
      qc.invalidateQueries({ queryKey: ["rules", wsId] });
    },
    onError: (err: Error) => {
      setIssues([err.message]);
    },
  });

  function set<K extends string>(k: K, v: unknown) {
    setState((prev) => ({ ...prev, [k]: v }));
  }

  function submit() {
    const schema = VI.MODULE_BY_NAME[moduleName];
    const parsed = schema.safeParse({ ...state, module: moduleName });
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      return;
    }
    setIssues([]);
    save.mutate();
  }

  return (
    <VIFieldGroup
      title={MODULE_LABEL[moduleName]}
      description={`字段已对齐 VI 文档（${moduleName}）。提交时按强类型 schema 校验。`}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={save.isPending} onClick={submit}>
            {save.isPending ? <Spinner /> : null}
            保存结构化字段
          </Button>
          {issues.length > 0 ? (
            <div className="text-xs text-destructive">
              校验失败：{issues.join("；")}
            </div>
          ) : null}
        </div>
      }
    >
      {moduleName === "logo" ? <LogoFields v={state} set={set} /> : null}
      {moduleName === "color" ? <ColorFields v={state} set={set} /> : null}
      {moduleName === "font" ? <FontFields v={state} set={set} /> : null}
      {moduleName === "product" ? <ProductFields v={state} set={set} /> : null}
      {moduleName === "copy_tone" ? <CopyToneFields v={state} set={set} /> : null}
      {moduleName === "layout" ? <LayoutFields v={state} set={set} /> : null}
      {moduleName === "graphic" ? <GraphicFields v={state} set={set} /> : null}
      {moduleName === "imagery" ? <ImageryFields v={state} set={set} /> : null}
      {moduleName === "channel_size" ? (
        <ChannelSizeFields v={state} set={set} />
      ) : null}
      {moduleName === "prohibition" ? (
        <ProhibitionFields v={state} set={set} />
      ) : null}
      {moduleName === "common_asset" ? (
        <CommonAssetFields v={state} set={set} />
      ) : null}
      {moduleName === "brand_profile" ? (
        <BrandProfileFields v={state} set={set} />
      ) : null}
      {moduleName === "ai_constraint" ? (
        <AIConstraintFields v={state} set={set} />
      ) : null}
    </VIFieldGroup>
  );
}

type FieldProps = {
  v: Record<string, unknown>;
  set: (k: string, val: unknown) => void;
};

function LogoFields({ v, set }: FieldProps) {
  const ms = (v.minimum_size ?? {}) as { digital?: string; print?: string };
  return (
    <>
      <div>
        <Label>clear_space_rule</Label>
        <Input
          value={(v.clear_space_rule as string) ?? ""}
          onChange={(e) => set("clear_space_rule", e.target.value)}
          placeholder="例如：留白 ≥ 1x Logo 高度"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>minimum_size.digital</Label>
          <Input
            value={ms.digital ?? ""}
            onChange={(e) =>
              set("minimum_size", { ...ms, digital: e.target.value })
            }
            placeholder="24px"
          />
        </div>
        <div>
          <Label>minimum_size.print</Label>
          <Input
            value={ms.print ?? ""}
            onChange={(e) =>
              set("minimum_size", { ...ms, print: e.target.value })
            }
            placeholder="8mm"
          />
        </div>
      </div>
      {(
        [
          ["allow_rotation", "允许旋转"],
          ["allow_distortion", "允许形变"],
          ["allow_crop", "允许裁切"],
          ["allow_opacity_change", "允许透明度变更"],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!v[k]}
            onChange={(e) => set(k, e.target.checked)}
          />
          {label}
        </label>
      ))}
      <div>
        <Label>logo_dont_rules（逗号分隔）</Label>
        <Textarea
          value={joinCsv(v.logo_dont_rules)}
          onChange={(e) => set("logo_dont_rules", splitCsv(e.target.value))}
          placeholder="不可旋转, 不可拉伸, 不可加阴影"
        />
      </div>
    </>
  );
}

function ColorFields({ v, set }: FieldProps) {
  const palette =
    (v.palette as Array<{ name?: string; hex?: string }>) ?? [];
  return (
    <>
      <div>
        <Label>palette（一行一个 hex，可加 "名称|#hex"）</Label>
        <Textarea
          value={palette
            .map((c) => (c.name ? `${c.name}|${c.hex ?? ""}` : c.hex ?? ""))
            .join("\n")}
          onChange={(e) => {
            const next = e.target.value
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .map((line) => {
                const [a, b] = line.split("|");
                const aTrim = (a ?? "").trim();
                return b ? { name: aTrim, hex: b.trim() } : { hex: aTrim };
              });
            set("palette", next);
          }}
          placeholder="primary|#0a0a0a"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>deviation_threshold (0–100)</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={(v.deviation_threshold as number) ?? 0}
            onChange={(e) =>
              set("deviation_threshold", Number(e.target.value))
            }
          />
        </div>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!v.allow_gradient}
            onChange={(e) => set("allow_gradient", e.target.checked)}
          />
          允许渐变
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="brightness_preference"
          value={(v.brightness_preference as string) ?? "neutral"}
          onChange={(val) => set("brightness_preference", val)}
          options={["light", "neutral", "dark"]}
        />
        <SelectField
          label="saturation_preference"
          value={(v.saturation_preference as string) ?? "medium"}
          onChange={(val) => set("saturation_preference", val)}
          options={["low", "medium", "high"]}
        />
      </div>
    </>
  );
}

function FontFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>primary_font</Label>
        <Input
          value={(v.primary_font as string) ?? ""}
          onChange={(e) => set("primary_font", e.target.value)}
        />
      </div>
      <div>
        <Label>fallback_fonts（逗号分隔）</Label>
        <Input
          value={joinCsv(v.fallback_fonts)}
          onChange={(e) => set("fallback_fonts", splitCsv(e.target.value))}
        />
      </div>
      <SelectField
        label="license_status"
        value={(v.license_status as string) ?? "UNKNOWN"}
        onChange={(val) => set("license_status", val)}
        options={["LICENSED", "FREE", "UNKNOWN", "RISK"]}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!v.allow_text_distortion}
          onChange={(e) => set("allow_text_distortion", e.target.checked)}
        />
        允许文字形变
      </label>
    </>
  );
}

function ProductFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>standard_angle（逗号分隔）</Label>
        <Input
          value={joinCsv(v.standard_angle)}
          onChange={(e) => set("standard_angle", splitCsv(e.target.value))}
          placeholder="3/4 front, top-down"
        />
      </div>
      <div>
        <Label>prohibited_angle（逗号分隔）</Label>
        <Input
          value={joinCsv(v.prohibited_angle)}
          onChange={(e) => set("prohibited_angle", splitCsv(e.target.value))}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["allow_crop", "允许裁切"],
            ["allow_occlusion", "允许遮挡"],
            ["allow_tilt", "允许倾斜"],
            ["allow_distortion", "允许形变"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!v[k]}
              onChange={(e) => set(k, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      <div>
        <Label>product_scale_rule</Label>
        <Input
          value={(v.product_scale_rule as string) ?? ""}
          onChange={(e) => set("product_scale_rule", e.target.value)}
        />
      </div>
    </>
  );
}

function CopyToneFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>tone_keywords（逗号分隔）</Label>
        <Input
          value={joinCsv(v.tone_keywords)}
          onChange={(e) => set("tone_keywords", splitCsv(e.target.value))}
          placeholder="温暖, 自信"
        />
      </div>
      <div>
        <Label>prohibited_words（逗号分隔）</Label>
        <Textarea
          value={joinCsv(v.prohibited_words)}
          onChange={(e) => set("prohibited_words", splitCsv(e.target.value))}
          placeholder="最, 第一, 国家级"
        />
      </div>
      <div>
        <Label>preferred_words（逗号分隔）</Label>
        <Input
          value={joinCsv(v.preferred_words)}
          onChange={(e) => set("preferred_words", splitCsv(e.target.value))}
        />
      </div>
      <div>
        <Label>cta_rule</Label>
        <Input
          value={(v.cta_rule as string) ?? ""}
          onChange={(e) => set("cta_rule", e.target.value)}
        />
      </div>
    </>
  );
}

function LayoutFields({ v, set }: FieldProps) {
  return (
    <>
      <SelectField
        label="alignment_preference"
        value={(v.alignment_preference as string) ?? "left"}
        onChange={(val) => set("alignment_preference", val)}
        options={["left", "center", "right", "justify"]}
      />
      <div>
        <Label>whitespace_ratio (0–1)</Label>
        <Input
          type="number"
          step="0.05"
          min={0}
          max={1}
          value={(v.whitespace_ratio as number) ?? 0}
          onChange={(e) => set("whitespace_ratio", Number(e.target.value))}
        />
      </div>
      <div>
        <Label>grid_system</Label>
        <Input
          value={(v.grid_system as string) ?? ""}
          onChange={(e) => set("grid_system", e.target.value)}
          placeholder="12 列 / 16px gutter"
        />
      </div>
    </>
  );
}

function GraphicFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>pattern_library（逗号分隔）</Label>
        <Input
          value={joinCsv(v.pattern_library)}
          onChange={(e) => set("pattern_library", splitCsv(e.target.value))}
          placeholder="圆角矩形, 斜切线"
        />
      </div>
      <div>
        <Label>shape_language</Label>
        <Input
          value={(v.shape_language as string) ?? ""}
          onChange={(e) => set("shape_language", e.target.value)}
          placeholder="几何 / 有机 / 手绘"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!v.allow_decoration}
          onChange={(e) => set("allow_decoration", e.target.checked)}
        />
        允许装饰
      </label>
      <div>
        <Label>prohibited_graphics（逗号分隔）</Label>
        <Textarea
          value={joinCsv(v.prohibited_graphics)}
          onChange={(e) => set("prohibited_graphics", splitCsv(e.target.value))}
          placeholder="禁用渐变描边, 禁用立体阴影"
        />
      </div>
    </>
  );
}

function ImageryFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>style_keywords（逗号分隔）</Label>
        <Input
          value={joinCsv(v.style_keywords)}
          onChange={(e) => set("style_keywords", splitCsv(e.target.value))}
          placeholder="自然光, 极简, 高对比"
        />
      </div>
      <div>
        <Label>lighting_rule</Label>
        <Input
          value={(v.lighting_rule as string) ?? ""}
          onChange={(e) => set("lighting_rule", e.target.value)}
          placeholder="柔和自然光，避免硬阴影"
        />
      </div>
      <div>
        <Label>composition_rule</Label>
        <Input
          value={(v.composition_rule as string) ?? ""}
          onChange={(e) => set("composition_rule", e.target.value)}
          placeholder="三分法构图，主体居中偏左"
        />
      </div>
      <div>
        <Label>prohibited_visuals（逗号分隔）</Label>
        <Textarea
          value={joinCsv(v.prohibited_visuals)}
          onChange={(e) => set("prohibited_visuals", splitCsv(e.target.value))}
          placeholder="禁用素材库通用图, 禁用过度滤镜"
        />
      </div>
    </>
  );
}

type ChannelPreset = {
  channel?: string;
  width?: number;
  height?: number;
  safe_zone?: string;
  notes?: string;
};

function ChannelSizeFields({ v, set }: FieldProps) {
  const presets = (v.presets as ChannelPreset[]) ?? [];
  const update = (i: number, patch: Partial<ChannelPreset>) => {
    const next = presets.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    set("presets", next);
  };
  return (
    <>
      <div>
        <Label>default_channels（逗号分隔）</Label>
        <Input
          value={joinCsv(v.default_channels)}
          onChange={(e) => set("default_channels", splitCsv(e.target.value))}
          placeholder="weibo, wechat, instagram"
        />
      </div>
      <div className="space-y-3">
        <Label>presets（渠道尺寸预设）</Label>
        {presets.map((p, i) => (
          <div
            key={i}
            className="space-y-2 rounded-xl border border-foreground/15 p-3"
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label>channel*</Label>
                <Input
                  value={p.channel ?? ""}
                  onChange={(e) => update(i, { channel: e.target.value })}
                  placeholder="instagram_post"
                />
              </div>
              <div>
                <Label>width</Label>
                <Input
                  type="number"
                  min={1}
                  value={p.width ?? ""}
                  onChange={(e) =>
                    update(i, {
                      width: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </div>
              <div>
                <Label>height</Label>
                <Input
                  type="number"
                  min={1}
                  value={p.height ?? ""}
                  onChange={(e) =>
                    update(i, {
                      height: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>safe_zone</Label>
                <Input
                  value={p.safe_zone ?? ""}
                  onChange={(e) => update(i, { safe_zone: e.target.value })}
                  placeholder="上下各留 64px"
                />
              </div>
              <div>
                <Label>notes</Label>
                <Input
                  value={p.notes ?? ""}
                  onChange={(e) => update(i, { notes: e.target.value })}
                />
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                set(
                  "presets",
                  presets.filter((_, idx) => idx !== i),
                )
              }
            >
              删除该预设
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => set("presets", [...presets, { channel: "" }])}
        >
          添加预设
        </Button>
      </div>
    </>
  );
}

type ProhibitionRuleEntry = {
  severity?: string;
  affectsGeneration?: boolean;
  affectsValidation?: boolean;
  description?: string;
  scope?: string[];
  positiveExampleAssetId?: string;
  negativeExampleAssetId?: string;
  alternativeSuggestion?: string;
  applicableChannels?: string[];
  status?: string;
};

function ProhibitionFields({ v, set }: FieldProps) {
  const rules = (v.rules as ProhibitionRuleEntry[]) ?? [];
  const update = (i: number, patch: Partial<ProhibitionRuleEntry>) => {
    const next = rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    set("rules", next);
  };
  return (
    <div className="space-y-3">
      <Label>rules（禁用规则）</Label>
      {rules.map((r, i) => (
        <div
          key={i}
          className="space-y-2 rounded-xl border border-foreground/15 p-3"
        >
          <div>
            <Label>description*</Label>
            <Input
              value={r.description ?? ""}
              onChange={(e) => update(i, { description: e.target.value })}
              placeholder="禁止在主体上叠加文字"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <SelectField
              label="severity*"
              value={r.severity ?? "HIGH"}
              onChange={(val) => update(i, { severity: val })}
              options={["HIGH", "MEDIUM", "LOW"]}
            />
            <SelectField
              label="status"
              value={r.status ?? "ACTIVE"}
              onChange={(val) => update(i, { status: val })}
              options={["ACTIVE", "INACTIVE", "PENDING"]}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={r.affectsGeneration ?? true}
                onChange={(e) =>
                  update(i, { affectsGeneration: e.target.checked })
                }
              />
              影响生成
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={r.affectsValidation ?? true}
                onChange={(e) =>
                  update(i, { affectsValidation: e.target.checked })
                }
              />
              影响校验
            </label>
          </div>
          <div>
            <Label>scope（逗号分隔）</Label>
            <Input
              value={joinCsv(r.scope)}
              onChange={(e) => update(i, { scope: splitCsv(e.target.value) })}
              placeholder="logo, product"
            />
          </div>
          <div>
            <Label>applicableChannels（逗号分隔）</Label>
            <Input
              value={joinCsv(r.applicableChannels)}
              onChange={(e) =>
                update(i, { applicableChannels: splitCsv(e.target.value) })
              }
              placeholder="weibo, wechat"
            />
          </div>
          <div>
            <Label>alternativeSuggestion</Label>
            <Input
              value={r.alternativeSuggestion ?? ""}
              onChange={(e) =>
                update(i, { alternativeSuggestion: e.target.value })
              }
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label>positiveExampleAssetId</Label>
              <Input
                value={r.positiveExampleAssetId ?? ""}
                onChange={(e) =>
                  update(i, { positiveExampleAssetId: e.target.value })
                }
              />
            </div>
            <div>
              <Label>negativeExampleAssetId</Label>
              <Input
                value={r.negativeExampleAssetId ?? ""}
                onChange={(e) =>
                  update(i, { negativeExampleAssetId: e.target.value })
                }
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              set(
                "rules",
                rules.filter((_, idx) => idx !== i),
              )
            }
          >
            删除该规则
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          set("rules", [
            ...rules,
            {
              severity: "HIGH",
              description: "",
              affectsGeneration: true,
              affectsValidation: true,
              scope: [],
              applicableChannels: [],
              status: "ACTIVE",
            },
          ])
        }
      >
        添加规则
      </Button>
    </div>
  );
}

type CommonAssetEntry = {
  assetId?: string;
  role?: string;
  notes?: string;
};

function CommonAssetFields({ v, set }: FieldProps) {
  const entries = (v.entries as CommonAssetEntry[]) ?? [];
  const update = (i: number, patch: Partial<CommonAssetEntry>) => {
    const next = entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
    set("entries", next);
  };
  return (
    <div className="space-y-3">
      <Label>entries（常用素材）</Label>
      {entries.map((e, i) => (
        <div
          key={i}
          className="grid gap-2 rounded-xl border border-foreground/15 p-3 sm:grid-cols-3"
        >
          <div>
            <Label>assetId*</Label>
            <Input
              value={e.assetId ?? ""}
              onChange={(ev) => update(i, { assetId: ev.target.value })}
            />
          </div>
          <div>
            <Label>role</Label>
            <Input
              value={e.role ?? ""}
              onChange={(ev) => update(i, { role: ev.target.value })}
              placeholder="吉祥物 / 背景"
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label>notes</Label>
              <Input
                value={e.notes ?? ""}
                onChange={(ev) => update(i, { notes: ev.target.value })}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                set(
                  "entries",
                  entries.filter((_, idx) => idx !== i),
                )
              }
            >
              删除
            </Button>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => set("entries", [...entries, { assetId: "" }])}
      >
        添加素材
      </Button>
    </div>
  );
}

function BrandProfileFields({ v, set }: FieldProps) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>industry</Label>
          <Input
            value={(v.industry as string) ?? ""}
            onChange={(e) => set("industry", e.target.value)}
            placeholder="消费电子 / 美妆"
          />
        </div>
        <div>
          <Label>voice</Label>
          <Input
            value={(v.voice as string) ?? ""}
            onChange={(e) => set("voice", e.target.value)}
            placeholder="自信、亲切"
          />
        </div>
      </div>
      <div>
        <Label>positioning</Label>
        <Input
          value={(v.positioning as string) ?? ""}
          onChange={(e) => set("positioning", e.target.value)}
          placeholder="高端但平易近人的科技品牌"
        />
      </div>
      <div>
        <Label>target_audience</Label>
        <Input
          value={(v.target_audience as string) ?? ""}
          onChange={(e) => set("target_audience", e.target.value)}
          placeholder="25-35 岁都市白领"
        />
      </div>
      <div>
        <Label>brand_personality（逗号分隔）</Label>
        <Input
          value={joinCsv(v.brand_personality)}
          onChange={(e) => set("brand_personality", splitCsv(e.target.value))}
          placeholder="可靠, 创新, 温暖"
        />
      </div>
    </>
  );
}

function AIConstraintFields({ v, set }: FieldProps) {
  return (
    <>
      <div>
        <Label>negative_prompt（逗号分隔）</Label>
        <Textarea
          value={joinCsv(v.negative_prompt)}
          onChange={(e) => set("negative_prompt", splitCsv(e.target.value))}
          placeholder="low quality, watermark, blurry"
        />
      </div>
      <div>
        <Label>required_elements（逗号分隔）</Label>
        <Input
          value={joinCsv(v.required_elements)}
          onChange={(e) => set("required_elements", splitCsv(e.target.value))}
          placeholder="品牌 Logo, 产品主体"
        />
      </div>
      <div>
        <Label>max_text_length（正整数，可留空）</Label>
        <Input
          type="number"
          min={1}
          value={(v.max_text_length as number | undefined) ?? ""}
          onChange={(e) =>
            set(
              "max_text_length",
              e.target.value ? Number(e.target.value) : undefined,
            )
          }
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!v.forbid_real_persons}
            onChange={(e) => set("forbid_real_persons", e.target.checked)}
          />
          禁止真实人物
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!v.forbid_celebrity_likeness}
            onChange={(e) =>
              set("forbid_celebrity_likeness", e.target.checked)
            }
          />
          禁止名人形象
        </label>
      </div>
    </>
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
  options: string[];
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-xl border border-foreground/15 bg-background px-3 text-sm"
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
