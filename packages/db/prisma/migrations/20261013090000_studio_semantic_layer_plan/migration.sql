-- NULL remains the legacy manual-count protocol. New AUTO tasks persist their
-- once-claimed semantic analysis before invoking the paid decomposition model.
ALTER TABLE "StudioDecompositionRequest" ADD COLUMN "planningJson" JSONB;
