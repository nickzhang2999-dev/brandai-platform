# Novart product integration

## Goal and scope
Integrate the reviewed Novart frontend with reusable company backend code in `claude/novart-product-integration`, then assess frontend/backend differences against the original. Keep the deployed review branch and main unchanged. No production release or merge is authorized by this task.

## Baselines
- Company local and remote main, verified at integration start: `e99919a64cd212d5d1b083fd7210842a1962d935`.
- Frontend review branch start: `52e95a54148400a801e487e0216d76cc33139eb0`.
- Worktree: `D:/coding/公司/brandai-workbench-preview`.

## Phases
1. [complete] Inspect the frontend runtime protocol and choose an authenticated integration boundary; verify local infrastructure limitations.
2. [in_progress] Connect identity, brand/project data, asset storage and complete editor document persistence, including isolation and conflict handling. Backend foundation and client module implemented; live frontend binding remains pending.
3. [pending] Connect generation/edit/layer jobs, status/error recovery, brand rules and output workflows.
4. [pending] Verify the real product flow, required repository checks, and regression boundaries.
5. [pending] Produce original-versus-integrated assessment with reused/modified/new/missing capabilities; commit and push only after required gates pass.

## Validation
Required before push: `pnpm test`, `pnpm test:ai`, `pnpm -F web typecheck`, `pnpm -F web build`. API/database tests must cover workspace authorization, stale revisions, complete document round-trips and asset ownership. Source existence and mock interaction tests do not count as real AI provider acceptance. User forbids Computer Use; do not use it. Record any unavailable runtime validation honestly.

## Decisions
- Preserve original canvas API compatibility; the richer editor format needs a separately versioned document contract.
- Reuse original business services and authorization rather than exposing internal AI services directly.
- Do not repurpose preview access links as production user identities.

## Errors / constraints
- Existing `cds-compose.yml` and UI snapshot appear modified in status but `git diff` is empty (line ending/stat noise); do not overwrite them.
- Docker engine was unavailable. A hidden Desktop start also opened its UI; user questioned this. Explained the action and stopped the pending engine probe. Do not launch more local infrastructure; continue code and non-container checks. No project container or database migration was started.
- User supplied Docker disk-full error. Read-only disk check confirmed C: free 0.02 GiB of 100 GiB; D: free 53.19 GiB. No cleanup performed. After user resumed, existing dependencies were used with TEMP/TMP and outputs on D: for repository gates. Do not start Docker or install local infrastructure; real DB tests run remotely.
- Windows AI test runner requires Git Bash as npm script_shell; resolved without changing the project script. Service mock alias initially reached real Prisma; corrected test target and reran.
