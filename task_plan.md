# Novart product integration

## Current steering — owned canvas, 2026-10-10
User chose the company-owned canvas route. Phase A [complete]: SDK-free React entry, loss-aware legacy adapter, core tools/history/export, authenticated document/upload/generation wiring and homepage handoff. Phase B [complete]: 23 actual Chromium interactions, 11 homepage and 6 archive protocol checks, L1 835, AI pytest 365, complete typecheck and low-memory production build passed. Phase C [pending]: real isolated DB/S3/provider acceptance, EXACT/modify/draft/complex legacy UI and exact-version release. Details: docs/novart-owned-canvas-plan.md. Goal mode remains disabled; no licensing bypass. Completion here is the first local owned-editor batch, not the launch-ready product.

## Goal and scope
Deliver a launch-ready Novart product on `claude/novart-product-integration`: integrate the reviewed UI with reusable company backend services, verify real persistent materials/generation/save/reopen/export, deploy the exact tested version to the independent environment, and assess differences against company source. User explicitly requested this goal, autonomous routine approvals, multiple agents and logs on 2026-10-09. Preserve company main and shared business data; switching the existing production domain or merging main needs a concrete target and explicit release decision. Platform-enforced human approval cannot be bypassed.

## Latest steering — ordinary execution, no goal mode
- User reaffirmed full product scope but explicitly disabled goal mode. Do not create/resume a goal; current integration is ordinary single-agent execution. Safe isolated release remains required; no push while same-repository CDS routing can restart shared services.
- Whole-image edit is integrated with authorized lineage, inherited EXACT/clean base, image-edit transport, single-attempt enforcement, archive publication and explicit native insertion. L1 786, AI/Python 365 and Web typecheck pass; isolated native UI passes. Production build now passes (exit 0) using the opt-in low-memory launcher after earlier Windows allocation failures; no runtime-memory reduction is claimed.
- Next: obtain isolated provider/storage configuration, establish safe release routing and run the real DB/S3/UI/provider journey. Masks and orphan cleanup remain separately tracked; no unrelated tools/visual polish before the first-product journey passes.

## Baselines
- Company local and remote main, verified at integration start: `e99919a64cd212d5d1b083fd7210842a1962d935`.
- Frontend review branch start: `52e95a54148400a801e487e0216d76cc33139eb0`.
- Worktree: `D:/coding/公司/brandai-workbench-preview`.

## Delivery priority — user steering 2026-10-08
Ship the first usable integrated product before broad optimization. Preserve the reviewed frontend and reuse the existing company backend capabilities. Do not expand animation, visual polish, optional tools or architecture while the main user journey is incomplete. Authentication, data isolation, durable saves and explicit failure states remain release requirements.

First-product journey: sign in -> create/select brand -> create/open project -> upload/reference material -> edit canvas -> request real image generation -> insert result -> save -> close/reopen -> export.

## Ordered product TODO
1. [in_progress] Stable independent deployment and real login; repair release isolation.
   - Current: exact 8474347 images run; initial 14 public HTTPS checks and latest 13 native-adapter checks pass, including actual password login/logout, brand selection, native save/reopen, idempotent retry and stale-write rejection.
   - Release guard failed on 2026-10-08: restoring push policy after git push allowed a delayed company deployment. Do not reuse that guard. Before another push, verify a branch exclusion or another explicit delivery boundary that cannot restart this branch on shared infrastructure.
   - Done: one usable public entry, login/logout and brand selection work, new pushes cannot start writes on company shared infrastructure.
2. [in_progress] Serve the reviewed frontend as the product entry and connect its pages.
   - Reuse current home, brand, project library, material library and canvas UI. Bind real user/workspace/project state, navigation, refresh and deep links. Replace preview-only identity/file-state paths at this boundary.
   - Current: reviewed UI build-time export produces 124 hashed assets without project data. Authenticated shell/bootstrap, projects, state, drafts, materials, workflow, generation and scoped cross-page task recovery are implemented locally. Deployed native query/save/list/rename endpoints retain the earlier 33 HTTP/DB and 13 public checks; the latest complete UI/database journey is still pending CI. Exported files or API tests do not complete page integration.
   - Done: home -> project -> canvas -> project library is coherent, refresh retains the current real project, account/brand changes do not leak state.
