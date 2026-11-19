import { ChatPromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { createLLM, RETRY_CONFIG } from '../config/llm.config';

/**
 * Every AI field for one article in a single Groq call. The eight
 * single-purpose chains repeated the article text eight times; this sends it
 * once. Fields that come back missing or invalid are null, so the caller can
 * fill just those from the single-purpose chains.
 */
const enrichChain = ChatPromptTemplate.fromMessages([
  ['system', `You are a news editor. Read the article and return ONLY one JSON object, no markdown, no explanation:
{{
  "title": "3-5 word topic label using only words from the headline",
  "summary": "50-70 word summary, main facts only, no inferences",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4"],
  "sentiment": "positive" | "neutral" | "negative",
  "entities": [{{"name": "...", "type": "person" | "company" | "place"}}],
  "bias": {{"label": "left" | "center" | "right", "score": 0-100}},
  "why_it_matters": "one sentence, at most 20 words, impact first, no final period",
  "eli5": "2-3 simple sentences a 10-year-old understands",
  "questions": [{{"q": "...", "a": "..."}}, {{"q": "...", "a": "..."}}]
}}
Rules:
- entities: at most 5 real names clearly mentioned; [] if none
- bias.label is the political lean of the framing, not the topic; "center" when neutral; score is your confidence
- questions: 2 specific questions a thoughtful reader would ask (why, who benefits, what next); answers at most 20 words, based only on the article`],
  ['human', 'Headline: {headline}\n\nArticle: {body}'],
])
  .pipe(createLLM('enrich'))
  .pipe(new JsonOutputParser())
  .withRetry(RETRY_CONFIG);

export interface EnrichFields {
  title: string | null;
  summary: string | null;
  hashtags: string[] | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  entities: Array<{ name: string; type: string }> | null;
  bias: { label: 'left' | 'center' | 'right'; score: number } | null;
  whyItMatters: string | null;
  eli5: string | null;
  questions: Array<{ q: string; a: string }> | null;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Validate the model's JSON field by field; anything off-spec becomes null. */
export function parseEnrichResult(raw: any): EnrichFields {
  const r = raw && typeof raw === 'object' ? raw : {};
  const title = str(r.title);
  const summary = str(r.summary);
  const hashtags = Array.isArray(r.hashtags)
    ? r.hashtags.map((t: unknown) => (typeof t === 'string' ? t.trim().replace(/\s+/g, '') : ''))
        .filter((t: string) => /^#?[\p{L}\p{N}_]{2,40}$/u.test(t))
        .map((t: string) => (t.startsWith('#') ? t : `#${t}`))
        .slice(0, 4)
    : [];
  const entities = Array.isArray(r.entities)
    ? r.entities.filter((e: any) => typeof e?.name === 'string' && ['person', 'company', 'place'].includes(e?.type))
        .map((e: any) => ({ name: e.name.trim(), type: e.type })).slice(0, 5)
    : null;
  const score = Number(r.bias?.score);
  const bias = ['left', 'center', 'right'].includes(r.bias?.label) && Number.isFinite(score)
    ? { label: r.bias.label, score: Math.max(0, Math.min(100, Math.round(score))) }
    : null;
  const questions = Array.isArray(r.questions)
    ? r.questions.filter((x: any) => str(x?.q) && str(x?.a)).map((x: any) => ({ q: x.q.trim(), a: x.a.trim() })).slice(0, 2)
    : [];
  const why = str(r.why_it_matters);
  return {
    title: title && words(title) <= 8 ? title.replace(/[."]+$/g, '') : null,
    summary: summary && words(summary) >= 20 && words(summary) <= 110 ? summary : null,
    hashtags: hashtags.length >= 2 ? hashtags : null,
    sentiment: ['positive', 'neutral', 'negative'].includes(r.sentiment) ? r.sentiment : null,
    entities,
    bias,
    whyItMatters: why ? why.replace(/\.$/, '') : null,
    eli5: str(r.eli5),
    questions: questions.length === 2 ? questions : null,
  };
}

export async function enrichArticleOnce(headline: string, body: string): Promise<EnrichFields> {
  const raw = await enrichChain.invoke({ headline: headline.slice(0, 300), body: body.slice(0, 1500) });
  return parseEnrichResult(raw);
}
