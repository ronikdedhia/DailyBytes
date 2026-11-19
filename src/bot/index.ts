import { rawClient } from '../db/client';
import { articleService } from '../services/article.service';
import { answerFromArticles } from '../chains/ask.chain';
import { logger } from '../utils/logger';
import { BotService, registerWebhook } from './bot.service';
import { BotStore } from './bot-store';
import { botEnabled, sendHtml } from './telegram-api';

export { botEnabled };

export const botService = new BotService({
  store: new BotStore(rawClient),
  recentArticles: (limit = 100) => articleService.getRecentArticles(limit) as any,
  searchArticles: (keywords) => articleService.searchByKeywords(keywords, 5),
  answer: (question, articles) => answerFromArticles(question, articles),
  send: sendHtml,
});

/** Called on boot. Outbound network can lag right after a Render wake, so retry. */
export async function initializeTelegramBot(): Promise<void> {
  if (!botEnabled()) {
    logger.info('[bot] TELEGRAM_BOT_TOKEN not set — two-way bot disabled (channel broadcasts still work)');
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`[bot] ${await registerWebhook()}`);
      return;
    } catch (err: any) {
      logger.error(`❌ [bot] webhook registration failed (attempt ${attempt}): ${err.message}`);
      if (/already points at/.test(err.message)) return;
      await new Promise((r) => setTimeout(r, 10_000 * attempt));
    }
  }
}
