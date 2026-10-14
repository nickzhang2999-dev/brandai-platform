-- Product policy, explicitly requested on 2026-10-13: all current plans allow
-- multiple brands without a brand-count cap. -1 is the existing UNLIMITED
-- sentinel. Keep generation quotas, prices, subscriptions, memberships and
-- all brand/project/asset records intact; do not reseed customer workspaces.
-- Only this one-time policy update changes existing plan limits. Administrators
-- can still deliberately configure a new limit through the existing plan API.
UPDATE "Plan"
SET "maxWorkspaces" = -1
WHERE "maxWorkspaces" <> -1;
