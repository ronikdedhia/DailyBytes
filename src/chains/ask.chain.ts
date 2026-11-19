import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { createLLM, RETRY_CONFIG } from '../config/llm.config';

const askChain = ChatPromptTemplate.fromMessages([
  ['system', `You answer questions about recent news using ONLY the numbered articles provided.
- Answer in 2-4 short sentences of plain text (no markdown).
- After each fact, cite its article like [1] or [2][3].
- If the articles don't answer the question, say so in one sentence and mention what they do cover. Never use outside knowledge.`],
  ['human', 'Question: {question}\n\nArticles:\n{articles}'],
])
  .pipe(createLLM('ask'))
  .pipe(new StringOutputParser())
  .withRetry(RETRY_CONFIG);

export interface AskSource {
  title: string;
  content?: string | null;
  publishedAt?: string | Date | null;
}

export async function answerFromArticles(question: string, sources: AskSource[]): Promise<string> {
  const articles = sources
    .map((a, i) => {
      const date = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : 'undated';
      return `[${i + 1}] (${date}) ${a.title}\n${(a.content || '').slice(0, 500)}`;
    })
    .join('\n\n');
  return (await askChain.invoke({ question: question.slice(0, 300), articles })).trim();
}
