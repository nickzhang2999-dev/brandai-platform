"use client";

import { useEffect } from "react";

/**
 * Click-to-enlarge image overlay for the works gallery. No such primitive
 * existed — version cards previously showed only the cropped (object-cover)
 * thumbnail with no way to see the full image. Controlled: pass `src` to open,
 * `onClose` clears it. Closes on backdrop click or Esc; the image is shown
 * `object-contain` so nothing is cropped.
 */
export function Lightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string | null;
  alt?: string;
  caption?: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="关闭"
        className="absolute right-4 top-4 rounded-lg bg-white/10 px-3 py-1.5 text-lg leading-none text-white hover:bg-white/20"
        onClick={onClose}
      >
        ×
      </button>
      <figure
        className="flex max-h-full max-w-5xl flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ""}
          className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain shadow-2xl"
        />
        {caption ? (
          <figcaption className="text-center font-mono text-xs text-white/70">
            {caption}
          </figcaption>
        ) : null}
      </figure>
    </div>
  );
}
