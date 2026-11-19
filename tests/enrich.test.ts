import { describe, it, expect, vi, beforeEach } from 'vitest';

const fallback = vi.hoisted(() => ({ calls: [] as string[] }));
const once = vi.hoisted(() => ({ value: null as any, fail: false }));
vi.mock('../src/chains/enrich.chain', async (orig) => ({
  ...(await orig<any>()),
  enrichArticleOnce: vi.fn(async () => { if (once.fail) throw new Error('groq down'); return once.value; }),
}));
const track = vi.hoisted(() => (name: string, value: unknown) => vi.fn(async () => { fallback.calls.push(name); return value; }));
vi.mock('../src/chains/title.chain', () => ({ summarizeTitle: track('title', 'Fallback title') }));
vi.mock('../src/chains/summarize.chain', () => ({ summarizeText: track('summary', 'Fallback summary') }));
vi.mock('../src/chains/hashtag.chain', () => ({ generateHashtags: track('hashtags', ['#a']) }));
vi.mock('../src/chains/analyze.chain', () => ({ analyzeArticle: track('analyze', { sentiment: 'negative', entities: [] }) }));
vi.mock('../src/chains/bias.chain', () => ({ detectBias: track('bias', { label: 'left', score: 70 }) }));
vi.mock('../src/chains/why-it-matters.chain', () => ({ generateWhyItMatters: track('why', 'why') }));
vi.mock('../src/chains/eli5.chain', () => ({ generateELI5: track('eli5', 'eli5') }));
vi.mock('../src/chains/questions.chain', () => ({ generateQuestions: track('questions', []) }));
vi.mock('../src/services/embedding.service', () => ({ embedText: vi.fn(async () => []) }));

import { parseEnrichResult } from '../src/chains/enrich.chain';
import { enrichFields } from '../src/agents/pipeline/nodes/enrich.node';

const summary = 'The Reserve Bank of India kept its key lending rate unchanged at 6.5 percent for the fourth meeting in a row, citing food inflation above target, and signalled a possible cut next year if prices ease.';
const GOOD = {
  title: 'RBI repo rate', summary, hashtags: ['#RBI', 'RepoRate', '#Inflation', '#Economy', '#Extra'],
  sentiment: 'neutral', entities: [{ name: 'RBI', type: 'company' }, { name: 'x', type: 'alien' }],
  bias: { label: 'center', score: 140 }, why_it_matters: 'Loans stay costly for now.', eli5: 'The bank kept prices of loans the same.',
  questions: [{ q: 'Why hold?', a: 'Inflation.' }, { q: 'What next?', a: 'A cut maybe.' }],
};

describe('parseEnrichResult', () => {
  it('keeps valid fields and normalises them', () => {
    const r = parseEnrichResult(GOOD);
    expect(r.hashtags).toEqual(['#RBI', '#RepoRate', '#Inflation', '#Economy']);
    expect(r.entities).toEqual([{ name: 'RBI', type: 'company' }]);
    expect(r.bias).toEqual({ label: 'center', score: 100 });
    expect(r.whyItMatters).toBe('Loans stay costly for now');
    expect(r.questions).toHaveLength(2);
  });
  it('nulls fields that are missing or off-spec', () => {
    const r = parseEnrichResult({ ...GOOD, summary: 'too short', sentiment: 'happy', bias: { label: 'up' }, questions: [{ q: 'x' }] });
    expect(r.summary).toBeNull();
    expect(r.sentiment).toBeNull();
    expect(r.bias).toBeNull();
    expect(r.questions).toBeNull();
    expect(parseEnrichResult('not json')).toMatchObject({ title: null, summary: null, eli5: null });
  });
});

describe('enrichFields', () => {
  beforeEach(() => { fallback.calls.length = 0; once.fail = false; once.value = parseEnrichResult(GOOD); });

  it('uses the single call and no per-field chains when everything is valid', async () => {
    const { fields, fallbacks } = await enrichFields('Headline', 'Body');
    expect(fallbacks).toEqual([]);
    expect(fallback.calls).toEqual([]);
    expect(fields.summary).toBe(summary);
  });

  it('falls back only for the fields that came back bad', async () => {
    once.value = parseEnrichResult({ ...GOOD, summary: 'short', bias: null });
    const { fields, fallbacks } = await enrichFields('Headline', 'Body');
    expect(fallback.calls.sort()).toEqual(['bias', 'summary']);
    expect(fallbacks.sort()).toEqual(['bias', 'summary']);
    expect(fields.summary).toBe('Fallback summary');
    expect(fields.bias).toEqual({ label: 'left', score: 70 });
    expect(fields.title).toBe('RBI repo rate');
  });

  it('runs every per-field chain when the single call fails', async () => {
    once.fail = true;
    const { fields } = await enrichFields('Headline', 'Body');
    expect(fallback.calls.sort()).toEqual(['analyze', 'bias', 'eli5', 'hashtags', 'questions', 'summary', 'title', 'why']);
    expect(fields.sentiment).toBe('negative');
  });
});
