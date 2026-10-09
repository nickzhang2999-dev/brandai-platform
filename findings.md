# Integration findings

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
