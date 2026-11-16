/** BM25 ranks stay separate from cosine scores; fusion combines rank positions. */
export function lexicalRanks(
  query: string,
  documents: { id: string; text: string }[],
) {
  const tokens = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const terms = [...new Set(tokens(query))].slice(0, 100);
  const wanted = new Set(terms);
  const parsed = documents.map((document) => {
    const counts = new Map<string, number>();
    let length = 0;
    for (const match of document.text
      .toLocaleLowerCase()
      .matchAll(/[\p{L}\p{N}_]+/gu)) {
      length++;
      if (wanted.has(match[0]))
        counts.set(match[0], (counts.get(match[0]) || 0) + 1);
    }
    return { id: document.id, length, counts };
  });
  const average =
    parsed.reduce((sum, document) => sum + document.length, 0) /
      (parsed.length || 1) || 1;
  const frequencies = new Map(
    terms.map((term) => [
      term,
      parsed.filter((document) => document.counts.has(term)).length,
    ]),
  );
  return parsed
    .map((document) => {
      const score = terms.reduce((sum, term) => {
        const frequency = document.counts.get(term) || 0;
        const idf = Math.log(
          1 +
            (parsed.length - frequencies.get(term)! + 0.5) /
              (frequencies.get(term)! + 0.5),
        );
        return (
          sum +
          (idf * frequency * 2.2) /
            (frequency + 1.2 * (0.25 + (0.75 * document.length) / average))
        );
      }, 0);
      return { id: document.id, score };
    })
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function fuseRanks(rankings: { id: string; score: number }[][]) {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((item, index) =>
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (60 + index + 1)),
    );
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function normalized(vector: number[]) {
  if (
    !vector.length ||
    vector.length > 4096 ||
    vector.some((value) => !Number.isFinite(value))
  )
    throw new Error('Embeddings must contain 1–4096 finite dimensions');
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new Error('Embedding has no usable magnitude');
  return vector.map((value) => value / magnitude);
}

export async function retrievalJson(
  response: Response,
  maximum = 8 * 1024 * 1024,
): Promise<any> {
  if (!response.body) return response.json();
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximum)
        throw new Error('Retrieval response exceeds its byte budget');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
