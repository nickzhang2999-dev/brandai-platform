"use client";

import { useState } from "react";
import type { AdminPlanSummary } from "@brandai/contracts";
import { Badge, Button, CreamCard, Input, Spinner } from "@brandai/ui";

/** -1 renders as ∞ (unlimited); everything else as the plain number. */
function fmtLimit(n: number): string {
  return n < 0 ? "∞" : String(n);
}

function fmtPrice(cents: number): string {
  return cents === 0 ? "免费" : `$${(cents / 100).toFixed(0)}/月`;
}

/**
 * Coerce a quota input string to an integer ≥ -1, or null when it is blank /
 * whitespace / non-integer / below -1. Returning null for "" (rather than
 * letting `Number("")` collapse to 0) is what stops a cleared field from
 * silently saving a tier-wide 0 quota.
 */
function parseField(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const v = Number(s);
  if (!Number.isInteger(v) || v < -1) return null;
  return v;
}

interface Draft {
  name: string;
  dailyGenerationLimit: string;
  monthlyGenerationQuota: string;
  maxWorkspaces: string;
}

function toDraft(p: AdminPlanSummary): Draft {
  return {
    name: p.name,
    dailyGenerationLimit: String(p.dailyGenerationLimit),
    monthlyGenerationQuota: String(p.monthlyGenerationQuota),
    maxWorkspaces: String(p.maxWorkspaces),
  };
}

export function PlansTable({ initial }: { initial: AdminPlanSummary[] }) {
  const [plans, setPlans] = useState<AdminPlanSummary[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(p: AdminPlanSummary) {
    setError(null);
    setEditing(p.tier);
    setDraft(toDraft(p));
  }

  function cancel() {
    setEditing(null);
    setDraft(null);
    setError(null);
  }

  async function save(tier: string) {
    if (!draft) return;
    // Parse the three numeric fields; a blank / whitespace / non-integer input
    // is rejected BEFORE we hit the network so the admin gets an immediate,
    // local error. `parseField` returns null for an empty string — critical,
    // because `Number("")` is `0`, and a silent 0 would be a *valid* quota that
    // instantly disables generation for the whole tier.
    const daily = parseField(draft.dailyGenerationLimit);
    const monthly = parseField(draft.monthlyGenerationQuota);
    const workspaces = parseField(draft.maxWorkspaces);
    if (daily === null || monthly === null || workspaces === null) {
      setError("日额度 / 月额度 / 品牌上限均需填 ≥ -1 的整数(-1 = 不限,不能留空)");
      return;
    }
    if (!draft.name.trim()) {
      setError("套餐名不能为空");
      return;
    }
    const nums = {
      dailyGenerationLimit: daily,
      monthlyGenerationQuota: monthly,
      maxWorkspaces: workspaces,
    };

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/plans/${tier}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft.name.trim(), ...nums }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `操作失败 (${res.status})`);
      if (Array.isArray(body?.plans)) {
        setPlans(body.plans as AdminPlanSummary[]);
      }
      cancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        额度即时生效——无有效订阅的账号(含所有设计师)默认走{" "}
        <span className="font-mono">STARTER</span> 档,改这里就是改他们的默认额度。
        <span className="font-mono">-1</span> 表示不限(∞)。
      </p>

      <CreamCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-foreground/10 text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-5 py-3 font-medium">日额度</th>
              <th className="px-5 py-3 font-medium">月额度</th>
              <th className="px-5 py-3 font-medium">品牌上限</th>
              <th className="px-5 py-3 font-medium">价格</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const isEditing = editing === p.tier;
              return (
                <tr
                  key={p.tier}
                  className="border-b border-foreground/5 align-middle last:border-0"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                      {p.tier}
                      {p.tier === "STARTER" ? (
                        <Badge tone="strong">默认</Badge>
                      ) : null}
                    </div>
                    {isEditing && draft ? (
                      <Input
                        className="mt-1 h-7 w-40"
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                        aria-label="套餐名"
                      />
                    ) : (
                      <div className="text-sm font-medium text-foreground">
                        {p.name}
                      </div>
                    )}
                  </td>

                  {isEditing && draft ? (
                    <>
                      <td className="px-5 py-4">
                        <Input
                          type="number"
                          className="h-8 w-24 tabular-nums"
                          value={draft.dailyGenerationLimit}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              dailyGenerationLimit: e.target.value,
                            })
                          }
                          aria-label="日额度"
                        />
                      </td>
                      <td className="px-5 py-4">
                        <Input
                          type="number"
                          className="h-8 w-24 tabular-nums"
                          value={draft.monthlyGenerationQuota}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              monthlyGenerationQuota: e.target.value,
                            })
                          }
                          aria-label="月额度"
                        />
                      </td>
                      <td className="px-5 py-4">
                        <Input
                          type="number"
                          className="h-8 w-24 tabular-nums"
                          value={draft.maxWorkspaces}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              maxWorkspaces: e.target.value,
                            })
                          }
                          aria-label="品牌上限"
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-5 py-4 tabular-nums">
                        {fmtLimit(p.dailyGenerationLimit)}
                        <span className="text-xs text-muted-foreground">/日</span>
                      </td>
                      <td className="px-5 py-4 tabular-nums">
                        {fmtLimit(p.monthlyGenerationQuota)}
                        <span className="text-xs text-muted-foreground">/月</span>
                      </td>
                      <td className="px-5 py-4 tabular-nums">
                        {fmtLimit(p.maxWorkspaces)}
                      </td>
                    </>
                  )}

                  <td className="px-5 py-4 font-mono text-xs text-muted-foreground">
                    {fmtPrice(p.priceCentsMonthly)}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {isEditing ? (
                        <>
                          {busy ? <Spinner /> : null}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={cancel}
                          >
                            取消
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busy}
                            onClick={() => save(p.tier)}
                          >
                            保存
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={editing !== null}
                          onClick={() => startEdit(p)}
                        >
                          编辑额度
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {plans.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-10 text-center text-sm text-muted-foreground"
                >
                  暂无套餐(数据库未初始化 Plan 表)
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CreamCard>
    </div>
  );
}
