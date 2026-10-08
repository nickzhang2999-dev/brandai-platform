# Integration progress

## 2026-10-08 — CDS frontend preview entry corrected
- User reported that the local launcher did not fix CDS's preview prerequisite. Configured only company branch brandai-platform-claude-novart-workbench-preview through the dedicated web-entry-config API with scope=branch; the card now points to the existing authenticated review entry.
- Verified the stored branch entry, subdomain primary entry and official preview URL agree. A fresh cookie jar follows the online bootstrap, reaches the reviewed studio, and subsequently enters studio from root; direct anonymous studio access remains 401. Company main remains running with its original entry. No service deployment or shared company profile change.
- An initial unsupported webEntry attempt in profile-overrides was rolled back. A temporary independent-project entry adjustment was also restored after locating the correct branch-specific API. Final operational change is confined to the requested company preview card. Credentials remain outside Git and chat.
- Closed the earlier c59b310/8474347 native-interface push release window and verified the company push policy returned to its recorded value (true). No additional code push or deployment was performed for this entry correction.

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

## Continued delivery preparation
- Committed the already-gated proxy fix and delivery checklist as ec5ff74af693e43815cb8d40d1482df614c0c1ec. User then authorized continuing, including the explicitly requested temporary push-webhook pause; release results follow below.
- Added scripts/export-novart-studio.py. Uses the existing reviewed Python runtime only as a build-time compiler; validates native patch inputs, exports shell/canvas HTML, derived JS/CSS and captured lazy assets into ignored .novart-build/studio, and removes disposable build-only project storage. No business data or review access credentials are copied.
- Static export succeeds locally. This is frontend packaging preparation only: authenticated Next serving and legacy-to-business API binding are not implemented or accepted yet. Do not mark TODO 2 complete based on exported files.

## Public backend checkpoint and native editor boundary
- Paused and verified only the company push event policy before pushing ec5ff74. CI 37745450841 succeeded. Dedicated CDS run dr_d2407a4cbe69a45a792903ad deployed the exact images.
- Public HTTPS smoke: 14 checks pass, including actual password login/callback, brand selection/persistence, project creation, full document save/reopen, identical retry and stale-write refusal. No provider calls. Company push policy restored to true and verified afterward; main running, original integration card idle. Local release-window receipt is private/ignored.
- Added strict native query/save/list/rename contracts and Python mirrors, authenticated compatibility route, complete snapshot service adapter, scoped deterministic retry IDs and the native 100400 conflict envelope. Renames are independent of autosave's stale title. Unsupported incremental/clone requests fail explicitly.
- Added 10 unit/contract checks and 16 Python cases; all four local gates pass: L1 291 contracts + 6 UI, AI173, typecheck and production build. Initial typecheck caught an unchecked hash character; fixed with charAt and reran affected checks. One default-parallel build failed from Windows memory exhaustion; rerun with Next's CIRCLE_NODE_TOTAL=2 succeeded without changing product configuration or starting Docker. Added 13 real HTTP/DB cases to CI (33 total); not yet run for this increment.
- Investigated the user's right-hand CDS preview button: server returns the intended unauthenticated review introduction, not a crashed UI. Generated a private local launcher for that exact preview hostname; authenticated entry and /studio HTTP checks passed. Access keys not printed, published or committed; review access gate remains enabled.
- First native-boundary CI (c59b310, run 37748645655) passed repository gates and the actual save/reopen/access/name checks, then caught unsupported-service 503 being masked as 500. No images published or deployed. Preserved explicit 503 mapping and added its response regression; full gates and remote run repeated before deployment. The company webhook release window remains guarded until this release completes.
- Fix 847434758c7906565476a58e920000db39c78e8f passed all four local gates again (297 L1, 173 AI, typecheck, build). CI 37749234447 succeeded: 33 real HTTP/DB checks, repeated 33 against built images; three-service health passed and images published.
- Dedicated CDS run dr_2e25c7535515b81bcbf4ec8f deployed exact 8474347. Public native-adapter smoke passed 13 checks, including byte-for-byte save/reopen, independent rename, stable retry, native conflict envelope, explicit unavailable service and logout access denial. No model/provider calls or browser interaction acceptance claimed. Remaining work is authenticated reviewed UI bootstrap and brand/material/homepage workflows.
- Delivery docs pushed as 9283247 (runtime remains the tested 8474347 image). Company push event policy restored to true and verified after release; main still running e99919a, company integration card still idle b124ef1. Both temporary release windows now have restored receipts under ignored .cds. This final operational note is local until the next ordinary code commit; do not open another release window just to publish it.

## Authenticated reviewed studio integration
- User explicitly authorized three parallel agents. Split contract/HTTP tests, actual UI acceptance script, and packaging/startup diagnosis; main agent owns product integration and release. Shared files assigned separately. Local test processes run sequentially after an attempted parallel gate launch exhausted Windows memory; no Docker started.
- Added authenticated studio/canvas asset serving, real identity bootstrap and workspace-pinned transport. Scoped browser drafts/IndexedDB/channels by user and workspace, preserved native editor scripts and overlays, disabled vendor fingerprint/socket initialization and exposed unconnected AI generation as unavailable.
- Added additive WorkbenchBrandDraft, WorkbenchUserState, WorkbenchProjectState and WorkbenchChatDraft storage with role checks, revision conflicts, explicit save groups and idempotent creation. Brand colors/notes remain a draft, not confirmed generation rules. Upload/image persistence and AI remain separate unfinished work.
- Build exports 121 manifest-listed assets (~27 MB), copies the compiled output into the image, and runs the reviewed UI against the actual CI app/database before image publication and again against built images. Private preview data is not packaged.
- Isolated frontend diagnosis found HTTP/1 streaming POST failure; buffering the bounded request body fixed project creation and native-editor startup. This fixture result is not database acceptance. New real CI coverage targets 61 HTTP/DB checks plus a fresh-browser native canvas/draft/profile round-trip.
- Local L1 322 contracts + 6 UI and AI203 pass; final typecheck and build pass after the stale-brand cookie, original-project archive context, pagehide keepalive and first-brand account-change fixes. Real CI/public validation for this increment is pending.

## Studio browser startup follow-up
- Candidate a4a3c82 CI 37755457067 passed all 61 real HTTP/database checks and the login/first-brand UI checks, then timed out waiting for the native editor. No images were published and CDS remains at 8474347.
- Browser diagnostics also detected the original login UI requesting Google Fonts. Replaced the external CSS import with the existing Inter 400/500/600/700 font assets served locally, including the upstream OFL license.
- Guard native editor probes until the actual canvas DOM and module factory exist. Added bounded frame/script/request diagnostics to the real UI acceptance script; no acceptance assertions removed. Applied the same module readiness rule to the read-only bootstrap.
- Exact /workflow paths are now workspace-pinned and return an explicit unavailable response rather than an accidental 404. Image upload and AI workflows remain unfinished.
