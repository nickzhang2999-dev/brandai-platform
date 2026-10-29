# Integration findings

## 2026-10-15 — reproducible canvas and conversation races

- Actual Chromium reproduced asynchronous insertion recording transient drag/stroke state in undo history, and restoring erased strokes while the eraser pointer remained down. Minimal committed-scene history/deletion merge fixes pass image-context19 and core52.
- Actual conversation browser reproduced an older RUNNING poll overwriting a newer READY read. Per-message request order preserves newer receipts while allowing later authoritative revocation. Phase-specific processing deadlines, sendBusy quick-edit protection and API-context guards cover retry/project-change races; conversation27 passes.
- Complete known application notices clarify before any new model call; existing accepted tasks are recovered first. Added real disposable SQL/worker/upload journey to CI without provider generation.
- Legacy generated assets with a verified file receipt still lack sufficient original composition evidence if StudioGeneratedMaterial is absent. This remains explicitly unsupported, with better text. Source hash canonicalization and unrelated metadata tests pass; original historical rejection remains unproven. Fixed diagnostics cover claim/preflight/finish and expose no source contents.
- Current full forced gates: contracts1528/UI34, AI487, full Web types, low-memory production build exit0. Normal branch push/CI readback remains the next step; runtime must not be inferred from Git SHA.

## 2026-10-13 — automatic layer semantics

- Official Fal Qwen Image Layered API exposes num_layers (default4); Qwen model card supports variable and recursive decomposition. These establish count-controlled semantic decomposition, not an existing automatic object-count feature. Sources: https://fal.ai/models/fal-ai/qwen-image-layered/api and https://huggingface.co/Qwen/Qwen-Image-Layered.
- Current code limits layerCount2–10, full-layer total40M pixels, and PSD estimate width*height*4*(count+3)*3 <=256MiB. UI2K-two-layer advice leaks export implementation to users; improve intent selection and bounded export rather than falsely relabeling fixed4 as automatic.
- Content analysis and decomposition are separate operations and must not be silently repeated or paid during local verification. Recursive refinement must retain persisted asset identity, permissions and EXACT source protection.

## 2026-10-12 — bootstrap resource freshness and release boundary

- Actual public bootstrap response uses Cache-Control `max-age=14400, must-revalidate` and its served body still matches68cb; the source repair7b is not running. A query with the new digest was a cache MISS but still served68cb, which is consistent with no deployment and does not prove the CDN ignores queries.
- Version the authenticated HTML startup URL with the manifest's compiled bootstrap SHA256, rather than a commit label or a timestamp. Route keeps authentication first; invalid/missing digest fails503, context escaping and deferred script order remain. Unit route/helper39 pass; full L1 1000/AI365/typecheck/build/export124 pass. New real CI check must verify actual response bytes match DOM v; it has not yet run remotely.
- 7b CI38196332671 source/container API95/UI16 and image publication passed. Current release still stops before any POST because fresh company metadata GET lacks a complete response; final120.062s HTTP/2 deadline also failed. This does not establish a specific CDS application/network root cause. Company/main/shared data remain untouched.

## 2026-10-12 — first-party startup dependency confirmed

- User reports normal opening can reach resource-init timeout. Unique source is bootstrap12s wait for navigator.serviceWorker.controller after ready. Actual isolated ordinary6 pass does not disprove user context; separately controlled hard/bypass cases both reproduce active/ready with uncontrolled page and same timeout.
- Actual home→library→existing owned-frame97 HTTP all same-origin, resource timings home36/editor20 include no external scripts/fonts/images. /canvas route already authorizes then redirects to owned editor; /studio has unnecessary legacy worker prerequisite.
- Minimal change gates existing worker logic to explicit /canvas only; studio/studio/ do not read/register/wait worker. Original auth/tenancy/history/user storage/license boundary remains. Source18 lifecycle checks synthetic; real CI fresh restore will block workers, ordinary journeys remain allow.
- Old companycard52e lastPushAt8Oct is its own metadata; actual newer skipped push delivery plus independent d82/68 manual deploys are distinct. Do not falsify oldcard version/date. Prefer current independent product card for deployment state.

## 2026-10-11 — missing tools confirmed and implementation contract

- Final local implementation is complete for the requested tool list. Original basic records stay v1; advanced owned records carry bounded v2 metadata. Unknown legacy containers/effects still retain read-only protection. Local fonts are three family stacks; eraser deletes a whole stroke, not an image mask.
- Screen/export share text/crop/flip/arrow layout. Scoped export validates the full document before filtering, then handles group/frame closure and rotated frame clipping. Repeated paste requires fresh IDs; frames are ordered under their contents. These failure-prone behaviors have actual browser/pixel checks.
- Hidden owned layers or frame ancestors preserve prior workflow references but make them unavailable for generation. Display crop is editable/exportable; unsupported cropped-image AI semantics remain rejected rather than silently sending original pixels. Replacement uploads verify persisted identity before applying one undoable change.
- Final L1 989/AI365/typecheck/build and actual Chromium49 passed;16 source hashes unchanged. No new cloud/paid acceptance claimed. Existing independent CDS service profiles/volumes are sufficient; only the tested application SHA needs cloud validation and isolated release.

