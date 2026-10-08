# Novart product integration

## Goal and scope
Integrate the reviewed Novart frontend with reusable company backend code in `claude/novart-product-integration`, then assess frontend/backend differences against the original. Keep the deployed review branch and main unchanged. No production release or merge is authorized by this task.

## Baselines
- Company local and remote main, verified at integration start: `e99919a64cd212d5d1b083fd7210842a1962d935`.
- Frontend review branch start: `52e95a54148400a801e487e0216d76cc33139eb0`.
- Worktree: `D:/coding/公司/brandai-workbench-preview`.

## Delivery priority — user steering 2026-10-08
Ship the first usable integrated product before broad optimization. Preserve the reviewed frontend and reuse the existing company backend capabilities. Do not expand animation, visual polish, optional tools or architecture while the main user journey is incomplete. Authentication, data isolation, durable saves and explicit failure states remain release requirements.

First-product journey: sign in -> create/select brand -> create/open project -> upload/reference material -> edit canvas -> request real image generation -> insert result -> save -> close/reopen -> export.

## Ordered product TODO
1. [complete] Stable independent deployment and real login.
   - Current: exact ec5ff74 images run; 14 public HTTPS checks pass, including actual password login, brand selection, native save/reopen, idempotent retry and stale-write rejection.
   - Release guard: user approved a temporary company push-webhook pause. Paused and verified before push; restored and verified afterward. Main remains running and the original integration card remains idle. Future pushes must use the same verified release guard until permanent branch exclusion is available.
   - Done: one usable public entry, login/logout and brand selection work, new pushes cannot start writes on company shared infrastructure.
2. [in_progress] Serve the reviewed frontend as the product entry and connect its pages.
   - Reuse current home, brand, project library, material library and canvas UI. Bind real user/workspace/project state, navigation, refresh and deep links. Replace preview-only identity/file-state paths at this boundary.
   - Current: reviewed UI build-time export produces 119 hashed assets without project data. Native query/save/list/rename compatibility endpoints implemented; authenticated shell/bootstrap and the remaining UI endpoints still pending. Exported files or API unit tests do not complete page integration.
   - Done: home -> project -> canvas -> project library is coherent, refresh retains the current real project, account/brand changes do not leak state.
3. [pending] Connect essential brand/project/material data.
   - Reuse workspace/project/brand-rule/upload APIs; configure isolated object storage; connect create/list/rename/archive, upload and material selection.
   - Done: uploaded material survives refresh/relogin, works as a canvas/reference image, and remains scoped to the correct brand/project. Brand rules used by generation are real persisted values.
4. [pending] Connect complete canvas persistence.
   - Bind the implemented native document session to the actual editor. Retain existing text, shapes, pen, image and layer interactions; do not add editor tools during this step.
   - Done: mixed-content edit -> save -> close -> reopen preserves the document and material references; failed restore/save, read-only state and conflicts produce actionable UI and never silently overwrite content.
5. [pending] Complete the real generation loop.
   - Connect prompt + references + brand rules -> existing backend job/worker -> status -> generated asset -> canvas. Configure actual providers and storage; distinguish unavailable services from successful generation.
   - Done: at least one real generation flows end to end, its result remains after reopen and can be exported; errors finish with clear retry/recovery rather than an endless spinner. Existing edit/layer capabilities are mapped explicitly; unconnected capabilities are not presented as working.
6. [pending] First-product acceptance and handoff.
   - Run the complete journey above with real login/storage/provider, plus essential desktop/laptop viewport and failure-recovery checks. Complete required repository gates and deploy the exact tested commit.
   - Done: a usable URL and private login instructions, tested scope, known gaps and a concise reused/changed/new/pending comparison against company source. No claim of complete one-to-one parity.

## After the first product is usable
- Unify spacing, rounded corners, animation timing and fine responsive details.
- Improve performance, loading behavior and advanced editor/workflow features from actual usage findings.
- Expand the original-versus-integrated comparison and resolve nonblocking differences.
- Keep known missing capabilities in the backlog; do not silently delete them to make the completion rate look better.

## Next execution checkpoint
TODO 1 passed on ec5ff74. Continue TODO 2 and its native persistence boundary: bind the reviewed frontend entry to actual account/workspace/project state. No additional visual refinement before the integrated main journey works. Check items only against the explicit done criteria; API existence or a running container alone does not complete a product feature.

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
- Deployment steering: user requested current integration branch on CDS. Prebuilt images and real DB tests passed for b124ef1. Dedicated project creation requires approval (403 with original scoped key).
- IMPORTANT: original project auto-deploy picked up both pushes and used shared infra. Additive document migration and seed ran. The integration branch is now stopped; main code/services unchanged. Do not push again until automated branch routing is resolved. Preserve audit in docs/novart-product-integration.md and avoid blind data rollback.
- Independent CDS project 98cfea6cdcbd now runs ec5ff74 with separate infrastructure; proxy-origin repair and public document save/reopen passed. Deployment guard is a verified temporary webhook pause, not a permanent branch exclusion. Frontend binding remains unaccepted.
