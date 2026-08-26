#!/usr/bin/env python3
"""BrandAI 预览验收地址生成器 —— 迁移自 prd_agent 的 preview-url 技能。

唯一职责:把「当前 git 分支」翻译成 CDS 灰度预览域名,供人工/UAT 验收。

预览 slug 是 SSOT 公式(v3,与 prd_agent cds preview-slug.ts 完全一致):
    {tail}-{prefix}-{projectSlug}
其中 prefix = 分支名第一个 `/` 之前的段(claude/feat/fix...),tail = 之后的段,
projectSlug = 仓库根目录名(= CDS 项目 slug,本仓库为 brandai-platform)。
预览根域 = CDS_HOST 去掉前缀 `cds.`(cds.geole.me → geole.me)。

决策顺序:
  1) 有 CDS_HOST + (AI_ACCESS_KEY 或 CDS_PROJECT_KEY) → GET /api/branches 找
     previewSlug 与本地公式一致的分支,直接采用后端字段(永不漂移)。
  2) 无 CDS 凭据 / API 异常 / 分支未部署 → 用本地公式推算(同 SSOT)。
  3) 不在 git 仓库 / detached HEAD → 退出码 1。

任何脚本/文档/commit 都不得自己 slugify 或手拼域名,一律调本脚本。
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

# BrandAI 的 CDS 是 cds.geole.me、预览根域 geole.me(与全局/沙箱 CDS_HOST 无关——
# 沙箱里的 CDS_HOST 可能指向别的实例,本仓库技能锚定 BrandAI 自己的 CDS)。
DEFAULT_CDS_HOST = "https://cds.geole.me"
DEFAULT_PREVIEW_ROOT = "geole.me"
DEFAULT_PROJECT_ID = "a8a098f7193a"  # CDS 项目 brandai-platform


def _run(args):
    return subprocess.run(
        args, capture_output=True, text=True, check=False
    ).stdout.strip()


def _git_branch():
    b = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if not b or b == "HEAD":
        sys.exit("不在 git 仓库内或处于 detached HEAD,无法解析分支。请先 git checkout 一个分支。")
    return b


def _repo_root():
    root = _run(["git", "rev-parse", "--show-toplevel"])
    if not root:
        sys.exit("无法定位 git 仓库根目录。")
    return root


def slugify(s: str) -> str:
    """与 cds preview-slug.ts:slugifyForPreview 完全一致。"""
    s = s.lower()
    s = re.sub(r"[^a-z0-9-]+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def compute_preview_slug(branch: str, project_slug: str) -> str:
    """v3:{tail}-{prefix}-{projectSlug}(prefix/tail 缺一时优雅降级)。"""
    project = slugify(project_slug)
    if not branch:
        return project
    cut = branch.find("/")
    if cut < 0:
        tail = slugify(branch)
        return f"{tail}-{project}" if tail else project
    prefix = slugify(branch[:cut])
    tail = slugify(branch[cut + 1:])
    if not prefix:
        return f"{tail}-{project}" if tail else project
    if not tail:
        return f"{prefix}-{project}"
    return f"{tail}-{prefix}-{project}"


def preview_root() -> str:
    """预览根域:仅 CDS_PREVIEW_ROOT 显式覆盖,否则锚定 BrandAI 的 geole.me
    (不读取沙箱全局 CDS_HOST——它可能指向别的 CDS 实例,会把根域拼错)。"""
    return os.environ.get("CDS_PREVIEW_ROOT", "").strip() or DEFAULT_PREVIEW_ROOT


def _auth():
    pk = os.environ.get("CDS_PROJECT_KEY", "").strip()
    if pk:
        return pk
    return os.environ.get("AI_ACCESS_KEY", "").strip()


def _backend_preview(branch: str, branch_slug: str):
    """去 CDS 取**这条分支自己的** previewUrl;任何异常返回 None(走本地公式)。

    2026-08-25 修:原实现只认 `previewSlug == 本地算出来的 slug`。分支名一长,
    后端会把 slug 截断并加哈希后缀(DNS label 上限 63)——本地公式算不出那个哈希,
    匹配必然落空,于是**静默回落到本地拼出来的域名**,而那个域名根本不存在(502)。
    交付里贴出去的就是一条死链,且看起来完全正常。

    现在按 `branch`(git 分支名,后端权威字段)匹配,直接用记录里的 previewUrl。
    """
    # 锚定 BrandAI 的 CDS;只有显式指向 geole 的 CDS_HOST 才覆盖(沙箱全局
    # CDS_HOST 可能是别的实例,用它查会查不到本项目分支)。
    host = os.environ.get("CDS_HOST", "").strip().rstrip("/")
    if "geole" not in host:
        host = DEFAULT_CDS_HOST
    key = _auth()
    if not key:
        return None
    if "://" not in host:
        host = "https://" + host
    pid = os.environ.get("CDS_PROJECT_ID", DEFAULT_PROJECT_ID).strip()
    # 带 ?projectId= 查询在通用 AI_ACCESS_KEY 下会 403(那条路要项目级 key),
    # 而不带过滤的全量查询是通的。所以先试带过滤,失败就退回全量再按分支匹配——
    # 原实现只试第一条,一 403 就静默回落到本地公式,于是永远拿不到后端地址。
    candidates = [f"{host}/api/branches" + (f"?projectId={pid}" if pid else "")]
    if pid:
        candidates.append(f"{host}/api/branches")
    data = None
    for url in candidates:
        try:
            # 必须带一个正常 User-Agent:预览域挂在 Cloudflare 后面,默认的
            # "Python-urllib/3.x" 会被直接 403,而 curl 同样的 key 却通——
            # 这正是本函数长期静默回落到本地公式的真实原因。
            req = urllib.request.Request(
                url,
                headers={
                    "X-AI-Access-Key": key,
                    "User-Agent": "brandai-preview-url/1.0",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
                data = json.load(r)
            break
        except Exception:
            continue
    if data is None:
        return None
    branches = data if isinstance(data, list) else data.get("branches", data.get("data", []))
    if not isinstance(branches, list):
        return None

    def _same_project(b):
        """全量列表里必须按项目过滤,否则会捡到别人家的同名分支。

        实测 `/api/branches` 不带过滤时返回 52 条、横跨十几个 CDS 项目,其中
        `branch == "main"` 就有四条(prd-agent / mdimp / mytapd / metersphere…)。
        只按分支名匹配的话,本仓库一旦发生在 main 上取地址,拿到的是**别的项目**
        的 previewUrl —— 它长得完全正常,于是交付里贴出去的、冒烟打过去的,都是
        另一个应用。
        """
        if not pid:
            return True
        got = b.get("projectId") or b.get("projectSlug") or ""
        # 记录没带项目字段就不敢认(宁可回落到"未确认"的告警路径)。
        return bool(got) and str(got) == pid

    # 优先按 git 分支名匹配(权威);兼容旧行为再按 previewSlug 兜一手。
    for key in ("branch", "previewSlug"):
        want = branch if key == "branch" else branch_slug
        for b in branches:
            if not isinstance(b, dict) or b.get(key) != want:
                continue
            if not _same_project(b):
                continue
            url = (b.get("previewUrl") or "").strip()
            if url:
                return url.rstrip("/") + "/"
            slug = (b.get("previewSlug") or "").strip()
            if slug:
                return f"https://{slug}.{preview_root()}/"
    return None


def main():
    branch = _git_branch()
    project_slug = (
        os.environ.get("CDS_PROJECT_SLUG", "").strip()
        or os.path.basename(_repo_root())
    )
    slug = compute_preview_slug(branch, project_slug)
    backend = _backend_preview(branch, slug)
    if backend:
        print(backend)
        return
    # 后端没有这条分支的记录(或取不到凭据)。本地公式只是猜测,分支名一长就会
    # 猜错——如实说明,不要让调用方把它当成已发布地址贴进交付。
    print(
        "[preview-url] 警告:CDS 没有返回这条分支的 previewUrl,下面是本地公式的推算值,"
        "未经后端确认,分支名较长时很可能不存在。",
        file=sys.stderr,
    )
    print(f"https://{slug}.{preview_root()}/")


if __name__ == "__main__":
    main()
