-- Keep historical shared errors and successful content timestamps intact.
-- New channel observations remain unknown until a real check has completed.
ALTER TABLE "InspirationState"
  ADD COLUMN "lastSyncAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastSyncFailedAt" TIMESTAMP(3),
  ADD COLUMN "syncError" TEXT,
  ADD COLUMN "lastWithdrawalAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastWithdrawalAt" TIMESTAMP(3),
  ADD COLUMN "lastWithdrawalFailedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalError" TEXT;
