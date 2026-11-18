import { logger } from '../../../utils/logger';
import { metricsService } from '../../../services/metrics.service';
import { alertService } from '../../../services/alert.service';
import { botEnabled, botService } from '../../../bot';
import { PipelineState } from '../state';

export async function finishRunNode(state: PipelineState): Promise<Partial<PipelineState>> {
  // persist only runs when there were new articles, so fetch failures would
  // otherwise be recorded with errors=0.
  const metrics = { ...state.metrics, errors: state.errors.length };
  if (state.dbRunId) {
    const allFailed = state.metrics.saved === 0 && state.errors.length > 0;
    if (allFailed) {
      await metricsService.recordRunFailed(state.dbRunId, state.startTs).catch(() => {});
    } else {
      await metricsService.recordRunComplete(state.dbRunId, metrics, state.startTs).catch(() => {});
    }
  }

  if (state.metrics.saved > 0 && state.savedArticles.length > 0) {
    await alertService.checkNewArticles(state.savedArticles).catch(() => {});
    if (botEnabled()) {
      await botService.notifyAlerts(state.savedArticles).catch((err) => logger.warn(`⚠ [finish_run] bot alerts failed: ${err.message}`));
    }
  }

  logger.info(
    `🏁 [finish_run] processed=${metrics.processed} saved=${metrics.saved} errors=${metrics.errors} telegram=${metrics.telegramSent}`
  );
  return { metrics };
}
