const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have how i in into is it its me
my of on or our so than that the their them then there these they this to up us was we were what when where which who
whom why will with would you your about after again all any also any been being both did does each few more most
other over same should some such than too very just latest news today yesterday week tell happened happening update updates`.split(/\s+/));

/** Search terms from a question: lowercase words of 3+ letters (or acronyms/numbers), stopwords removed. */
export function questionKeywords(question: string, max = 6): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out: string[] = [];
  for (const w of words) {
    if ((w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, max);
}
