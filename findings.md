# Integration findings

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
