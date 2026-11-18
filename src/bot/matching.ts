import { ALLOWED_CATEGORIES } from '../constants/categories';

export const MAX_TERMS_PER_KIND = 10;
const TERM_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,38}[\p{L}\p{N}.]$/u;

export interface MatchableArticle {
  title: string;
  content?: string | null;
  hashtags?: string | null;
  category?: string | null;
}

/** Clean a user-supplied topic / alert term, or null if it isn't acceptable. */
export function normalizeTerm(raw: string | undefined): string | null {
  const term = (raw || '').trim().replace(/^#/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return TERM_PATTERN.test(term) ? term : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does the article match the term? A category name ("sports") matches the
 * category; otherwise the term must appear as a whole word in the title or
 * summary ("ai" must not match "said"), or inside a hashtag ("cricket"
 * matches #IndiaCricket).
 */
export function matchesTerm(article: MatchableArticle, term: string): boolean {
  const t = term.toLowerCase();
  if ((ALLOWED_CATEGORIES as readonly string[]).includes(t) && article.category?.toLowerCase() === t) return true;
  const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(t)}($|[^\\p{L}\\p{N}])`, 'iu');
  if (word.test(article.title) || word.test(article.content || '')) return true;
  const compact = t.replace(/[^\p{L}\p{N}]/gu, '');
  return compact.length >= 3 && (article.hashtags || '').toLowerCase().split(/\s+/).some((tag) => tag.replace(/^#/, '').includes(compact));
}

export function matchesAny(article: MatchableArticle, terms: string[]): string[] {
  return terms.filter((term) => matchesTerm(article, term));
}
