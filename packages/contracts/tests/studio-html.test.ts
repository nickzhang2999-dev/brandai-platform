import { describe, expect, it } from "vitest";
import { studioHtml } from "../../../apps/web/src/lib/studio-assets";

describe("owned Studio authenticated HTML bootstrap", () => {
  it("keeps untrusted project text inside escaped JSON before deferred owned scripts", () => {
    const projectName = '</script><script>synthetic()</script>\u2028\u2029';
    const bootstrapSha256 = "b".repeat(64);
    const html = studioHtml('<html><head><script src="/home-start-studio.js"></script></head><body></body></html>', { projectName }, bootstrapSha256);
    expect(html).not.toContain('</script><script>synthetic()');
    expect(html).toContain('type="application/x-novart" src="/home-start-studio.js"');
    const context = html.match(/<script id="novart-product-context" type="application\/json">([^<]*)<\/script>/)?.[1];
    expect(context).toBeDefined();
    expect(JSON.parse(context!).projectName).toBe(projectName);
    expect(html).toContain(`defer src="/novart-product-bootstrap.js?v=${bootstrapSha256}"`);
    expect(html.indexOf('id="novart-product-context"')).toBeLessThan(html.indexOf('defer src="/novart-product-bootstrap.js?v='));
  });

  it("changes the bootstrap request when the compiled content hash changes", () => {
    const source = "<html><head></head><body></body></html>";
    const previous = studioHtml(source, {}, "a".repeat(64));
    const current = studioHtml(source, {}, "b".repeat(64));
    expect(previous).not.toBe(current);
    expect(current).toContain(`src="/novart-product-bootstrap.js?v=${"b".repeat(64)}"`);
    expect(current).not.toContain('src="/novart-product-bootstrap.js"');
  });

  it("rejects missing or malformed bootstrap hashes before emitting HTML", () => {
    const invalid: unknown[] = [undefined, null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), '" onload="synthetic()', 123];
    for (const hash of invalid) {
      expect(() => studioHtml("<html><head></head></html>", {}, hash as string)).toThrow("Invalid studio bootstrap checksum");
    }
  });
});
