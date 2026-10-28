/** UTF-16 offsets match native textarea selectionStart/selectionEnd and String.slice. */
export type WritingSelection = { start: number; end: number; text: string; revision: number };

export function captureSelection(body: string, start: number, end: number, revision: number): WritingSelection | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length) return null;
  return { start, end, text: body.slice(start, end), revision };
}

export function selectionIsCurrent(selection: WritingSelection, body: string, revision: number): boolean {
  return selection.revision === revision && selection.start >= 0 && selection.end > selection.start &&
    selection.end <= body.length && body.slice(selection.start, selection.end) === selection.text;
}

export function applySelection(selection: WritingSelection, body: string, revision: number, replacement: string): string {
  if (!selectionIsCurrent(selection, body, revision)) throw new Error("正文已变化，请重新选中文字生成修改建议。");
  return body.slice(0, selection.start) + replacement + body.slice(selection.end);
}

export function writingScope(userId: string, workspaceId: string, projectId: string): string {
  return `novart:writing-workbench:${JSON.stringify([userId, workspaceId, projectId])}`;
}

export async function writingFetch(url: string, init: RequestInit = {}, timeout = 20000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, signal: controller.signal });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = response.status === 409 ? "服务端内容已更新，请核对最新版本后继续。你的修改仍保留。" :
        response.status === 401 ? "登录已过期，请重新登录；当前修改仍保留。" :
        response.status === 403 ? "当前账号没有此操作权限。" :
        response.status === 413 ? "文件过大，请缩小后重新添加。" :
        response.status === 429 ? "请求较多，请稍后再试。" : "操作暂未完成，请稍后刷新状态。";
      throw Object.assign(new Error(message), { status: response.status });
    }
    return data;
  } finally { clearTimeout(timer); }
}
