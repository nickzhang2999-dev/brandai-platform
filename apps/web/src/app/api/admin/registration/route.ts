import { UpdateRegistrationInput } from "@brandai/contracts";
import { handleError, ok, parse } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { isRegistrationOpen, setRegistrationOpen } from "@/lib/settings";

/**
 * Admin-only — read (GET) / toggle (PATCH) the self-serve registration switch.
 * Default CLOSED; only a platform admin can open public sign-ups. Gated via
 * requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok({ registrationOpen: await isRegistrationOpen() });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const admin = await requireAdmin();
    const input = parse(UpdateRegistrationInput, await req.json());
    await setRegistrationOpen(input.registrationOpen, admin);
    return ok({ registrationOpen: input.registrationOpen });
  } catch (err) {
    return handleError(err);
  }
}