- Current OwnedCanvas toolbar has select/hand/text/stroke/four shapes/frame/upload/history/full export. No object clipboard, rich typography, crop/flip, alignment/group, layer hide/lock/dragorder or eraser/line/arrow. Existing frame is a flat decorative item; nested legacy containers remain protected.
- Requirements MD W-02 includes object copy; crop/alignment examples are candidates until selected. User now explicitly authorized the full listed gaps. Retain compact context-driven UI and validate every operation through undo, stored reopen and export.
- Cropped/flipped pixels must not silently become original-image generation references. Root will verify workflow geometry rejection/materialization boundaries before accepting new frontend semantics.

## 2026-10-10 18:13 accepted core and material-list distinction

- One real ordinary1K generation is SUCCEEDED/READY on exact55e; input upload and generated Asset bytes re-read from isolated storage. Bound continuation7 passed actual insertion/revision2 save/fresh login/SVG and PNG pixel equality, without another generation/upload/create request.
- listStudioMaterials queries successful StudioMaterialUpload only. Requiring StudioGeneratedMaterial in that response was a temporary acceptance error; task READY projection separately checks persisted output/Asset/version/project membership. Preserve the original failure and record this visible product difference, do not silently broaden the API or fake success.
- Ordinary generation/core editing acceptance does not accept real EXACT/whole-image edit/VLM/layer/masks or arbitrary legacy migrations. Current real-provider count is one original request, not another continuation call.

## 2026-10-10 17:55 current facts

- Exact55e07ac is deployed in isolated project98 after CI38039517128 success. Public owned editing9 checks passed; fresh real login restores the server document and identical SVG/PNG, with15.312s continuous original DOM.
- Independent Garage is healthy and its one-bucket restricted application settings were encrypted through the original admin API. Approved771 skipped existing infra, requiring official resync; health CMD flattening required a separately recorded runtime override. Approval record and runtime are not identical.
- Authorized image-only four-field handoff succeeded with own target encryption, source and non-image settings unchanged, providerCalls0. Public upload/one-image acceptance pending; configured keys do not prove generation.
- Company right-side old preview remains distinct. Company registration versus live version can differ historically; same-mouth baseline plus recent deployment records show no new company deployment for55e.
- Current temporary browser tests must allow and verify the production service worker and await React hydration. These test prerequisites are not new CDS or product defects.

## 2026-10-10 afternoon live verification
- The user's CDS right-hand review entry still loads 9e5e2af. Its package hash matches the frozen preview manifest and its old SDK files are served; /studio-editor is absent. The local owned editor has not been deployed there.
- The independent product is still 8474347. Read-only configuration and AppSetting audit confirms no usable independent provider or S3 setup. This is a configuration prerequisite, not a fabricated successful generation or a CDS outage.
- Native queryProject returns version as the string `novart-{revision}`. Fixed the new archive guard and protocol test to compare this real representation; a numeric fixture would have hidden a live archive failure.
- Owned frame/c-image serialization passes two tests against the actual server EXACT geometry: authoritative frame bounds and image placement retained, incompatible aspect/opacity still rejected.
- Direct notification links must preserve exactly one bounded taskId/requestId through /canvas -> /studio-editor. A link never creates a task; the authenticated receipt endpoint remains authoritative.

## 2026-10-10 owned editor checkpoint
- The owned runtime reads/writes the existing native envelope as data; no SDK is required by /studio-editor. Complex/unknown legacy scenes remain read-only rather than silently flattening.
- Backend geometry continues to recognize c-image and frame records. Native pageStates camera uses world offsets, while the owned DOM uses pixel offsets; both directions now convert explicitly.
- Headless Chromium drove actual React + product home scripts with isolated fixture HTTP responses: core editing, mixed save/reopen, complete PNG/SVG, persistent receipt insertion/history, responsive layout, parent handoff idempotency, readonly race and conflict/restore protection pass. These are interaction checks, not real DB/S3/provider acceptance.
- Real authenticated isolated-stack UI acceptance is separately wired in CI, including homepage upload/reopen; unsupported EXACT/modify/draft/notices remain explicit. No online version was changed in this batch.

## 2026-10-09 — constrained build verification
- Opt-in Next memory optimizations plus cpus=1/serial server compilation and tracing completed a real production build on this Windows host. Launcher caps each Node old-generation heap at 768 MiB; this is not a total-memory cap. Temporary files use the ignored repository directory, not C: user temp.
- System committed-memory headroom also improved and the old preview process group disappeared before the run; do not attribute all improvement to configuration or invent a reduction percentage. No process shutdown or pagefile modification was performed.
- Build still reports absent local infrastructure; successful compilation does not verify real backend/storage/provider health. User-facing runtime memory is a separate unmeasured concern.

## 2026-10-09 — whole-image edit integration findings
- A clean-base first input does not protect EXACT if its final flattened target also enters as a secondary reference. Product intake and final reference audit now reject its ID or SHA alias; inherited EXACT originals retain the existing separate guard.
- Legacy FREE chat policy drops compiled prohibition examples and alternative additions. Product-only opt-in preserves the compiler output; default legacy callers retain their prior policy.
- Native module 40291 selection memo subscribes to selection changes, renders an image and adds a pending selection mention to the composer. Undo restoring selection reproduces this and makes strict drafts fail. Product-only early return disables this auto-mention, not actual selection/undo or explicit M6 target. SHA/anchor checks protect the build patch.
- Edit provenance is a new product Generation root plus source asset/version/generation metadata, not a cross-generation parentVersionId unsupported by company lineage queries. Archive tests retain source locks and actual decoded dimensions.
- No new runtime CDS evidence this batch. Windows physical free RAM hid commit exhaustion; typecheck passed using jitless, but production build requires WebAssembly and still hits native memory allocation. Keep the gate visibly pending rather than retry indefinitely or close user apps.

