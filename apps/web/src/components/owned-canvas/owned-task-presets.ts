import type { ProjectContextDraft } from "./owned-project-context-session";

/** User-selected starting points, not confirmed facts or automatic workflows. */
export const OWNED_TASK_PRESETS = [
  { id: "product", name: "产品主图", goal: "制作产品主图，清楚展示产品及核心卖点。", visualRequirements: "保留产品外形、包装与品牌标识；主体清晰，背景服务于产品展示。" },
  { id: "advertising", name: "广告海报", goal: "制作广告海报，让受众快速理解主题与核心信息。", visualRequirements: "突出主标题、产品与行动信息的层级；准确保留已确认文案，适配投放画幅。" },
  { id: "packaging", name: "包装设计", goal: "探索产品包装的视觉方案，并形成可延展的系列方向。", visualRequirements: "保持品牌与产品信息清晰，区分系列变化；未提供的尺寸、刀模和法定文字留待确认。" },
] as const;
export function applyOwnedTaskPreset(draft: ProjectContextDraft, id: string): ProjectContextDraft {
  const preset = OWNED_TASK_PRESETS.find(item => item.id === id);
  if (!preset) return draft;
  return { ...draft, facts: { ...draft.facts, goal: draft.facts.goal.trim() ? draft.facts.goal : preset.goal,
    visualRequirements: draft.facts.visualRequirements.trim() ? draft.facts.visualRequirements : preset.visualRequirements } };
}
