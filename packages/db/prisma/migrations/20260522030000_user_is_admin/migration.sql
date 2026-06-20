-- Platform admin flag. First user to register becomes admin (bootstrap), unless
-- ADMIN_EMAILS env is set (then that allowlist is authoritative). Additive.
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
