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
