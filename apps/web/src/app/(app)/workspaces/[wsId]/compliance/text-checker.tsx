"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ComplianceCheckResponse } from "@brandai/contracts";
import {
  Button,
  FieldLabel,
  Panel,
  SectionHeading,
  Spinner,
  Textarea,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { ComplianceReportView } from "@/components/compliance-report";

/**
 * M5 · 文案合规自检 — paste copy, run the workspace precheck endpoint
 * (the same `POST /compliance/precheck` M3 uses) and render the structured
 * 通过 / 风险 / 建议 report. Term-library findings + the广告法 lexicon
 * (绝对化 / 功效 / 夸大 / 权威) come back from the AI service.
 */
export function TextChecker({ wsId }: { wsId: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: () =>
      apiFetch<ComplianceCheckResponse>(
        `/api/workspaces/${wsId}/compliance/precheck`,
        {
          method: "POST",
          body: JSON.stringify({ workspaceId: wsId, text }),
        },
      ),
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "校验失败"),
  });

  return (
    <div className="flex flex-col gap-6">
      <Panel className="flex flex-col gap-6">
        <SectionHeading eyebrow="PRECHECK · 文案预检" title="文案合规校验" />
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          粘贴待校验文案，识别违禁词 / 绝对化用语 / 功效承诺 / 夸大收益 /
          权威背书，给出风险等级与替代表达。
        </p>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>待校验文案</FieldLabel>
          <Textarea
            className="min-h-32"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：本品功效第一，国家级认证，效果最佳……"
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        <div>
          <Button
            size="sm"
            disabled={!text.trim() || check.isPending}
            onClick={() => {
              setError(null);
              check.mutate();
            }}
          >
            {check.isPending ? <Spinner /> : null}
            运行校验
          </Button>
        </div>
      </Panel>

      {check.data ? (
        <ComplianceReportView report={check.data.report} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-14 text-center">
          <FieldLabel className="text-accent">RESULT · 校验报告</FieldLabel>
          <p className="font-serif text-lg text-foreground/80">
            尚未运行预检
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            粘贴文案并运行校验，违禁词与广告法风险会在这里成型，并给出替代表达。
          </p>
        </div>
      )}
    </div>
  );
}
