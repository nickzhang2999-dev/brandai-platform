/**
 * Shared lexical-hit helpers for the generation workspace sidebars
 * (rule-constraints-sidebar + brand-system-sidebar). Both rails do the same
 * cheap, client-side "is this rule relevant to what the user is typing?" check
 * against the brief text — extracted here so the tokenizer and matcher can't
 * drift between the two files.
 */

/**
 * Pull 2+ char tokens out of the brief. Splits on CJK + ASCII punctuation and
 * whitespace, then filters out 1-char fragments so a bare "白" doesn't flag
 * every white-background rule.
 */
export function tokensFrom(text: string): string[] {
  if (!text) return [];
  return text
    .split(/[\s,，。.;；:：!！?？/、|｜()（）"'""''<>《》【】\[\]{}]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * True when the (case-insensitive) summary contains any of the brief tokens.
 * Empty tokens or empty summary → no hit.
 */
export function summaryMatchesTokens(
  summary: string | null | undefined,
  tokens: string[],
): boolean {
  if (tokens.length === 0) return false;
  const hay = (summary ?? "").toLowerCase();
  if (!hay) return false;
  return tokens.some((t) => hay.includes(t.toLowerCase()));
}
