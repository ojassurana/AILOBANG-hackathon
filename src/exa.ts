/**
 * Exa web search, wired into the call harness as a built-in capability rather
 * than a connector.
 *
 * It answers questions about the world outside the caller's accounts — news,
 * current events, anything that changed recently — so the assistant is not
 * limited to what its own model happens to remember.
 */

const SEARCH_API = "https://api.exa.ai/search";
const MAX_RESULTS = 8;
const TEXT_CHARS = 700;

export interface WebResult {
  title: string;
  url: string;
  text: string;
}

interface ExaResponse {
  results?: { title?: string | null; url?: string; text?: string | null }[];
}

export async function webSearch(
  apiKey: string,
  query: string,
  numResults: number,
): Promise<WebResult[]> {
  const response = await fetch(SEARCH_API, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: Math.min(Math.max(1, numResults || 5), MAX_RESULTS),
      contents: { text: { maxCharacters: TEXT_CHARS } },
    }),
  });

  if (!response.ok) {
    throw new Error(`exa ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const payload = (await response.json()) as ExaResponse;
  return (payload.results ?? [])
    .filter((result) => result.url)
    .map((result) => ({
      title: result.title ?? result.url ?? "",
      url: result.url as string,
      text: (result.text ?? "").trim(),
    }));
}