3. [in_progress] Connect essential brand/project/material data.
   - Reuse workspace/project/brand-rule/upload APIs; configure isolated object storage; connect create/list/rename/archive, upload and material selection.
   - 2026-10-09: durable native image upload and persisted workflow references implemented/in integration. Source tests and isolated UI diagnostics are distinct from the pending real storage/database CI. Independent runtime still lacks actual storage/provider configuration.
   - Done: uploaded material survives refresh/relogin, works as a canvas/reference image, and remains scoped to the correct brand/project. Brand rules used by generation are real persisted values.
4. [in_progress] Connect complete canvas persistence.
   - Bind the implemented native document session to the actual editor. Retain existing text, shapes, pen, image and layer interactions; do not add editor tools during this step.
   - Done: mixed-content edit -> save -> close -> reopen preserves the document and material references; failed restore/save, read-only state and conflicts produce actionable UI and never silently overwrite content.
5. [in_progress] Complete the real generation loop.
   - Connect prompt + references + brand rules -> existing backend job/worker -> status -> generated asset -> canvas. Configure actual providers and storage; distinguish unavailable services from successful generation.
   - Current: local intake/outbox/provider-claim/private-output/archive/native-insertion, visual checks, bounded EXACT and whole-image edit are implemented. L1 786, AI/Python 365 and typecheck pass; opt-in low-memory production build now passes. Isolated edit/task/frame/native PNG checks pass; real DB/S3/provider acceptance remains pending. Masks are not connected.
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
Independent login/persistence passed on ec5ff74 and 8474347; TODO 1 remains reopened for release isolation. Current local candidate binds the reviewed shell/canvas, durable upload, workflow references, the supported generation slice, cross-page task recovery and post-generation checks. Next independent implementation follows `docs/novart-exact-modify-plan.md`: authorized output-frame geometry/clean-base preservation, then whole-image editing, then masks; orphan-object cleanup remains pending. When safe publishing and actual provider/storage configuration are available, run the full real DB/S3/UI/provider journey against the exact commit and images. No additional visual refinement before that main journey works. Check items only against explicit done criteria; API existence or a running container alone does not complete a feature.

Earlier parallel work has been merged locally. Current whole-image edit supports authorized whole-file targets and validated inherited EXACT recipes; unsupported effects, masks, custom ratios and SVG-logo paths fail explicitly. Current gates and build blockage are recorded above; real-service CI and deployment remain pending.

### End-of-day handoff · 2026-10-08
- User explicitly asked to stop for the day and continue tomorrow. Do not start further implementation or deployments until resumed.
- Last pushed code: `f968f1a0e26722af4c57ba54271f4d6acf16ca00`. CI 37759389651 completed with failure; no candidate images published. Dedicated CDS remains on tested `847434758c7906565476a58e920000db39c78e8f`.
- Confirmed: all 61 actual API/database checks; real password login, first brand creation, blank-project/native editor opening, and native shape + Chinese text + pointer-drawn stroke autosaved into the real database. Local gates: 329 L1, 207 AI, typecheck and build pass.
- Next concrete fix: `/studio/draft` GET/POST in `apps/web/src/lib/studio-state.ts` omit `referenceIssues`, while captured `m24-canvas.js` calls `acceptIssues(data)` before setting `loaded=true`. The missing field prevents draft initialization and POST autosave. Add an explicit mirrored response contract and truthful reference validation; then assert both empty and saved draft receipts in HTTP tests. Do not simply relax the client validation or bypass the UI test.
- Also align shell contracts after adding native `cid`: `packages/contracts/src/workbench-shell.ts` currently extends `NativeProjectQueryInput`, now inadvertently allowing `cid`, while Pydantic shell models use `NativeProjectReference` and forbid it. Give the shell contracts their own project-only base and add parity coverage.
- Rerun actual UI save/leave/fresh-browser restore, repeat against built images, and only then deploy the exact tested SHA. Configure the independent branch's web entry as `/studio` after deployment and public verification.
- Final recheck caught a delayed company auto-deploy of f968f1a after the push policy was restored too early. Stopped only that integration branch via POST /api/branches/:id/stop; response confirms all services stopped and subsequent live read is idle f968f1a. Main remains running e99919a. Shared DB migration/seed impact is NOT yet verified. Before any further push, resolve branch exclusion or delayed-dispatch drainage; returning from git push is not proof it is safe to restore the webhook policy. See docs/development-log-2026-10-08.md.

