-- A provider POST with an unknown result must not be replayed after a crash.
ALTER TABLE "StudioConversationMessage" ADD COLUMN "intentModelStartedAt" TIMESTAMP(3);
