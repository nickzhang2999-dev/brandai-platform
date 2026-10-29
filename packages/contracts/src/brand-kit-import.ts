import { z } from "zod";
import { RuleType } from "./enums";

// Explicit Brand Kit intent only; omitted fields preserve the library's legacy
// all-category recognition path. mutationId identifies one user action.
export const BrandKitRecognizeInput = z.object({ assetIds: z.array(z.string().min(1)).min(1).max(50),
  targetType: RuleType.optional(), mutationId: z.string().uuid().optional() });
export const BrandKitParseManualInput = z.object({ assetId: z.string().min(1),
  targetType: RuleType.optional(), mutationId: z.string().uuid().optional() });
