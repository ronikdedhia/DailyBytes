import { logger } from '../../../utils/logger';
import { embedText } from '../../../services/embedding.service';
import { summarizeText } from '../../../chains/summarize.chain';
import { summarizeTitle } from '../../../chains/title.chain';
import { generateHashtags } from '../../../chains/hashtag.chain';
import { analyzeArticle } from '../../../chains/analyze.chain';
import { detectBias } from '../../../chains/bias.chain';
import { generateWhyItMatters } from '../../../chains/why-it-matters.chain';
import { generateELI5 } from '../../../chains/eli5.chain';
import { generateQuestions } from '../../../chains/questions.chain';
import { enrichArticleOnce, EnrichFields } from '../../../chains/enrich.chain';
import { EnrichedArticle, PipelineState, PipelineError } from '../state';

const EMPTY: EnrichFields = {
  title: null, summary: null, hashtags: null, sentiment: null, entities: null,
  bias: null, whyItMatters: null, eli5: null, questions: null,
};

/**
 * One Groq call for every field (enrich.chain). Only fields that come back
 * missing or invalid are filled by the old single-purpose chains, and if the
 * combined call fails outright, all of them run as before.
 */
export async function enrichFields(title: string, body: string): Promise<{ fields: Required<{ [K in keyof EnrichFields]: NonNullable<EnrichFields[K]> }>; fallbacks: string[] }> {
  const once = await enrichArticleOnce(title, body).catch((err) => {
    logger.warn(`⚠ [enrich] combined call failed, using per-field chains: ${err.message}`);
    return EMPTY;
  });
  const fallbacks: string[] = [];
  const fill = async <T>(name: keyof EnrichFields, value: T | null, run: () => Promise<T>, fallback: T): Promise<T> => {
    if (value !== null) return value;
    fallbacks.push(name);
    return run().catch(() => fallback);
  };

  const titleOut = await fill('title', once.title, () => summarizeTitle(title), title.slice(0, 50));
  const summaryOut = await fill('summary', once.summary, () => summarizeText(body), title);
  const needAnalysis = once.sentiment === null || once.entities === null;
  const analysis = needAnalysis ? await analyzeArticle(titleOut, summaryOut) : null;
  if (needAnalysis) fallbacks.push('sentiment/entities');

  const [hashtags, bias, whyItMatters, eli5, questions] = await Promise.all([
    fill('hashtags', once.hashtags, () => generateHashtags(title), ['#news']),
    fill('bias', once.bias, () => detectBias(titleOut, summaryOut) as Promise<NonNullable<EnrichFields['bias']>>, { label: 'center', score: 50 } as const),
    fill('whyItMatters', once.whyItMatters, () => generateWhyItMatters(titleOut, summaryOut), ''),
    fill('eli5', once.eli5, () => generateELI5(titleOut, summaryOut), ''),
    fill('questions', once.questions, () => generateQuestions(titleOut, summaryOut), []),
  ]);

  return {
    fields: {
      title: titleOut,
      summary: summaryOut,
      hashtags,
      sentiment: once.sentiment ?? analysis?.sentiment ?? 'neutral',
      entities: once.entities ?? analysis?.entities ?? [],
      bias,
      whyItMatters,
      eli5,
      questions,
    },
    fallbacks,
  };
}

// Called once per article via LangGraph Send API fan-out
export async function enrichArticleNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const article = state.currentArticle;
  if (!article) return {};
  try {
    logger.info(`⚙ [enrich] ${article.title.slice(0, 60)}`);
    const { fields, fallbacks } = await enrichFields(article.title, article.content || article.title);
    if (fallbacks.length) logger.info(`   [enrich] per-field fallback for: ${fallbacks.join(', ')}`);
    const embedding = await embedText(`${fields.title} ${fields.summary}`).catch(() => [] as number[]);

    const enriched: EnrichedArticle = {
      raw: article,
      titleSummary: fields.title,
      contentSummary: fields.summary,
      hashtags: fields.hashtags,
      sentiment: fields.sentiment,
      entities: fields.entities,
      biasLabel: fields.bias.label,
      biasScore: fields.bias.score,
      whyItMatters: fields.whyItMatters,
      eli5: fields.eli5,
      questions: fields.questions,
      embedding,
    };
    // append reducer merges this into the shared enrichedArticles array
    return { enrichedArticles: [enriched] };
  } catch (error: any) {
    const err: PipelineError = { articleUrl: article.url, stage: 'enrich', message: error.message };
    logger.warn(`⚠ [enrich] failed for ${article.url}: ${error.message}`);
    return { errors: [err] };
  }
}
