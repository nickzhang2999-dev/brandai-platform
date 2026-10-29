# NovartLab / DeepFlare production release

The release target is `brandai-novartlab-local-prod`. The standard project-owned
entry is `cds-release.sh`, with CDS `project-script` and scriptFile `cds-release.sh`.
CDS checks same-commit CI, creates an immutable worktree, verifies the script body
hash, then executes check and deploy. The project script owns Compose project
`brandai-prod`, the production Compose, migrations and public-resource checks.
No independently edited `/opt/.../*.sh` release script is used. The 2026-10-20
generated-compose migration was the preceding step, superseded by this contract.

Both CI pipelines verify the executable entry in the selected Git commit before
installing dependencies. The script's `check` also rejects a modified release
entry and prints its full commit and SHA-256. A CDS “missing cds-release.sh” error
must be compared with that exact commit and script path: `c72157be22b8` already
contains the executable root entry. Do not replace production with an older
server-owned script to bypass a checkout or platform lookup error.

## Stable production state

- Private settings remain in `/opt/brandai-platform-prod/.env`; do not commit them.
- PostgreSQL uses existing external volume `brandai-prod_pgdata`.
- Redis uses existing external volume `brandai-prod_redisdata`.
- Missing volumes fail the release rather than creating an empty replacement.
- Public ingress remains on loopback port 13000; Web diagnostics use 13002.
- The existing TLS gateway and certificates are retained. Canonical origin is
  `https://deepflare.cn`; `https://deepflare.com.cn` and `https://www.novartlab.com`
  redirect to it. AI/worker/database/Redis have no public host port.
- The production queue is explicitly `brandai-prod`, separate from previews.
- Production guards retain the previous main-only publishing restriction.

## Publishing from CDS

1. Push the intended code normally, allow CI and immutable Web/AI images to finish.
   PR CI and image CI both run `bash cds-release.sh check` and
   `node --test scripts/test-project-release.mjs`. Do not skip either gate.
2. Wait until the main preview runs that exact commit.
3. Open CDS, select main, select NovartLab production, run preflight, then publish.
4. A successful release means Compose waited for Postgres/Redis, completed the
   one-shot schema migration **before** starting Worker, then waited for AI, Worker and
   Web readiness, then a one-shot check verified the served Studio manifest.
   Images are pinned to `CDS_COMMIT_SHA`; Worker reports the same commit and queue.
5. Use CDS release history to roll back to a successful **dynamic** release. CDS
   replays its commit/strategy; the same external volumes/settings are reused.

The one-shot check runs again for every `CDS_RELEASE_ID`, including same-commit
releases. Artifact checks follow the image manifest; retiring a legacy worker or
adding a resource does not require a production-host script edit. The entry HTML
is authenticated, so its bytes are checked in-image and public assets over HTTP.
Nginx refreshes Docker DNS when Web is recreated during a release or rollback.

## First migration and recovery boundary

Before switching the target, retain its old configuration, old image references,
production Compose/edge config, a PostgreSQL dump, and Redis persisted data. Verify
the candidate configuration and artifact checks first. Existing production data
must be used; do not seed, clone a preview database, or call paid providers.

The first dynamic release is the rollback baseline: older releases lack this
versioned production Compose and use the old strategy. Keep the old migration
backup for administrator recovery; normal releases/rollbacks after migration use
CDS. Rollback does not reverse database schema migrations: later destructive
schema changes need their own compatible data-migration plan.

Checks: `node --test scripts/test-novart-production.mjs`, full repository gates,
real CDS preflight/release/history, container image revisions, persistent volume
identity, all three HTTPS origins and served-resource digests. Unit fixtures only
test deployment guards; they are not provider or business-data acceptance.
