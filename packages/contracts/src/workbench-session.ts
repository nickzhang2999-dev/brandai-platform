import { z } from "zod";
import { WorkspaceRole } from "./enums";

export const SelectWorkbenchWorkspaceInput = z.object({ workspaceId: z.string().min(1).max(128) }).strict();
export const WorkbenchSession = z.object({
  user: z.object({ id: z.string(), name: z.string() }).strict(),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: WorkspaceRole }).strict()),
  activeWorkspaceId: z.string().nullable(),
}).strict();
export type WorkbenchSession = z.infer<typeof WorkbenchSession>;
