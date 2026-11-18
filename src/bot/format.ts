export interface BriefArticle {
  title: string;
  content?: string | null;
  url: string;
  category?: string | null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const escapeAttr = (text: string) => escapeHtml(text).replace(/"/g, '&quot;');

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

/** A numbered list of articles in Telegram HTML; stays well under the 4096-char limit. */
export function formatArticleList(heading: string, articles: BriefArticle[], summaryChars = 220): string {
  const items = articles.map((a, i) => {
    const summary = a.content ? `\n${escapeHtml(truncate(a.content, summaryChars))}` : '';
    return `<b>${i + 1}. ${escapeHtml(truncate(a.title, 140))}</b>${summary}\n<a href="${escapeAttr(a.url)}">Read on ${escapeHtml(hostOf(a.url))}</a>`;
  });
  return [`<b>${escapeHtml(heading)}</b>`, ...items].join('\n\n');
}