## 2026-10-09 — EXACT geometry and paid-attempt boundaries
- Captured native image transforms compose translation then rotation with ancestor transforms; use F^-1 * I, not axis-aligned selection bounds. Saved sibling indexes provide order. Ordinary native frames do not clip child overflow; product output explicitly clips to the selected frame.
- Two actual native PNG fixtures verify server composition at supported integer/right-angle transforms. A 128px frame with left/bottom overflow exports as 140px natively; product's 128px composition equals its x=12,y=0 frame region. Whole exports are intentionally not claimed equal.
- A one-time DB/BullMQ claim alone did not prevent the HTTP provider's Tenacity retries. Product requests now opt into request-local never-retry policy and require the single-provider-attempt-r1 service capability before calls; legacy retries remain unchanged. Python HTTP POST-count tests pass, including failures, concurrent scopes and cancellation reset.
- Hidden object paths are insufficient for clean-base privacy if legacy bucket policy is public. Store ciphertext and keep metadata private; bind GCM AAD to workspace/project/output and include a key revision in immutable paths to prevent old-key late workers overwriting new-key objects. Key rotation requires controlled migration; orphan cleanup remains pending.
- Source existence checked before S3 upload can change before DB publication. Final archive transaction locks and validates both Asset and ProjectAsset rows. Product old edit/decompose entry points are rejected before task/provider work, since they do not implement the new clean-base/request lifecycle.

## 2026-10-09 launch increment
- Uploaded Assets carry both an object key and a presentation URL. The raw route previously preferred the absolute URL, causing private S3 hosts to enter the public-URL fetch path. Prefer the actual key; legacy URL-backed rows retain the safe fetch policy.
- New upload intake stores at most 10 MiB per image, 40 MiB per workspace and 256 MiB globally as a bounded temporary Postgres outbox. Worker writes an immutable server-owned key, real Asset and ProjectAsset; terminal tasks release bytes. These are source-level facts, not deployed acceptance.
- Native ResourceService.uploadAndInsertImages is the shared menu/drop/paste boundary. The product overlay retains native shape creation and undo; it never saves a temporary blob/data URL.
- The independent environment has no AppSetting singleton or real image/storage keys configured. Internal AI health is reachable; external provider and storage reachability cannot be claimed without configuration.
- Storage diagnostics used to report success when unconfigured and described read/write after PUT+DELETE only. Updated diagnostics use bounded PUT/GET/byte-compare/DELETE and report cleanup failures.
- CI storage is disposable and loopback-only, built from the fixed upstream security commit. This test dependency is not a production storage recommendation. Production storage must be separately configured and tested; see docs/cds-launch-readiness-2026-10-09.md.

## 2026-10-09 verified draft and release boundaries
- The captured native draft receiver calls acceptIssues before setting loaded=true; GET and POST both require referenceIssues. Missing it prevents POST autosave entirely. Native composer initial/reset state has text:""; prompt-only test fixtures were not valid restored forms.
- Draft inputForm must preserve native extension fields while requiring text:string. The resourceFields set also includes audioUrl; all eight nonempty media fields need real persistent asset validation before this feature is enabled. Clean receipts are issued only after validating read/write data, including legacy rows.
- Workbench save contracts must use project-only identity, not inherit native transport cid. TypeScript and Pydantic are now aligned at that boundary.
- CDS webhook history shows f968f1a skipped at 2026-10-08T09:50:08.293Z, then deployDispatched=true at 09:50:08.791Z for the company integration branch. Neither a skipped log nor hasMore=false is a delivery-drained proof. Current observed UI/API expose project push policy, not a verified branch-only exclusion. Do not repeat temporary pause/push/immediate-restore.
- Shared database effects are now evidenced in docs/cds-shared-audit-2026-10-09.md; no rollback or cleanup performed.
- Next material chain can reuse workspace asset upload, authenticated /raw and ProjectAsset. Reviewed frontend uses raw File/X-File-Name plus SHA receipts, requiring an explicit adapter. Keep blob/data document rejection. Investigate getEffectiveStorage().configured checking only AppSetting before claiming S3 environment fallback works.

## Verified source baseline
Remote main matches local company baseline e99919a. Existing backend includes Next/Auth.js, Prisma/Postgres, workspace membership, assets/object storage, BullMQ jobs, FastAPI providers, generation versions, review/export, configuration and quotas.

## Frontend review runtime
The reviewed frontend lives under `previews/novart-workbench`. It currently runs through a Python runtime and a local file store. It includes captured editor builds and dedicated adaptation scripts; it is not currently a React page wired to the product API. The exact protocol must be mapped before integration.

## Important incompatibilities
Company `CanvasStateSchema` stores up to 200 simplified image/shape/text records and uses last-writer-wins. The reviewed editor's richer document must not be forced through it. Company templates are assets, and generation chatContext is not a full multi-turn agent service.

## Verification boundary
No production credentials, model calls or runtime database migration performed at task start. Existing review deployment remains an independent file-backed review service.

