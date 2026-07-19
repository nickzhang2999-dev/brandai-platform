"use client";

import { useEffect } from "react";

function looksLikeCdsPreviewToolbar(el: HTMLElement) {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.position !== "fixed" && style.position !== "sticky") return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 20 || rect.height > 90) return false;
  if (rect.left > 520) return false;
  if (window.innerHeight - rect.bottom > 96) return false;

  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  const hasDeployText = text.includes("发布") || text.includes("部署");
  const hasBranchText =
    text.includes("brandai-") ||
    text.includes("codex/") ||
    text.includes("main") ||
    text.includes("branch");
  const hasCommitHash = /\b[0-9a-f]{7,12}\b/i.test(text);

  return hasDeployText && (hasBranchText || hasCommitHash);
}

function hideCdsPreviewToolbar() {
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    if (!looksLikeCdsPreviewToolbar(el)) continue;
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("display", "none", "important");
  }
}

export function CdsPreviewToolbarGuard() {
  useEffect(() => {
    hideCdsPreviewToolbar();
    const observer = new MutationObserver(() => hideCdsPreviewToolbar());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
