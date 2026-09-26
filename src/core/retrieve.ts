import type { Snippet } from "./notes";

export type Retrieved = { snippet: Snippet; score: number };

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do for from has have i if in is it its just me my no not of on or " +
    "our so that the their them then there they this to up us was we were what when which who will with " +
    "you your yes ok okay um uh like get got going gonna about into also been would could should than"
  ).split(" "),
);

// BM25 constants: standard defaults, not tuned.
const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2;

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

function termCounts(snippet: Snippet): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (token: string, weight: number): void => {
    counts.set(token, (counts.get(token) ?? 0) + weight);
  };
  for (const token of tokenize(snippet.title)) add(token, TITLE_WEIGHT);
  for (const token of tokenize(snippet.text)) add(token, 1);
  return counts;
}

/** Keyword (BM25) retrieval over note snippets. Returns only snippets with a positive score, best first. */
export function retrieve(query: string, snippets: Snippet[], limit = 5): Retrieved[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || snippets.length === 0) return [];

  const docs = snippets.map((snippet) => {
    const counts = termCounts(snippet);
    let length = 0;
    for (const count of counts.values()) length += count;
    return { snippet, counts, length };
  });
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;

  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = docs.filter((doc) => doc.counts.has(term)).length;
    idf.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
  }

  return docs
    .map(({ snippet, counts, length }) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = counts.get(term) ?? 0;
        if (tf === 0) continue;
        score += ((idf.get(term) ?? 0) * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avgLength));
      }
      return { snippet, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Recent transcript lines form the retrieval query; the latest line matters most, so it is repeated. */
export function transcriptQuery(transcript: string[], window = 3): string {
  const recent = transcript.slice(-window);
  const latest = recent[recent.length - 1] ?? "";
  return [...recent, latest].join(" ");
}