## Integration boundary
The captured editor sends native project query/save requests; the review runtime accepts `SHAKKERDATA://` gzip/base64 containing `tldrawSnapshot.document.store` and `.schema`. Preserve that full snapshot separately from the original simplified canvas contract. Writes already use a version token; carry that check into database compare-and-swap rather than downgrade to last-writer-wins.

The preview shell also has independent context, input-form draft, state and homepage-upload endpoints. A production integration must migrate each of these, not just redirect native saves and call the whole frontend integrated.

## Verified native client protocol and next shell boundary
- Native autosave sends projectId, version, compressed canvas, echoed projectName, derived projectCoverList/picCount, optional sessionId and incremental feature flags. A separate updateProjectName request handles rename. Treating the echoed title as authoritative would revert another page's rename; the product adapter deliberately does not do that.
- Native save distinguishes code 100400 inside an HTTP 200 envelope to open its version-conflict dialog. General 409 handling alone would lose that behavior. Other failures retain HTTP status, including explicit 503 for unimplemented vendor services.
- Server compatibility routes resolve the brand via a validated explicit workspaceId or the existing active-brand cookie. Product startup must pin each open frame's workspace in its requests; no vendor token grants authorization.
- The exported shell still starts with preview profile defaults and unscoped localStorage keys. Before serving it, bootstrap the actual user/workspace and namespace preferences, creation-recovery records and drafts. Do not restore another user's old browser state.
- The old share worker intercepts all cross-origin requests; the preview server substitutes a demo identity and local upload storage. It must not become the product transport unchanged. Reuse the captured asset allowlist from the exporter and bind supported APIs to the authenticated product BFF; fail unsupported services explicitly.
- The compiled canvas contains /m20-comparison.js, /m6-workflow.js, input/canvas/motion layers and patched native chunks. Copying only the toolbar or mounting raw vendor HTML would omit existing interaction safeguards.

## CDS preview entry finding
The company project's right-hand preview URL is a working alias for the review gateway. Its root returns the public introduction until the browser has the room capability cookie; it is not a failed deployment. An authenticated first visit to the same hostname reaches /studio. A private launcher was written outside the repo without publishing the access key. The real product integration remains in the separate Novart-Product-Integration project.

## Inbox and visual-check boundaries · 2026-10-09
- A provider-success notification is premature while a private output is still unarchived. Product inbox projection requires output coverage, matching project/workspace, actual published asset/version SHA and positive integral dimensions; failed/expired batches need independent ordering to avoid hiding recoverable work.
- A nonempty visual report is not proof of a VLM call: the existing provider can return findings when image fetching failed and can fall back to PASS/100. Product checks require explicit `visualCheckPerformed=true`, derived from actual model execution, valid findings or explicit empty results with a valid numeric score, and inclusion of all supplied references. Legacy report behavior is additive-compatible.
- AI health must advertise visual-check capability before product paid requests. Parser/generation version compatibility alone can select an older AI service that would charge for a check but omit the required evidence. The opt-in resolver now verifies `studio-visual-check-evidence-r1` for explicit and shared URLs, without reusing incompatible caches.
- Auto checks bind the actual private S3 image SHA, generation-time brand rules and current authorized prohibition references. Task expiry and attempt-token CAS prevent a late response overwriting a retry. Completion is separate from PASS/RISK/FORBIDDEN; no upstream progress feed means no invented percentage.
- The native frame may load before its product adapter registers message handling; cross-page task navigation requires both readiness signals. Messages also validate source/origin/user/workspace/project/token. Recovery only focuses receipts, never silently inserts a second image.
- EXACT cannot be enabled by accepting the enum: saved native frame/image transforms require relative affine geometry, crops are a different convention, and later edits need a durable authorized clean base rather than re-editing a flattened composite. Detailed implementation sequence is in `docs/novart-exact-modify-plan.md`.

## Generation integration locally validated · 2026-10-09
- Material usage is a wire-semantics issue: new `assetUsages` EXACT/ADAPTIVE/REFERENCE cannot be mapped by name to legacy `referenceAssets.STRICT`, which creates a watermark overlay. The first product slice accepts text plus supported adaptive/reference bindings; EXACT and modify must fail explicitly until their actual geometry/target contracts are integrated.
- Paid-provider output and a durable usable result are separate stages. Private `StudioGenerationOutput` precedes brand postprocessing/storage; publish `GenerationVersion`, the actual `Asset` and `ProjectAsset` together after archive. Retry archive never reruns the provider.
- Private raw bytes have at most a 24-hour recovery window and are cleared after successful publication. If only an upstream URL could be retained, recovery also depends on that URL remaining available; its expiry cannot be represented as a guaranteed 24-hour copy of the image.
- The opt-in AI transport shares the worker AbortSignal, bounds actual JSON bytes and sanitizes upstream error bodies. Twenty-six transport tests pass. Final provider normalization/checking happens in the same config read that builds the outbound headers; a preceding readiness check alone has a configuration race.
- Accepted workflow materials must retain server-resolved expected SHA values in the immutable job context. Actual decoded reference bytes are compared before the paid request; the archive logo check does not cover this earlier boundary. Missing or replaced active references fail explicitly.
- Source-route generation and archive actions are wired locally. L1 529, AI/Python 262, typecheck and build pass; 123 product assets export. New real HTTP/DB rejection checks and optional real-provider UI checks are authored but not yet run. No new source was pushed or deployed in this batch.
- The original c-image single download uses image-toolbar-download; generic download-button is not present in that selection state. Frame export uses the actual right-click Export -> PNG menu, while independent multiselection defaults to ZIP. Isolated single/frame PNG downloads, exact pixels and fresh-context re-export pass for unrotated/uncropped content only.
- Windows committed memory, not just physical free RAM, limited concurrent tooling. Serial L1 (one thread, 768 MiB heap), typecheck/build (1024 MiB heap) and Next CIRCLE_NODE_TOTAL=1 pass without starting Docker. Build still logs absent local Redis connections; compilation is not runtime-health acceptance.
- Latest read-only CDS check still finds company auto-deploy/push enabled, main running e99919a, company integration idle f968f1a and independent integration running 8474347. Existing skip/restore webhook handling remains unsafe; no verified branch exclusion yet.


