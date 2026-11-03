import { describe, expect, it } from 'vitest';
import type { InspirationCaseCard } from '@brandai/contracts';
import { CATALOG_MAX_PAGE_SIZE, catalogKeywordScore, catalogMetadata, filterCatalog, pageCatalog, tagLabel } from '@/lib/inspiration/catalog';

function card(id: string, overrides: Partial<InspirationCaseCard> = {}): InspirationCaseCard {
  return { caseId: id, revision: 1, title: '项目', summary: '审核案例', brandOrTeam: '团队', analysisAllowed: false,
    contentType: 'reference', taxonomyStatus: 'reviewed', tags: { industry: ['food-beverage'], medium: ['packaging'], task: ['series'] }, images: [], sources: [], claims: [], ...overrides };
}
describe('reviewed inspiration catalog', () => {
  it('projects explicit material kind and labels without changing the signed record', () => {
    const original = { tags: { industry: ['other'], medium: ['digital'] }, editorial: { material_kind: 'reference', legacy_medium_fallback: true } };
    const frozen = JSON.stringify(original), projected = catalogMetadata(original);
    expect(projected).toEqual({ contentType: 'reference', taxonomyStatus: 'legacy', tags: { industry: [], medium: [], task: [] } });
    expect(JSON.stringify(original)).toBe(frozen);
    expect(filterCatalog([card('legacy', projected)], { medium: 'digital' })).toEqual([]);
    expect(catalogKeywordScore(card('legacy', projected), '数字界面')).toBe(0);
  });
  it('does not infer an advertisement or human review when metadata is absent', () => {
    const projected = catalogMetadata({ tags: { industry: ['culture'], medium: ['poster'] } });
    expect(projected.contentType).toBe('unknown'); expect(projected.taxonomyStatus).toBe('provided');
    expect(projected.tags.medium).toEqual(['poster']);
  });
  it('matches every selected dimension together and distinguishes ads from design references', () => {
    const cards = [card('pack'), card('ad', { contentType: 'advertisement', tags: { industry: ['technology'], medium: ['poster'], task: ['campaign'] } })];
    expect(filterCatalog(cards, { kind: 'reference', industry: 'food-beverage', medium: 'packaging', task: 'series' }).map(c => c.caseId)).toEqual(['pack']);
    expect(filterCatalog(cards, { kind: 'advertisement', medium: 'packaging' })).toEqual([]);
    expect(filterCatalog(cards, { kind: 'advertisement', task: 'campaign' }).map(c => c.caseId)).toEqual(['ad']);
    expect(filterCatalog(cards, { industry: 'unsupported' })).toEqual([]);
  });
  it('finds English protocol IDs using Chinese labels and common Chinese terms', () => {
    for (const query of ['食品饮料', '茶饮', '包装', '系列扩展']) expect(filterCatalog([card('pack')], { q: query }).length).toBe(1);
    expect(tagLabel('medium', 'digital')).toBe('数字界面');
    expect(tagLabel('unknown-group', 'existing-tag')).toBe('existing-tag');
  });
  it('keeps deterministic ordering and preserves inputs without silently truncating', () => {
    const cards = Array.from({ length: 205 }, (_, n) => card(`case-${String(n).padStart(3, '0')}`)).reverse();
    const first = cards[0];
    // filterCatalog is the pure match+sort step. It must not cap the result:
    // a silent cap here is what made 229 stored cases render as 200.
    expect(filterCatalog(cards)).toHaveLength(205);
    expect(filterCatalog(cards)[0]?.caseId).toBe('case-000'); expect(cards[0]).toBe(first);
  });
  it('pages a filtered catalog by caseId cursor and reports the full matched total', () => {
    const cards = Array.from({ length: 205 }, (_, n) => card(`case-${String(n).padStart(3, '0')}`));
    const first = pageCatalog(cards, {}, { limit: 50 });
    expect(first.cases).toHaveLength(50); expect(first.matchedCount).toBe(205); expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('case-049');
    const second = pageCatalog(cards, {}, { limit: 50, cursor: first.nextCursor });
    expect(second.cases[0]?.caseId).toBe('case-050'); expect(second.nextCursor).toBe('case-099');
    // Walk to the end: every case is reachable, and the last page closes the cursor.
    const ids = new Set<string>(); let page = first; let guard = 0;
    while (page.cases.length) {
      for (const item of page.cases) ids.add(item.caseId);
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); break; }
      page = pageCatalog(cards, {}, { limit: 50, cursor: page.nextCursor });
      if (++guard > 10) throw new Error('Cursor did not terminate');
    }
    expect(ids.size).toBe(205);
  });
  it('applies filters before paging so the total describes the filtered result, not the library', () => {
    const cards = [card('pack'), ...Array.from({ length: 80 }, (_, n) => card(`ad-${n}`, { contentType: 'advertisement' }))];
    const page = pageCatalog(cards, { kind: 'advertisement' }, { limit: 50 });
    expect(page.matchedCount).toBe(80); expect(page.cases).toHaveLength(50); expect(page.hasMore).toBe(true);
  });
  it('never resurrects a filtered-out cursor and never exceeds the page ceiling', () => {
    const cards = Array.from({ length: 5 }, (_, n) => card(`case-${n}`));
    // A cursor that no longer matches the filters ends the walk instead of
    // silently restarting from the top.
    expect(pageCatalog(cards, { kind: 'advertisement' }, { limit: 2, cursor: 'case-1' }).cases).toEqual([]);
    const many = Array.from({ length: CATALOG_MAX_PAGE_SIZE + 50 }, (_, n) => card(`big-${String(n).padStart(3, '0')}`));
    expect(pageCatalog(many, {}, { limit: 10_000 }).cases).toHaveLength(CATALOG_MAX_PAGE_SIZE);
  });
});
