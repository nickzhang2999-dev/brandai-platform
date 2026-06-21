"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * H1 · 统一 AI 输入框组件 —— BrandAI 紫色 AI 输入条（32px 圆角，§0.6）。
 *
 * 一处可复用的「AI 共创输入」原语：紫染软阴影圆角条 + 文本域 + 右侧动作槽，
 * 内建两个真实入口：
 *   • 附件按钮（file input）—— 把文件交回宿主（如品牌知识库把 PDF 当 VI 资料
 *     上传后触发真实 parse-manual 解析）。
 *   • 语音按钮（浏览器 Web Speech API，真实 client-side 语音转文字）—— 识别结果
 *     追加进输入框；浏览器不支持时按钮自动隐藏（graceful degrade），绝不假装可用。
 *
 * 组件本身不发任何网络请求——它只负责采集「文本 + 附件 + 语音」，由宿主决定语义
 * （知识库走 AI 共创，首页后续也可复用同一条）。这样 §2 的"慢调用不在组件里 await"
 * 天然成立：宿主拿到回调后才去走 server-authoritative 异步管线。
 */

// 浏览器语音识别（webkit 前缀兜底）。SSR 安全：仅在 effect/handler 里读 window。
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};
function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type AIInputProps = {
  value: string;
  onChange: (next: string) => void;
  /** Enter（不带 Shift）或主动作时触发；附 attachment 可选透传给宿主。 */
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** 选择附件时回调（宿主决定如何处理，如上传成 VI_DOC 触发 parse-manual）。 */
  onAttach?: (file: File) => void;
  /** 附件 input 的 accept（默认接受图片与 PDF）。 */
  attachAccept?: string;
  /** 主操作按钮（如「添加规则」「AI 解析」），由宿主放在右下。 */
  primaryAction?: React.ReactNode;
  /** 左下角的次级控件（如类型选择 select），由宿主放置。 */
  leftControls?: React.ReactNode;
  /** 顶部插槽（如快捷提示词 chip 行）。 */
  topSlot?: React.ReactNode;
  /** 语音识别语言（默认中文）。 */
  speechLang?: string;
};

export function AIInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 2,
  disabled = false,
  onAttach,
  attachAccept = "image/*,application/pdf",
  primaryAction,
  leftControls,
  topSlot,
  speechLang = "zh-CN",
}: AIInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  // keep latest value/onChange for the recognition closure
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setVoiceSupported(!!getSpeechRecognitionCtor());
    return () => {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceErr(null);
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = speechLang;
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e: unknown) => {
      // SpeechRecognitionEvent — pull the final transcript defensively.
      const ev = e as {
        results?: ArrayLike<ArrayLike<{ transcript?: string }>>;
      };
      let transcript = "";
      const results = ev.results;
      if (results) {
        for (let i = 0; i < results.length; i++) {
          const alt = results[i]?.[0];
          if (alt?.transcript) transcript += alt.transcript;
        }
      }
      transcript = transcript.trim();
      if (transcript) {
        const cur = valueRef.current;
        const next = cur ? `${cur}${cur.endsWith(" ") ? "" : " "}${transcript}` : transcript;
        onChangeRef.current(next);
      }
    };
    rec.onerror = (e: unknown) => {
      const err = (e as { error?: string })?.error;
      setVoiceErr(
        err === "not-allowed" || err === "service-not-allowed"
          ? "麦克风权限被拒绝"
          : "语音识别出错，请重试",
      );
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setVoiceErr("无法启动语音识别");
      setListening(false);
    }
  }, [listening, speechLang]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 rounded-[32px] border border-primary/15 bg-card p-4 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
        {topSlot}
        <textarea
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={rows}
          placeholder={placeholder}
          className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {/* 附件入口 */}
            {onAttach ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={attachAccept}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onAttach(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-label="添加附件"
                  title="上传品牌资料（图片 / PDF）"
                  disabled={disabled}
                  onClick={() => fileRef.current?.click()}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent-soft hover:text-primary disabled:opacity-60"
                >
                  📎
                </button>
              </>
            ) : null}
            {/* 语音入口 —— 不支持则不渲染（graceful degrade） */}
            {voiceSupported ? (
              <button
                type="button"
                aria-label={listening ? "停止语音输入" : "语音输入"}
                aria-pressed={listening}
                title="语音转文字"
                disabled={disabled}
                onClick={toggleVoice}
                className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors disabled:opacity-60 ${
                  listening
                    ? "border-primary bg-accent-soft text-primary ring-2 ring-primary/40"
                    : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent-soft hover:text-primary"
                }`}
              >
                {listening ? "■" : "🎤"}
              </button>
            ) : null}
            {leftControls}
          </div>
          {primaryAction}
        </div>
      </div>
      {listening ? (
        <p className="px-2 text-[11px] text-primary">正在聆听… 说完会自动转写</p>
      ) : null}
      {voiceErr ? (
        <p className="px-2 text-[11px] text-destructive">{voiceErr}</p>
      ) : null}
    </div>
  );
}