## Owned canvas decision, 2026-10-10
Company OpenCanvas has image/shape/text, selection/transforms and persistence but lacks general brush/history/frame/rotation/export. Preserve existing rich document records through a SDK-free compatibility adapter; do not force them through the 200-item last-writer-wins CanvasState API.
## 2026-10-10 producer startup evidence
- Subsequent real CI confirms uploads finish: four completed queue jobs, 15 actual owned UI/DB/S3/worker checks pass. Remaining failure was a stale strict notification href test without taskId, not upload timeout. Update exact task identity expectation rather than remove it.
- Company main has real openai/gpt-image-2 encrypted AppSetting credentials, established by read-only transaction. Independent settings are still empty. User authorized one 1K image; use existing admin encryption/service with no plaintext logs and no VLM/layer/storage-company credential copying.
- Actual installed BullMQ 5.76.10 RedisConnection caches its initialization Promise. skipWaitingForReady=true with enableOfflineQueue=false can send INFO while the Redis client is connecting and permanently poison a Queue despite a subsequent ready event. Normal readiness handshake passes the tiny isolated reproduction.
- CI 38031824770 real API/UI uploads timed out, but worker/server logs and queue snapshots were not collected. The startup mechanism is demonstrated; exclusive incident attribution awaits real CI evidence.
- upload-artifact v4 excludes hidden files by default; .novart-ui-artifacts reports need include-hidden-files plus a precise safe allowlist. Avoid uploading raw service logs or environment/config data.
- Material worker initial DB claim can fail outside its catch; a failed Bull job and PENDING task are a distinct diagnostic case. Do not erase intent or rerun a paid provider as a generic queue repair.
# 2026-10-10 15:54 verified increment

CI38035078835/fedbfa3 failed on bare /workflow anonymous307 and two alert matches at permission rejection; repaired response boundary plus exact real-error testid, retaining auth/404 checks. Approved CDS import473923091fca silently omitted expose-only Garage but persisted dangling dependsOn. Three official resync previews/noexecute pin classification to ports vs expose, not image whitelist. Runtime binding and persistence remain unproven. No new deploy, model handoff or paid image call.
# 2026-10-10 16:11 verified result

b778553 CI38036388613 success, backend95/UI15 plus container rechecks and publication. Garage v2.4.1 official Admin REST can initialize bucket/app key via internal3903; CDS does not have proven infra exec, so do not treat infra as branch profile. Final two compose plus TOML declare separate admin token placeholder and internal listener, publish only S3 port3900; actual scope/volumes/network must be read back. New platform approval3d3d941a2c50 pending actual status despite user's reply.
# 2026-10-13 real integration continuation

- Current source and remote were verified at `7c83011` on `devUpdate1012`. Local gates and isolated React fixture checks passed in the migration batch; actual new-feature DB/provider acceptance has not yet been run.
- No local Postgres/Redis/object-storage listener or private runtime configuration was found. Prefer the repository's existing disposable GitHub Actions stack over starting Docker on this Windows machine.
- The connected GitHub commit-runs wrapper filters to pull-request events, so its empty result does not describe this push. Use read-only Actions REST metadata through the existing Git credential helper; never echo/store credentials.
- Layer configuration is separate from ordinary image generation. Dedicated service capability gating is now implemented and regression-tested; real provider quality is still untested.
- Exact-commit Actions run38344585370 succeeded on 7c83011; the source and built-container suites each passed backend95/UI17. New feature-specific real checks are connected for the next CI run, not inferred from that older success.
- The next actual run38346622593 on5d2f51c completed success: both source and built containers backend134/UI22, including knowledge16/layer-preservation23/new knowledgeUI5. Actual report gates prove realKnowledge=true and realDecomposition=false. The prior pending statement is historical, not current acceptance status.
## Automatic PSD reuse · 2026-10-13

- Official Qwen-Image-Layered `src/app.py` implements image-to-RGBA layers and PSD/ZIP/PPTX writing. Its example uses CUDA/bfloat16; no model download or live inference has been performed here.
- Existing company layer-set exporter already writes independent RGBA layers with ag-psd. New Studio layers are separate persistent records and require a new scoped export boundary rather than passing them through the old GenerationVersion URL.
- A product skill is orchestration: generation, durable layer preparation and PSD writing remain actual executable steps. Paid decomposition is explicit opt-in per request, server-authoritative and must not automatically retry an uncertain model call.
## 2026-10-14 · Local handoff evidence boundaries

