// Web research via Brave's Search API — a REST call with an API key, no OAuth, generous free tier.
// https://api-dashboard.search.brave.com (Data for AI plan has a free monthly quota).
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export async function webSearch({ query, count = 5 }, apiKey) {
  if (!apiKey) {
    return { error: "Web search isn't configured. Add a Brave Search API key in the keys panel." };
  }
  if (!query || !query.trim()) throw new Error("query is required");
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query.trim());
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 10)));
  const r = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Brave Search ${r.status}: ${body.slice(0, 300)}`);
  }
  const body = await r.json();
  const results = (body.web?.results || []).slice(0, count).map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.description?.replace(/<\/?strong>/g, "") || "",
  }));
  return { query, results };
}
