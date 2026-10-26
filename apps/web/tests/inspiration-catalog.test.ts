import { describe, expect, it } from 'vitest';
import type { InspirationCaseCard } from '@brandai/contracts';
import { catalogKeywordScore, catalogMetadata, filterCatalog, tagLabel } from '@/lib/inspiration/catalog';

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
  it('keeps deterministic ordering, preserves inputs and bounds results', () => {
    const cards = Array.from({ length: 205 }, (_, n) => card(`case-${String(n).padStart(3, '0')}`)).reverse();
    const first = cards[0]; expect(filterCatalog(cards)).toHaveLength(200);
    expect(filterCatalog(cards)[0]?.caseId).toBe('case-000'); expect(cards[0]).toBe(first);
  });
});
