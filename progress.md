# Integration progress

## 2026-10-07 — integration start
- User authorized implementation on a new branch and final comparison against company source.
- Read repository gates and planning-with-files skill.
- Created `claude/novart-product-integration` from preview commit 52e95a5.
- Verified remote main is e99919a, matching the audited original source.
- No product code modified yet. Inspecting runtime/data boundaries next.

## First implementation, not yet validated
- Added a separate native editor document contract and Pydantic mirror, additive Prisma table/migration, bounded gzip/base64 snapshot inspection, scoped asset-reference checks, version conflict/idempotent-retry logic, and authenticated GET/PUT endpoint.
- Added contract/codec tests and Python mirror tests. These have NOT run yet; no integration or production acceptance is claimed.
- Prisma client generation succeeded (code generation only; no database mutation).
- Docker start failed: user screenshot and read-only disk check show C: critically full (0.02 GiB). Stopped engine probe, no project container, migration, model call or cleanup performed. Heavy local checks deferred; no commit/push/deploy of the new implementation.
- Existing frontend shell, context/draft/upload flows, AI integration, real DB tests and final comparison remain pending.

## Backend foundation validation
- Added authenticated workbench session selection and frontend API/document-session modules. The frontend module is not yet bound to the reviewed shell.
- Added explicit save authorization, archive protection and cross-workspace reference tests; restore failures and in-flight reloads cannot enable saving stale/empty state.
- Fixed the encoded-document validator to avoid grouped regexp stack overflow on substantial native documents; regression test uses a compressed document larger than 500 KB.
- Required local gates now pass using existing dependencies and D: temp/output: contracts 275 + UI 6 = 281 tests; AI 157 tests; web typecheck; production web build.
- Prisma client generated successfully; no database migration ran locally. Real password-login/database concurrency workflow prepared for the integration branch; not yet executed at this record.
- README and integration SSOT explicitly separate implemented API foundation from pending frontend and AI integration. The old CDS preview remains unchanged.

## CDS deployment requested
- Pushed backend foundation as 9aaef83. Remote migration and repository gates succeeded; first HTTP run failed during brand selection. Added Host-aware origin checks for Next's internal URL and HTTPS proxies, plus three regression tests; remote retry pending.
- Prepared isolated integration compose and CI-built Web/Worker/AI images. Official compose verify passed with zero errors/warnings.
- Existing company CDS project has no prebuilt modes. Creating a dedicated integration project with its scoped key was rejected (403 project_key_cannot_create); no project created or shared configuration changed. Prepare/test the complete deployment before requesting the required new-project authorization.
- After the origin fix, all four local gates passed again: 278 contracts + 6 UI tests, 157 AI tests, typecheck and production build. New compose verification still passes. Remote workflow now also tests the built containers before publishing.
- Pushed b124ef1. Branch Image run 37739584857 succeeded: 20 real HTTP/DB checks on the build, repeated 20 against immutable images, three-service health green. Both GHCR manifests anonymously readable with expected digests.
- IMPORTANT: discovered original CDS project githubAutoDeploy=true only after pushing. Both pushes auto-started an integration branch with project-shared infra. Read-only audit confirmed additive EditorDocument migration applied (0 documents), two demo brands seeded, and seed code upserts four plans (before-values unavailable). No data cleanup or rollback attempted.
- Stopped only brandai-platform-claude-novart-product-integration via documented CDS stop. Verified all three services stopped after CI success; main retains e99919a and all three services running. Do not push additional commits until auto-deploy routing is resolved; stop is not a future-webhook exclusion.
- CDS creation request fe2260e2bf87 pending through official connect in separate control directory; process session 80868. Waiting for user approval. Image/config preparation complete; isolated deployment not yet done.
- Creation authorized and completed: dedicated CDS project 98cfea6cdcbd, credentials adopted only in novart-cds-integration-deployment. Repo cloned; default original-source profiles detected but not started.
- Initial compose import df11f2ec4271 parsed unrouted AI/Worker as infra; caught in readback before approval/start. Added read-only /cds-source binds while runtime remains immutable /app. Corrected import 6c2edc06518c confirms app profiles ai/web/worker, no new infra; pending human approval. User told to ignore/reject old df11f2ec4271. CLI verify: 0 errors, 2 expected migration warnings on AI/Worker (Web alone runs migration); server lint 0 errors/warnings.

## Independent CDS runtime and proxy acceptance
- Both imports were approved, with the old import last. Corrected dedicated-project infra using resync preview/execute: removed unused AI/Worker infra definitions without volume deletion; applied distinct PostgreSQL/Redis volumes. Corrected web dependency mapping.
- Imported credential placeholders were unresolved. Configured separate generated credentials in project 98cfea6cdcbd only, then started its PostgreSQL/Redis. Service container names exceeded resolvable DNS labels; verified and used profile-name aliases on the dedicated Docker network.
- Deployed exact b124ef1 images. Latest run dr_c5d34c0182ac83877ac24d09 succeeds; public health confirms Web/AI/Worker healthy, worker commit b124ef187562, 9 processors. No model/storage provider configured or called.
- Public login page and built JS/CSS work; anonymous API denied; real review registration/password authentication and test-brand creation succeed. Review access stored only in independent control .cds directory.
- Public brand selection rejected by Origin check after proxy Host/protocol rewrite; login callback also initially pointed to internal localhost. AUTH_URL now configured for the dedicated public entry. Added local origin fix using explicit server AUTH_URL, with forged-header, protocol/port and invalid-config rejection tests.
- All required local gates pass on origin fix: 281 contracts + 6 UI = 287; AI157; typecheck; production build. Fix not pushed or deployed because original project push webhook still needs isolation. No complete public document round-trip or UI integration acceptance claimed.
- Rechecked original company main running e99919a, original integration card idle/stopped. No further push, shared data cleanup or main deployment performed.

## User prioritization: first usable product
- User requested an explicit TODO list and prioritized a finished product before unified optimization. Replaced the broad phase plan with six ordered, acceptance-based product TODOs in task_plan.md and mirrored the checklist in the integration document.
- Main journey: real login -> brand/project -> materials -> native canvas -> real generation -> save/reopen -> export. Visual/animation polish and optional feature expansion deferred. Current active checkpoint remains isolated deployment/proxy acceptance, followed by binding the reviewed frontend.
