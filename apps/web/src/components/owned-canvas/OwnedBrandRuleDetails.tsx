"use client";

import { useEffect, useState } from "react";
import type { StudioAppliedBrandRule } from "@brandai/contracts";
import type { createOwnedEditorApi } from "./owned-editor-api";

const typeLabels: Record<StudioAppliedBrandRule["type"], string> = {
  logo: "标志", color: "色彩", font: "字体", copy: "文案",
  imagery: "影像", layout: "版式", graphic: "图形",
};

export function OwnedBrandRuleList({ rules }: { rules: StudioAppliedBrandRule[] }) {
  return (
    <ul className="max-h-36 space-y-1.5 overflow-y-auto">
      {rules.map(rule => (
        <li key={rule.id} className="rounded-xl bg-accent-soft px-2.5 py-1.5">
          <p className="break-words text-xs leading-5">{rule.summary}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{typeLabels[rule.type]}</span>
            {rule.colors?.map(hex => (
              <span key={hex} className="inline-flex items-center gap-1">
                <span aria-hidden="true" className="h-3 w-3 rounded-sm border border-border" style={{ backgroundColor: hex }} />{hex}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

type PreviewApi = Pick<ReturnType<typeof createOwnedEditorApi>, "readBrandRulePreview">;
type Preview = { api: PreviewApi; rules: StudioAppliedBrandRule[] | null };

export function OwnedBrandRulePreview({ api }: { api: PreviewApi | null }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") setRevision(value => value + 1);
    }
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let current = true;
    setPreview(null);
    api.readBrandRulePreview().then(
      ({ rules }) => { if (current) setPreview({ api, rules }); },
      () => { if (current) setPreview({ api, rules: null }); },
    );
    return () => { current = false; };
  }, [api, revision]);

  const result = preview?.api === api ? preview : null;
  const rules = result?.rules;
  const caption = rules?.length
    ? `预计自动带入 ${rules.length} 条品牌规则`
    : rules ? "本轮无品牌规则" : result ? "品牌规则暂未读取" : "正在读取品牌规则…";

  return (
    <details open className="rounded-xl border border-border px-2.5 py-2 text-xs" data-testid="owned-brand-rule-preview">
      <summary className="cursor-pointer font-medium">{caption}</summary>
      <div className="mt-2 space-y-1.5">
        {rules?.length ? <OwnedBrandRuleList rules={rules} /> : rules
          ? <p className="text-muted-foreground">当前没有可自动带入的品牌规则，可以直接发送。</p>
          : result && <p className="text-muted-foreground">预览读取失败。发送时仍会读取服务端的规则。</p>}
        {result && (
          <div className="flex flex-wrap items-center justify-between gap-1">
            {!!rules?.length && <p className="text-muted-foreground">以生成时确认的品牌规则为准。</p>}
            <button type="button" className="text-primary underline" onClick={refresh}>刷新规则</button>
          </div>
        )}
      </div>
    </details>
  );
}
