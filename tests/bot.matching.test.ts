import { describe, it, expect } from 'vitest';
import { matchesTerm, normalizeTerm } from '../src/bot/matching';
import { formatArticleList } from '../src/bot/format';

describe('normalizeTerm', () => {
  it('cleans and lowercases', () => {
    expect(normalizeTerm('  #RBI ')).toBe('rbi');
    expect(normalizeTerm('Virat   Kohli')).toBe('virat kohli');
  });
  it('rejects junk', () => {
    for (const bad of ['', 'a', '<script>', 'x'.repeat(41), '!!']) expect(normalizeTerm(bad)).toBeNull();
  });
});

describe('matchesTerm', () => {
  const a = { title: 'RBI holds rates, governor said', content: 'Markets in Mumbai were flat', hashtags: '#IndiaCricket #RepoRate', category: 'business' };
  it('matches whole words in title or summary', () => {
    expect(matchesTerm(a, 'rbi')).toBe(true);
    expect(matchesTerm(a, 'mumbai')).toBe(true);
  });
  it('does not match inside other words', () => {
    expect(matchesTerm(a, 'ai')).toBe(false);
  });
  it('matches inside hashtags and multi-word hashtags', () => {
    expect(matchesTerm(a, 'cricket')).toBe(true);
    expect(matchesTerm(a, 'repo rate')).toBe(true);
  });
  it('matches category names', () => {
    expect(matchesTerm(a, 'business')).toBe(true);
    expect(matchesTerm(a, 'sports')).toBe(false);
  });
});

describe('formatArticleList', () => {
  it('escapes HTML from article text', () => {
    const html = formatArticleList('Top', [{ title: 'A <b> & B', content: 'x < y', url: 'https://e.com/?a="1"' }]);
    expect(html).toContain('A &lt;b&gt; &amp; B');
    expect(html).toContain('x &lt; y');
    expect(html).toContain('href="https://e.com/?a=&quot;1&quot;"');
    expect(html).toContain('Read on e.com');
  });
});
