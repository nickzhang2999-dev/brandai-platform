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
import { useAsyncTaskResult, type AsyncTaskReceipt, TASK_POLL_PAUSED_MESSAGE } from "@/lib/use-bounded-task-poll";
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
  const [receipt, setReceipt] = useState<{ workspaceId: string; taskId: string } | null>(null);
  const task = useAsyncTaskResult<ComplianceCheckResponse>(wsId, receipt?.workspaceId === wsId ? receipt.taskId : null);
  const pending = !!receipt && receipt.workspaceId === wsId && !["SUCCEEDED", "FAILED"].includes(task.data?.status ?? "");

  const check = useMutation({
    mutationFn: async () => ({ workspaceId: wsId, ...await apiFetch<AsyncTaskReceipt>(
        `/api/workspaces/${wsId}/compliance/precheck`,
        {
          method: "POST",
          body: JSON.stringify({ workspaceId: wsId, text }),
        },
      ) }),
    onSuccess: setReceipt,
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
            disabled={!text.trim() || check.isPending || pending}
            onClick={() => {
              setError(null);
              check.mutate();
            }}
          >
            {check.isPending || pending && !task.timedOut && !task.error ? <Spinner /> : null}
            运行校验
          </Button>
        </div>
      </Panel>

      {pending ? <p role="status" className="text-sm text-muted-foreground">{task.timedOut ? TASK_POLL_PAUSED_MESSAGE : task.error ? "暂时无法读取校验状态，原任务仍保留。" : "校验已受理，可离开后从队列查看。"} {(task.timedOut || task.error) && <button type="button" className="underline" onClick={task.resume}>继续查询原任务</button>}</p> : null}
      {task.data?.status === "FAILED" ? <p role="alert" className="text-sm text-destructive">{task.data.error || "校验失败"}</p> : null}

      {task.data?.status === "SUCCEEDED" && task.data.result ? (
        <ComplianceReportView report={task.data.result.report} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-14 text-center">
          <FieldLabel className="text-accent">RESULT · 校验报告</FieldLabel>
          <p className="font-serif text-lg text-foreground/80">
            {pending ? "正在准备校验报告" : task.data?.status === "FAILED" ? "本次校验未完成" : "尚未运行预检"}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            粘贴文案并运行校验，违禁词与广告法风险会在这里成型，并给出替代表达。
          </p>
        </div>
      )}
    </div>
  );
}
