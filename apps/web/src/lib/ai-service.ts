import { resolve4 } from "node:dns/promises";

export const REQUIRED_AI_PARSER_REVISION = "grounded-six-slot-r1";

const CONFIGURED_BASE =
  process.env.BRANDAI_AI_SERVICE_URL ??
  process.env.AI_SERVICE_URL ??
  "http://localhost:8000";
const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

export type AiServiceResolution = {
  base: string;
  source: "configured" | "revision-match" | "fallback";
  parserRevision?: string;
};

let cachedResolution: { value: AiServiceResolution; expiresAt: number } | null =
  null;

function candidateBase(configured: URL, address: string): string {
  const candidate = new URL(configured.toString());
  candidate.hostname = address;
  return candidate.toString().replace(/\/$/, "");
}

async function probe(base: string): Promise<AiServiceResolution | null> {
  try {
    const response = await fetch(`${base}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { parserRevision?: unknown };
    return {
      base,
      source: "revision-match",
      parserRevision:
        typeof body.parserRevision === "string"
          ? body.parserRevision
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * CDS historically attached every branch to one Docker network. The bare
 * service alias `ai` can therefore resolve to several branch containers and
 * round-robin into stale code. Resolve every A record and select the service
 * that advertises the parser contract required by this web/worker revision.
 *
 * Explicit non-`ai` URLs remain authoritative for local, production, and
 * operator-managed deployments.
 */
export async function resolveAiService(): Promise<AiServiceResolution> {
  const now = Date.now();
  if (cachedResolution && cachedResolution.expiresAt > now) {
    return cachedResolution.value;
  }

  const configured = new URL(CONFIGURED_BASE);
  if (configured.hostname !== "ai") {
    const value: AiServiceResolution = {
      base: CONFIGURED_BASE.replace(/\/$/, ""),
      source: "configured",
    };
    cachedResolution = { value, expiresAt: now + CACHE_MS };
    return value;
  }

  try {
    const addresses = [...new Set(await resolve4(configured.hostname))].sort();
    const candidates = addresses.map((address) =>
      candidateBase(configured, address),
    );
    const results = await Promise.all(candidates.map(probe));
    const match = results.find(
      (result) =>
        result?.parserRevision === REQUIRED_AI_PARSER_REVISION,
    );
    if (match) {
      cachedResolution = { value: match, expiresAt: now + CACHE_MS };
      return match;
    }
  } catch {
    // Docker DNS can be temporarily unavailable during a rolling deploy.
  }

  const value: AiServiceResolution = {
    base: CONFIGURED_BASE.replace(/\/$/, ""),
    source: "fallback",
  };
  cachedResolution = { value, expiresAt: now + 2_000 };
  return value;
}