### Edit-target investigation

Read-only scoped records distinguish an earlier pre-provider FAILED request from a later successful request whose prompt equals the generic source error. No evidence proves who or what inserted that text. The current source snapshot validates, so the historical fine-grained rejection cannot be recovered from the generic error. Independently reproduced UI defect: FAILED generation plus NOT_REQUESTED archive makes OwnedConversationPanel.active return true. Preserve validation strength and add internal reason codes, not speculative source-check bypasses.


The approved handoff baseline is devUpdate1012/928ab0a with 42 verified manifest files. The offline design is a reference, not an editor or backend implementation. All new work stays local under the latest user instruction.

Actual Chromium exercises production React and Studio shell with synthetic loopback HTTP receipts; it verifies clicks, recovery and real PNG/PSD encoding, not SQL persistence, authentication, S3 or provider quality. Structured VLM intent is implemented but defaults off; unknown calls cannot be retried and old worker leases cannot reserve generation quota. Real DB/storage/provider/domain acceptance and transformed-source masks remain explicitly pending.

Current implementation and per-scenario evidence: docs/deepflare-handoff-ui-2026-10-14.md and docs/development-log-2026-10-14.md. Legacy WEBSITE-only materials are rejected until uploaded/migrated; M6 is deferred by the original handoff. No new CDS issue was observed because CDS was not operated.

## 2026-10-15 · Explicit conversation edit target
References and edit targets are different states. Existing quickEditTargetId already persists in authoritative drafts; the UI now exposes it as a selector. Fresh pinned requests skip semantic reclassification after all source checks; previously unknown model calls remain clarification. Natural visual adjustment rules exclude negative, quoted and commentary clauses. No real provider calls.

2026-10-15 engine audit: supplied package is identified as @tldraw/editor 5.5.2; guide is not a complete product integration. Current editor uses its own scene and native codec. warnings include unsupported records, page ambiguity and bindings; serializeOwnedDocument rejects them, so removing only UI lock would produce unsavable edits. Existing resize already handles rotated fixed corners; current UI already uses crypto.randomUUID. Need implement from current facts rather than blindly apply guide line references.

Engine final evidence: engine/browser9 + core52/tools13/layers10/image19 all pass; culling is transient only and full-document export/reopen verified. CPU queries remain O(n), DOM retention does not claim lower image decode memory. Memo/WeakMap assume immutable input item updates, matching current operations. Default60 history preserved with changed-item snapshot isolation. Attachment licensing/pricing assertions were not used as authorization.

2026-10-15 engine deployment evidence: GitHub success alone did not immediately populate CDS ciImageStatus. Official same-commit claim succeeded and new actual editor JS contains both deepflare-owned-v1 and data-owned-culled. Public worker commit and Web/worker actual database identity verified after deploy; branch metadata alone was not used as runtime proof.

P2 boundary review: ordinary unhandled and explicit500 API failures now redact public diagnostics; intentionally authored503 service availability messages remain actionable. RequestId is server-generated rather than client-controlled. No global changes to validation or business errors. Legacy assets upload has8MiB images; Studio has its own10MiB codec pipeline and must retain it when legacy nonimage envelope grows.

2026-10-16 P2 runtime proof: compilation and direct register() unit tests do not prove startup rejection. Actual compiled Next15.5.24 with missing/short/example AUTH_SECRET logged the guard error but still reported Ready and stayed alive; all three negative cases failed. Local Next production prepare path does not await underlying preparation. Add phase-production-server config validation plus dependency-free preflight before startup placeholders/install/migration. This is local process behavior, not evidence of a CDS fault.

P2 final runtime evidence5de6ffc: shared zero-dependency guard in Next production config phase and all three startup shell paths. Actual compiled Next negative cases3/3 now exit1 without Ready, connection refusal or timeout. Regression tests execute installed Next CLI against a clean no-BUILD_ID fixture, proving rejection before build lookup. Full gates1737+34/500/types/build pass. SVG recognition is not sanitization; non-raster uploads use storage octet-stream and authenticated raw attachment/nosniff. Real backend/provider acceptance remains unverified in this local-only batch.

2026-10-16 optimization: source plan baseline83a5dca and7 files+76/-7 match actual. Workflowpush and bothjob filters exclude stage branches. Current exporter imports preview runtimes and patches native license assets althoughcanvas redirects toownededitor. Existinggeneration sweep createdAt10min conflicts with proposedmulti-target37min; revisit taskdeadline/lease and UI6min boundaries inP3.

P2 dependency pre-audit: untrustedstorageKey entry isPOSTworkspaces/[wsId]/assets; PresignUploadOutput isnotaninput. Enforce workspace prefix onclient creation, do not globallybreak server-owned brand-kit/previews keys oringest URLs. Legacyupload eagerlyreq.formData trusts MIME;50MiB acceptance needs boundedmultipart and Nextmiddleware envelope consistency. New Studio10MiB+64KiB path remains separate and genuinePNG/JPEG/WebP codec validation; don't add SVG/PDF canvas capability accidentally. Detailed source checks pendingP2 implementation.

