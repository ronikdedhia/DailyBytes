import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { StateGraph, START, END, Send } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { PipelineStateAnnotation, PipelineState, PipelineMetrics, PipelineSource } from './state';
import { startRunNode } from './nodes/start-run.node';
import { fetchNode } from './nodes/fetch.node';
import { dedupeNode } from './nodes/dedupe.node';
import { enrichArticleNode } from './nodes/enrich.node';
import { persistNode } from './nodes/persist.node';
import { notifyNode } from './nodes/notify.node';
import { finishRunNode } from './nodes/finish-run.node';
import { logger } from '../../utils/logger';

function routeAfterFetch(state: PipelineState): string {
  if (state.rawArticles.length === 0) {
    logger.warn(`⚠️ [route:fetch] 0 articles fetched — skipping to notify`);
    return 'notify';
  }
  logger.info(`➡️ [route:fetch] ${state.rawArticles.length} articles → dedupe`);
  return 'dedupe';
}

function routeAfterDedupe(state: PipelineState): string | Send[] {
  if (state.newArticles.length === 0) {
    logger.warn(`⚠️ [route:dedupe] 0 new articles after dedup — skipping to notify`);
    return 'notify';
  }
  logger.info(`➡️ [route:dedupe] ${state.newArticles.length} new articles → enrich fan-out`);
  return state.newArticles.map(article => new Send('enrich_article', { currentArticle: article }));
}

const PIPELINE_MAX_CONCURRENCY = Math.max(1, parseInt(process.env.PIPELINE_MAX_CONCURRENCY || '3', 10) || 3);

const checkpointDir = path.resolve('/tmp', 'checkpoints');
fs.mkdirSync(checkpointDir, { recursive: true });
const checkpointer = SqliteSaver.fromConnString(path.join(checkpointDir, 'pipeline.db'));

export const newsPipelineGraph = new StateGraph(PipelineStateAnnotation)
  .addNode('start_run', startRunNode)
  .addNode('fetch', fetchNode)
  .addNode('dedupe', dedupeNode)
  .addNode('enrich_article', enrichArticleNode)
  .addNode('persist', persistNode)
  .addNode('notify', notifyNode)
  .addNode('finish_run', finishRunNode)
  .addEdge(START, 'start_run')
  .addEdge('start_run', 'fetch')
  .addConditionalEdges('fetch', routeAfterFetch)
  .addConditionalEdges('dedupe', routeAfterDedupe)
  .addEdge('enrich_article', 'persist')
  .addEdge('persist', 'notify')
  .addEdge('notify', 'finish_run')
  .addEdge('finish_run', END)
  .compile({ checkpointer });

export async function runNewsPipeline(
  source: PipelineSource,
  opts: { fresh?: boolean } = {}
): Promise<PipelineMetrics> {
  // Every run gets its own thread. Reusing a date-scoped thread made a second
  // run on the same day (node-cron + external scheduler) start from START with
  // the previous run's state still in the append-reducer channels
  // (enrichedArticles, errors), so old articles were re-persisted and counted.
  // Passing new input never resumed a failed run anyway.
  const threadId = `${source}-${opts.fresh ? 'manual' : 'scheduled'}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const config = { configurable: { thread_id: threadId } };
  let finalState: PipelineState | undefined;

  // stream('updates') emits { nodeName: stateUpdate } after each node — real-time visibility
  for await (const chunk of await newsPipelineGraph.stream({ source }, {
    ...config,
    streamMode: 'updates',
    // Enrich fans out one task per article, ~8 Groq calls each. Groq's free tier
    // allows 8000 tokens/min, so a wide fan-out mostly produced 429 retries.
    maxConcurrency: PIPELINE_MAX_CONCURRENCY,
  })) {
    const [nodeName] = Object.keys(chunk);
    logger.info(`[graph:${nodeName}] ✓`);
  }

  // Read final state once after the stream ends, not on every node
  const snap = await newsPipelineGraph.getState(config);
  finalState = snap.values as PipelineState;

  return finalState?.metrics ?? { processed: 0, saved: 0, errors: 0, telegramSent: 0 };
}
