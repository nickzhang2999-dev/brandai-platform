import { beforeEach, describe, expect, it, vi } from "vitest";
import { configuredUpgradeContact } from "../../../apps/web/src/lib/brandai-nav";

const f = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/settings", () => ({ isRegistrationOpen: f.open }));
import { GET } from "../../../apps/web/src/app/api/auth/registration/route";

describe("public registration display flag", () => {
  beforeEach(() => { f.open.mockReset(); });
  it.each([true, false])("exposes only the %s flag with no cached response", async open => {
    f.open.mockResolvedValue(open);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ registrationOpen: open });
  });
  it("fails closed without exposing settings errors", async () => {
    f.open.mockRejectedValue(new Error("private database configuration"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ registrationOpen: false });
  });
});

describe("configured upgrade contact", () => {
  it.each([undefined, "", "  ", "sales", "sales@example.invalid?body=wrong", "a@b.invalid&cc=x", "sales\n@example.invalid"])("hides unusable contact %s", value => {
    expect(configuredUpgradeContact(value)).toBeNull();
  });
  it("accepts a trimmed ordinary mailbox", () => {
    expect(configuredUpgradeContact(" support+team@example.invalid ")).toBe("support+team@example.invalid");
  });
});
