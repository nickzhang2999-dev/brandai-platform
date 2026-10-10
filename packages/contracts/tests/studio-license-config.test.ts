import { afterEach, describe, expect, it, vi } from "vitest";
import { studioHtml, studioLicenseConfig } from "../../../apps/web/src/lib/studio-assets";

afterEach(() => vi.unstubAllEnvs());

describe("product canvas license configuration", () => {
  it("reads only the dedicated server runtime setting without a vendor fallback", () => {
    vi.stubEnv("NOVART_TLDRAW_LICENSE_KEY", undefined);
    vi.stubEnv("TLDRAW_LICENSE_KEY", "unrelated-synthetic-setting");
    expect(studioLicenseConfig()).toEqual({ key: "", status: "missing" });
    vi.stubEnv("NOVART_TLDRAW_LICENSE_KEY", "synthetic-not-a-real-license");
    expect(studioLicenseConfig()).toEqual({ key: "synthetic-not-a-real-license", status: "configured" });
    vi.stubEnv("NOVART_TLDRAW_LICENSE_KEY", "");
    expect(studioLicenseConfig()).toEqual({ key: "", status: "missing" });
  });

  it("bounds type, size and control characters without returning invalid input", () => {
    const cases: unknown[] = [null, 1, true, {}, [], "x".repeat(8193), "secret\nline", "secret\u0000", "secret\u007f", "secret\u0085", "secret\u009f"];
    for (const input of cases) expect(studioLicenseConfig(input)).toEqual({ key: "", status: "invalid" });
    expect(studioLicenseConfig("x".repeat(8192)).status).toBe("configured");
    // The adapter must not edit signed data or claim that it is SDK-valid.
    expect(studioLicenseConfig(" synthetic ")).toEqual({ key: " synthetic ", status: "configured" });
  });

  it("keeps license text inside escaped JSON before deferred native scripts", () => {
    const key = '</script><script>synthetic()</script>\u2028\u2029';
    const html = studioHtml('<html><head><script src="/native.js"></script></head><body></body></html>', { canvasLicense: studioLicenseConfig(key) });
    expect(html).not.toContain('</script><script>synthetic()');
    expect(html).toContain('type="application/x-novart" src="/native.js"');
    const context = html.match(/<script id="novart-product-context" type="application\/json">([^<]*)<\/script>/)?.[1];
    expect(context).toBeDefined();
    expect(JSON.parse(context!).canvasLicense.key).toBe(key);
    expect(html.indexOf('id="novart-product-context"')).toBeLessThan(html.indexOf('defer src="/novart-product-bootstrap.js"'));
  });
});
