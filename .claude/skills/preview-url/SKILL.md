---
name: preview-url
description: 生成当前 git 分支的 BrandAI CDS 灰度预览验收地址(geole.me)。零参数,自动从 git 分支 + 仓库名推算 v3 previewSlug,有 CDS 凭据时再去 /api/branches 确认后端 previewSlug。所有 slug/域名拼接都由本脚本负责,AI 一律不得自己 slugify 或手拼 `.geole.me`。触发词:"预览地址"、"验收地址"、"preview url"、"/preview"。
---

# 预览验收地址生成（BrandAI）

> 迁移自 prd_agent 的 `preview-url` 技能,适配 BrandAI 的 CDS(`cds.geole.me` / 预览根域 `geole.me` / 项目 `brandai-platform` id `a8a098f7193a`)。

## 唯一执行入口

```bash
python3 .claude/skills/preview-url/preview_url.py
```

零参数,输出一行 URL 到 stdout,直接贴进给用户的【预览】行。任何代码改动 `git push` 后都应给出这一行(对齐 prd_agent CLAUDE.md 规则 #11 的精神)。

## 为什么强制走脚本（不要自己拼）

- **SSOT 公式(v3)**:`{tail}-{prefix}-{projectSlug}` —— `prefix` = 分支名第一个 `/` 之前(claude/feat/fix),`tail` = 之后,`projectSlug` = 仓库根目录名(`brandai-platform`)。三者都过 slugify(小写 + 非 `[a-z0-9-]` 替换为 `-` + 合并 `-` + 去头尾 `-`)。
- **预览根域** = `geole.me`(脚本锚定;沙箱里的全局 `CDS_HOST` 可能指向别的 CDS 实例,**故意不**用它推根域,否则会拼成 `.miduo.org` 等错域)。
- **后端确认(可选)**:有 `AI_ACCESS_KEY`(或 `CDS_PROJECT_KEY`)时,脚本 `GET https://cds.geole.me/api/branches?projectId=a8a098f7193a`,找 `previewSlug` 与本地公式一致的分支,采用后端字段(与 CDS 后端永不漂移);查不到/无凭据/异常 → 退回本地公式(结果一致)。

**禁止**:在 bash/python/commit/文档里自己写 slugify、`tr '/' '-'`、手拼 `${X}.geole.me` / `${X}.miduo.org`。

## 示例

| 分支 | 仓库目录 | 输出 |
|------|---------|------|
| `claude/brandai-visual-canvas-migration-2e8mkc` | `brandai-platform` | `https://brandai-visual-canvas-migration-2e8mkc-claude-brandai-platform.geole.me/` |
| `feat/login` | `brandai-platform` | `https://login-feat-brandai-platform.geole.me/` |
| `main` | `brandai-platform` | `https://main-brandai-platform.geole.me/`(无 prefix,中段省略) |

## 输出格式（回复里这样贴）

根域是 SSOT(脚本给),**功能页路径由你按本次改动的真实路由 + query 追加**(让用户一点就到位,别只给根域):

```
【预览】<脚本输出>{功能页路径,如 workspace}
```

例:`【预览】https://brandai-visual-canvas-migration-2e8mkc-claude-brandai-platform.geole.me/workspace`

## 环境变量（一般不用动）

- `AI_ACCESS_KEY` / `CDS_PROJECT_KEY`:CDS 鉴权(沙箱已有;有就走后端确认,没有就纯公式)。
- `CDS_PREVIEW_ROOT`:显式覆盖预览根域(默认 `geole.me`)。
- `CDS_PROJECT_ID`:默认 `a8a098f7193a`。
- `CDS_PROJECT_SLUG`:显式覆盖项目 slug(默认取仓库目录名)。

## 健康探针(配套)

```bash
curl -sSk "$(python3 .claude/skills/preview-url/preview_url.py | sed 's#/$##')/api/health"
# 期望 {"web":"ok","ai":"ok","worker":{...}}
```