### Resumed execution · 2026-10-09
- User explicitly resumed work and requested multiple sub-agents using the development log.
- Draft/contract agent: truthful draft response receipts, persisted-media validation and mirrored project-only shell contracts, with regression and real-HTTP assertions.
- Journey agent: full UI acceptance after canvas autosave, readiness/diagnostics and accurate product save messages; no relaxed success assertions.
- Read-only CDS audit agent: shared migration/seed effects and branch/main runtime evidence; report only, no data cleanup.
- Root: integration review, release isolation repair, sequential repository gates, then CI and independent exact-image deployment only when eligible.
- Resume TODO 2 and 4 without calling upload, provider generation or whole-product acceptance complete.
- Completed this iteration: mirrored checked draft receipts and native text forms; media/legacy/cid regressions; bounded UI readiness and exact save/reopen assertions; product-only storage copy; shared database audit.
- Validation: 352 L1 tests (346 contracts/service + 6 UI), 210 AI/Python tests, Web typecheck and production build pass. Exported 121 assets. Isolated headless fixture journey passes; the expanded 64-check real HTTP suite and full DB/UI CI have not run on this candidate.
- Release remains held: CDS delivery records show the same f968f1a skipped at 09:50:08.293Z then dispatched at 09:50:08.791Z. A skipped receipt or hasMore=false does not prove that future/repeated delivery cannot happen. No push, new images or deployment in this iteration.
- Next implementation: single-image upload -> persisted company Asset -> authenticated same-origin raw -> native document save -> fresh-session restore. Reuse existing upload/storage/ProjectAsset APIs; audit storage configured semantics before relying on environment fallback. Provider generation follows this material chain.

### Launch execution batches · user authorized 2026-10-09
1. [in_progress] Persistent image slice: implementation, source tests and isolated native UI diagnosis complete; real DB/S3/worker/UI CI pending. Includes bounded durable upload, same-origin image reads, workflow references, original canvas insertion and native save/restore. Latest local gates: L1 431, AI/Python 253, typecheck and build pass.
2. [in_progress] Deployment prerequisites: inspect independent storage/provider metadata; prepare necessary isolated configuration; document CDS-specific issues separately from application/configuration errors. No copying company keys or data.
3. [in_progress] Real generation slice: intake, shared preparation, provider-once worker, private-output archive, native composer/tasks and result insertion implemented. Local gates: L1 529, AI/Python 262, typecheck/build; isolated native interaction passes. Next: post-generation compliance, configured real provider/storage and real database/worker/UI acceptance. No paid model was called for these local checks.
4. [in_progress] Product completion: single-image and frame PNG export pass full-pixel isolated checks, including fresh-context reopen. Real DB/S3 export, additional supported formats/transforms, materials/library/project context, cross-page task recovery, account/role/tenant isolation, essential responsive checks and frontend/backend comparison remain.
5. [pending] Release: resolve company webhook routing safely, required gates + actual DB/S3/UI + immutable image verification, independent exact-SHA deployment, public interaction/health checks and rollback-ready handoff.
- Work continues on independent code while deployment/provider blockers remain. Update logs after every batch and record concrete blocked dependencies rather than marking incomplete work complete.

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
- Historical deployment: independent CDS project 98cfea6cdcbd first ran ec5ff74 and later 8474347 with separate infrastructure. The temporary company webhook pause was subsequently proven unsafe on 2026-10-08 when delayed deployment followed restoration; it is not an accepted guard. Full frontend binding remains unaccepted.
