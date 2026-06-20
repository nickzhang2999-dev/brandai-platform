import type { CampaignStatusKey } from "@/lib/brandai-mock";
import { statusMeta } from "@/lib/brandai-mock";

/**
 * 真实实体没有"封面渐变"，按 id/名称确定性地生成一个紫系渐变，让卡片缩略图保持
 * 原型的视觉质感（同一实体每次渲染一致）。
 */
const GRADIENTS = [
  "linear-gradient(135deg,#8B6CFF,#C9B6FF)",
  "linear-gradient(135deg,#7C5CFF,#A88CFF)",
  "linear-gradient(135deg,#5B3FE0,#8B6CFF)",
  "linear-gradient(135deg,#8B6CFF,#FFC8D6)",
  "linear-gradient(135deg,#5B3FE0,#9CE0FF)",
  "linear-gradient(135deg,#7C5CFF,#FFD6E0)",
  "linear-gradient(135deg,#8B6CFF,#B6E3FF)",
  "linear-gradient(135deg,#3A2A7A,#C9B6FF)",
];

export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length]!;
}

/** 全圆 chip（标签/渠道）。 */
export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/** Campaign 状态徽章（草稿/进行中/已完成 三态配色）。 */
export function StatusBadge({ status }: { status: CampaignStatusKey }) {
  const s = statusMeta[status];
  const map: Record<string, string> = {
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[s.tone] ?? map.primary}`}>
      {s.label}
    </span>
  );
}

/** 紫色渐变进度条。 */
export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground">{value}%</span>
    </div>
  );
}

/** 页面标题区。 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[34px] font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
