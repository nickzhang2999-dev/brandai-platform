import type { InspirationCaseCard } from '@brandai/contracts';

/** Labels mirror Omni's versioned nova-1 vocabulary; values remain protocol IDs. */
export const taxonomy = {
  industry: { 'food-beverage': '食品饮料', fashion: '时尚服饰', beauty: '美妆护理', culture: '文化艺术', technology: '科技', lifestyle: '生活方式', services: '服务业', other: '其他' },
  medium: { packaging: '包装', identity: '品牌识别', editorial: '编辑出版', poster: '海报', digital: '数字界面', spatial: '空间导视' },
  task: { launch: '新品上市', rebrand: '品牌焕新', series: '系列扩展', campaign: '传播活动' },
} as const;
export const contentTypes = { advertisement: '广告案例', reference: '设计参考', unknown: '类型待补充' } as const;
export type CatalogFilters = { q?: string; kind?: string; industry?: string; medium?: string; task?: string };
export function tagLabel(group: string, value: string): string {
  return (taxonomy as Record<string, Record<string, string>>)[group]?.[value] ?? value;
}
const aliases: Record<string, string[]> = {
  'food-beverage': ['茶饮', '餐饮', '食品', '饮品'], fashion: ['服装', '时装'], beauty: ['护肤', '化妆品'],
  culture: ['展览', '博物馆', '艺术'], technology: ['数码', '软件'], lifestyle: ['家居', '生活用品'], services: ['酒店', '服务'],
  packaging: ['包装设计'], identity: ['品牌视觉', 'VI', '标志'], editorial: ['书籍', '杂志'], poster: ['招贴'],
  digital: ['网页', '界面'], spatial: ['导视', '环境图形'], rebrand: ['品牌升级'], series: ['系列化'], campaign: ['营销活动'],
};

export function catalogMetadata(record: { tags: Record<string, string[]>; editorial?: unknown }) {
  const editorial = record.editorial && typeof record.editorial === 'object'
    ? record.editorial as Record<string, unknown> : {};
  const contentType = editorial.material_kind === 'advertisement' || editorial.material_kind === 'reference'
    ? editorial.material_kind : 'unknown';
  const legacy = editorial.legacy_medium_fallback === true;
  // This projection never edits signed bytes. Historic compatibility defaults
  // are not evidence about a case's actual industry or medium.
  const tags = legacy ? { ...record.tags, industry: [], medium: [], task: [] } : record.tags;
  const taxonomyStatus = legacy ? 'legacy' : editorial.taxonomy_reviewed === true ? 'reviewed' : 'provided';
  return { contentType, taxonomyStatus, tags } as const;
}

export function catalogKeywordScore(card: InspirationCaseCard, query: string) {
  const tagTerms = Object.entries(card.tags).flatMap(([group, values]) => values.flatMap(value => [value, tagLabel(group, value), ...(aliases[value] ?? [])]));
  const text = [card.title, card.summary, card.brandOrTeam, ...tagTerms, ...card.claims.map(claim => claim.text)].join(' ').toLocaleLowerCase();
  const words = query.toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/gu) ?? [];
  const terms = words.flatMap(word => /[\u3400-\u9fff]/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))] : [word]);
  return [...new Set(terms)].reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
}

export function filterCatalog(cards: InspirationCaseCard[], filters: CatalogFilters = {}) {
  const query = filters.q?.trim() ?? '';
  return cards.filter(card => (!filters.kind || (card.contentType ?? 'unknown') === filters.kind)
    && (!filters.industry || card.tags.industry?.includes(filters.industry))
    && (!filters.medium || card.tags.medium?.includes(filters.medium))
    && (!filters.task || card.tags.task?.includes(filters.task)))
    .map(card => ({ card, score: catalogKeywordScore(card, query) }))
    .filter(row => !query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.card.caseId.localeCompare(b.card.caseId))
    .slice(0, 200).map(row => row.card);
}
