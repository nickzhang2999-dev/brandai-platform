# Integration findings

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
