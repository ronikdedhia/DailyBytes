import { logger } from '../../../utils/logger';
import { newsDataService } from '../../../services/newsdata.service';
import { rssService, RSS_FEEDS, MARKET_FEEDS } from '../../../services/rss.service';
import { feedHealthService } from '../../../services/feed-health.service';
import { Article } from '../../../types';
import { PipelineState, PipelineError } from '../state';

export async function fetchNode(state: PipelineState): Promise<Partial<PipelineState>> {
  try {
    let rawArticles: Article[] = [];

    if (state.source === 'newsdata') {
      rawArticles = await newsDataService.fetchLatestNews(10);
    } else if (state.source === 'rss' || state.source === 'markets') {
      const { articles, status } = await rssService.fetchWithStatus(state.source === 'rss' ? RSS_FEEDS : MARKET_FEEDS);
      rawArticles = articles;
      await feedHealthService.record(status).catch((err) => logger.warn(`⚠ [fetch] feed health not saved: ${err.message}`));
    }

    if (rawArticles.length === 0) {
      logger.warn(`⚠️ [fetch] 0 articles from ${state.source} — API returned empty`);
    } else {
      logger.info(`📡 [fetch] ${rawArticles.length} articles from ${state.source}`);
      logger.info(`📡 [fetch] sample URLs: ${rawArticles.slice(0, 3).map(a => a.url).join(' | ')}`);
    }
    return { rawArticles };
  } catch (error: any) {
    const err: PipelineError = { articleUrl: '', stage: 'fetch', message: error.message };
    logger.error(`❌ [fetch] failed: ${error.message}`);
    return { rawArticles: [], errors: [err] };
  }
}