2026-10-16 P1 final: old SDK startup/SW dependency removed; unregister only exact same-origin root oldworker asynchronously. 24 owned compiled assets no external dependencies; archive and upload use owned messages. Independent audit confirms no live previews imports. Two unbundled legacy adapter JS files still contain webpack strings but have no consumers and are not in exporter/Docker copied output; not a runtime dependency. Old README preview links marked retired, historical evidence retained.
CDS preflight directly confirms push automatic deployment and default shared brandai DB. Existing dev isolation is a branch-specific override, not evidence new P1 branch is safe. Therefore phase push has been held pending a concrete isolated P1 preview setup; no CDS runtime fault is asserted. Stage plan explicitly requires approval for online schema initialization and dev/main merge. Read-only sanitized evidence: .novart-build/cds-p1-readiness-20261016.json.


## 2026-10-16 · P3 可靠性定位

- ai.ts 原无 options 路径没有超时，也没有统一禁止 provider 自动重试。改为所有调用默认五分钟，付费入口要求 single-provider-attempt-r2；Python 旧识别、手册、摘要、抓取、描述、编辑入口同样执行 never 策略。
- 预检/复检原 HTTP handler 直接 await AI；新增持久 AsyncTask 输入/结果、202接单和只读查询。Prisma client 已生成，新增 SQL 迁移仅保存文件，未执行。
- 原 worker Promise.race 不足以阻止迟到业务写入。执行凭据、事务条件写入及 AbortSignal 需要同时生效。
- 十二尺寸串行工作允许37分钟，前台六分钟只是自动查询窗口。超时暂停查询，不得直接认定后台失败或再次购买模型调用。
- 生产缺存储的 base64 回退会把大图写入数据库；改为明确失败。开发演示路径保持兼容。

## 2026-10-16 P4 路由发现

旧 workspaces 深链转扁平页面后，URL品牌若被cookie覆盖会进入错误品牌；补服务端显式scope及软导航重验。旧Generation产物不等于native画布文档，通知需定位生成图库而不是空原生画布。旧代码删除需按原计划等待部署预览，本轮local-only停用保留。

## 2026-10-16 P5调查

上传和分层任务必须留下删除品牌后的对象清理依据，直接cascade新增FK会破坏这条生命周期；仅补安全的6表FK，例外明确记录。测试迁移后alias/relative双mock解析同一模块，vi.importMock自引用会死等，已按真实同模块工厂去重处理。
## 2026-10-17 发布阻断实证

实际事务回读current_database=brandai_devupdate1012、transaction_read_only=on。26表审计仅Membership=1，其余0；6项跨品牌检查0。新P5迁移包含Membership外键，孤儿未解决前不得推送触发迁移。未修改数据或CDS配置；这不是已发生的CDS平台故障。运行中Web/Worker实际AUTH_SECRET trim后长度与非示例值检查通过，未输出密钥。

## 2026-10-19 方案评审落实
当前工作区为brandai-layer-ux，integration目录的AOCI不代表此工作区。双输入常驻；画布已有修改/分层/尺寸入口。分层校验同时拒绝比例误差及大于原图，真实失败尺寸未取证。自动上画布提前标记taken，且只跟踪当前页在途任务；不能直接删除恢复入口。首页带图交接另有IndexedDB与保存确认，不可让首图抢在引用图上传之前提交。

## 2026-10-19 最终发现与实现边界
- 完整场景描述不应依赖生成关键词；否定/评论/问题应在付费意图模型前澄清。PSD在BFF对话草稿契约增加选项，向现有generation协议透传，AI服务wire没有新增字段。
- 单输入改造保留EXACT用途、输出画框、PSD、旧未知提交恢复；普通状态不常驻技术按钮。分层/素材/任务窗口按需打开，素材在底部dock。
- 实际浏览器发现并修复用途移除残留、popover遮挡、上传modal挡撤销、首页初始化顺序、首页回执规范化比较/清journal、focus相机提交与saveACK竞态。跨项目旧任务候选也明确过滤。
- 生成任务成功解码/插图之后才写文档账本；归档失败不标已放入，原任务归档重试成功可恢复。已确认任务的撤销/删除不撤销账本；用户仍可从结果手动恢复。
- 分层原图右侧分组使用显式besideSource参数；保留旧helper默认、原图、undo/replay与PNG/PSD原有保护。
- 1024方图旧真实成功不能说明本次街景图失败根因，未取到失败输出，不启用猜测性像素容差。

## 2026-10-19 GPT交接收尾调查起点

- 当前HEAD为7a4141f，059d62c包含上一轮画布与对话改造，09c0043补充疑问句保护和首页文案。交接中的领先10个提交不含其最后文档提交；本地追踪引用对比实际领先11个。
- 本次将界面术语清理与非方图取证分开执行。比例校验仍为整数交叉相乘相等，输出不能大于原图；没有位置变换证明时不把近似比例视为完整画幅。
- 不把10月17日9层PSD成功的旧回执当作本次非方图或当前新版首页的真实验收结果。
- 本轮已取到同一街景项目的真实失败任务：手动2层、自动3层，原图记录1920×2560；5张已生成PNG逐张读取均为544×736，含alpha。比例交叉乘积不等，严格画幅校验确实会拒绝，导致发布层数0；不是模型未调用。
- 理论等比缩小到高736时宽应为552，返回宽544，差8像素约1.45%。这是尺寸比较，不是已经证明裁掉8像素。原始输出只有图像地址与宽高，缺少缩放/裁切/填边的变换记录，不能据此直接放宽校验。
- 当前自研壳导出白名单仅加载bootstrap、task-inbox及owned-home-start；本轮33处清理包含当前入口9处和保留的旧generation/materials脚本24处。没有重新启用旧脚本或旧SDK。
- 工具环境记录：PowerShell不展开传给rg的路径通配符；改用明确路径或 `rg -g`。测试重写了UI快照的行尾，核对无内容差异后仅恢复该生成变化。

