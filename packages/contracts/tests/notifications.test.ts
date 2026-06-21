/**
 * A3 / L3 — notification center wire format. Notifications are derived (not
 * persisted): the read endpoint shapes terminal AsyncTask + Generation rows
 * into these. Pins the kind/status enums + the optional/null boundary so the
 * BFF producer and the inbox UI stay in agreement.
 */
import { describe, expect, it } from "vitest";
import {
  NotificationItem,
  NotificationKind,
  NotificationStatus,
  NotificationsResponse,
  BrandWorkspace,
} from "../src/index";

describe("L3 · NotificationKind / NotificationStatus", () => {
  it("kind covers every terminal source event", () => {
    for (const k of [
      "GENERATE",
      "EDIT",
      "RECOGNIZE",
      "PARSE_MANUAL",
      "DESCRIBE",
      "INGEST",
    ]) {
      expect(NotificationKind.safeParse(k).success).toBe(true);
    }
    expect(NotificationKind.safeParse("UNKNOWN").success).toBe(false);
  });

  it("status is terminal-only (no PENDING/RUNNING)", () => {
    expect(NotificationStatus.safeParse("SUCCEEDED").success).toBe(true);
    expect(NotificationStatus.safeParse("FAILED").success).toBe(true);
    expect(NotificationStatus.safeParse("PENDING").success).toBe(false);
    expect(NotificationStatus.safeParse("RUNNING").success).toBe(false);
  });
});

describe("L3 · NotificationItem", () => {
  const base = {
    id: "gen:abc",
    kind: "GENERATE",
    status: "SUCCEEDED",
    title: "出图完成 · 社交海报",
    createdAt: "2026-06-20T00:00:00.000Z",
  };

  it("parses a minimal item", () => {
    expect(NotificationItem.safeParse(base).success).toBe(true);
  });

  it("accepts optional detail/href (string or null)", () => {
    expect(
      NotificationItem.safeParse({
        ...base,
        detail: "AI provider 超时",
        href: "/workspace",
      }).success,
    ).toBe(true);
    expect(
      NotificationItem.safeParse({ ...base, detail: null, href: null }).success,
    ).toBe(true);
  });

  it("requires title + createdAt + a valid kind/status", () => {
    expect(NotificationItem.safeParse({ ...base, title: undefined }).success).toBe(
      false,
    );
    expect(NotificationItem.safeParse({ ...base, kind: "NOPE" }).success).toBe(
      false,
    );
  });

  it("NotificationsResponse defaults nothing but accepts an empty list", () => {
    expect(NotificationsResponse.parse({ items: [] }).items).toEqual([]);
  });
});

describe("L2 · recommended brands reuse BrandWorkspace shape", () => {
  it("a verified showcase brand parses as BrandWorkspace", () => {
    const r = BrandWorkspace.safeParse({
      id: "w1",
      ownerId: "u1",
      name: "示例品牌",
      createdAt: "2026-06-20T00:00:00.000Z",
      subtitle: "清透护肤",
      coverImage: "http://x/y.png",
      tags: ["护肤", "国货"],
      isVerified: true,
      slogan: "自然光感",
    });
    expect(r.success).toBe(true);
  });
});
