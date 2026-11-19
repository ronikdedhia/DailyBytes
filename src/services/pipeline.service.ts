import { runNewsPipeline } from '../agents/pipeline/graph';
import { PipelineMetrics } from '../agents/pipeline/state';

export type { PipelineMetrics as PipelineResult };

class PipelineService {
  async executeNewsDataPipeline(opts?: { fresh?: boolean }): Promise<PipelineMetrics> {
    return runNewsPipeline('newsdata', opts);
  }

  async executeRssPipeline(): Promise<PipelineMetrics> {
    return runNewsPipeline('rss');
  }
  async executeMarketsPipeline(): Promise<PipelineMetrics> {
    return runNewsPipeline('markets');
  }
}

export const pipelineService = new PipelineService();
