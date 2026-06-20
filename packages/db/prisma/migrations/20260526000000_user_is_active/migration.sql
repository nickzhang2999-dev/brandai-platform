-- Account enabled flag for admin user-management (/admin/users). Disabled users
-- cannot sign in and are bounced from the app shell. Additive: existing rows
-- default to enabled, so no behaviour changes for current users.
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
