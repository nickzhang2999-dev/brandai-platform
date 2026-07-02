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


def _backend_slug(branch_slug: str):
    """有凭据时去 CDS 确认/取后端 previewSlug;任何异常返回 None(走本地公式)。"""
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
    url = f"{host}/api/branches" + (f"?projectId={pid}" if pid else "")
    try:
        req = urllib.request.Request(url, headers={"X-AI-Access-Key": key})
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
            data = json.load(r)
    except Exception:
        return None
    branches = data if isinstance(data, list) else data.get("branches", data.get("data", []))
    if not isinstance(branches, list):
        return None
    for b in branches:
        if isinstance(b, dict) and b.get("previewSlug") == branch_slug:
            return b.get("previewSlug")
    return None


def main():
    branch = _git_branch()
    project_slug = (
        os.environ.get("CDS_PROJECT_SLUG", "").strip()
        or os.path.basename(_repo_root())
    )
    slug = compute_preview_slug(branch, project_slug)
    backend = _backend_slug(slug)
    final_slug = backend or slug
    url = f"https://{final_slug}.{preview_root()}/"
    print(url)


if __name__ == "__main__":
    main()
