import { isRegistrationOpen } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Public display flag only. POST /auth/register still owns authorization. */
export async function GET() {
  try {
    return Response.json({ registrationOpen: await isRegistrationOpen() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ registrationOpen: false }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