### 2026-10-19 新反馈与r2核实

- 首页失败原图三次在worker解码/格式检查失败（8,197,447字节），不是未结束上传；旧前端submitted使删除/新建永久冻结。原字节已清理，用户不知道原文件位置，不能反推具体格式子原因。
- 预览意图开关未配置，所查8条均safe-rules-v1且无模型开始时间；已有VLM配置不等于实际走模型。没有证据支持此次由1200token/25秒超时造成。
- r2采用已授权且hash一致的4张受限缩略图、3轮历史和真实选中引用；上一张非引用图片只能看不能被修改。改写提示词与原话分开保存。
- 独立审查发现模型可丢掉非目标EXACT引用，现已在decision/option两处拒绝；同时保护中文单引号文案、旧intent payloadhash和旧首页空selection兼容。
- 首页恢复IDB全站统一key的历史设计仍需品牌分桶迁移审查。未随本次修复换key或丢弃旧恢复资料。

### 2026-10-19 新提交复核

- 新增 f791cd4 / 78b3b88 后，发现未绑定项目的旧草稿归属推断不成立；单一原子事务才能防多标签页在迁移间隙覆盖目标/删掉变更后的源记录。
- 官方 Diffusers QwenImageLayeredPipeline 明确按 resolution²、32步长取整并整图resize。544×736现在有实现依据；仅指定模型640档启用，未知模型不能用“碰巧同尺寸”代替几何契约。原非方图调查结论更新为已实现本地适配，真实全组重合与模型质量仍未重新验收。
# 2026-10-19 云端验收暴露的入口与离页差异

- `39216392222` API exit 0 / UI exit 1。真实 UI 验收还在调用“返回设计对话”“创作需求”与旧的工作流修改目标，必须迁移到当前对话，而非删验收。
- 当前对话仅防抖保存和 beforeunload 警告，缺离页保存，输入后立即确认离开可能丢失末段文字；补 revision checked keepalive PUT 后 Chrome 真实导航恢复通过。未承诺强退/断网或未确认写入一定保存。
- 新的修改目标存于 StudioConversation.draft.quickEditTargetId；素材用途仍在 WorkbenchProjectState，两者分别查库，不能再要求旧模式控件同时存在。

## 2026-10-19 7层超时的线上证据

- 两任务原图1024²，规划7层成功，providerStartedAt后180.414/180.619秒失败；outputJson为空、发布图层0。
- 容器timeout=180，/layer-plan200后/decompose504；ai.failure stage=unknown，确认同步请求超时和分类遗漏，未进入几何归档。
- layer配置无自定义覆盖，默认官方fal-ai/qwen-image-layered；采用其持久队列，无需改密钥或新增配置。
- GitHub84fa5e4成功run39220851878；CDS timed_out_no_run、workflow URL空，实际deployedImage及health仍2492b43。正常恢复入口为claim-prebuilt先dry-run再deploy，不修改平台结果。
- 安全边界：POST无编号不重发；有编号查询可重试。6分钟退出后只显式查询原任务，24小时恢复期限不延长。旧失败任务无编号不能凭空恢复。

## 2026-10-24 Omni 视觉分析服务接入

- 代码默认 gpt-4o 不代表实际配置；只读查询开发预览确认 VLM 为 gpt-5.6-sol、凭据存在。用户选择沿用后台当前模型并先验图片能力。
- 模型凭据留在 Nova；Omni 仅持服务令牌。图片分析使用现有 AsyncTask 异步处理、固定工作区权限与独立额度；不改变原产品模型配置。
- 服务器 POTW 四个采集文件与本地现有改动哈希一致；本轮部署保留这些未提交的用户改动。


## 2026-10-28 Studio writing and import boundaries

Writing results remain suggestions until explicit adoption. Durable mutation identity prevents a lost acknowledgement from creating another paid request. Canvas programmatic focus is separate from explicit target selection. Grouping source suggestions must retain each underlying rule. New import tasks recheck access before provider use and result persistence; a consumed provider call remains recorded if the result is rejected.

## 2026-10-26 B2B 交付范围

main 为 d896d7c，开发版为 c13a7c0。独立工作区以 main 为基线迁移非灵感功能，避免将灵感导航、后端与数据库迁移带入本次交付。原工作区改动全部保留。

## 2026-10-29 PR #68 merge boundaries

The source f83a8a9 and main 632ac2f contain parallel/cherry-picked history. Resolving only conflict markers in OwnedEditorClient would leave obsolete panel JSX beside the new workbench, so the reviewed development editor and its integration fixture are kept together. Main contributes enterprise provisioning, three copywriting inbox regressions and release-entry integrity checks. The inbox CI expectation is therefore 19, not the development branch's 16. This PR includes the development inspiration/Omni code; October 26/27 release-isolation notes describe those earlier deliveries, not this PR. Existing runtime enablement and membership checks are retained.
