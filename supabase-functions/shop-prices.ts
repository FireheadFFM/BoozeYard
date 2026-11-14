// Supabase Edge Function: shop-prices
// Sucht mit Claude (Websuche) aktuelle Preise für ein Produkt in den Shops und gibt sie als Liste zurück.
// Benötigt: Secret ANTHROPIC_API_KEY. Die Websuche muss in der Anthropic Console für die Organisation aktiviert sein.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function extractJson(text: string): any | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt" }, 405);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: u, error: ae } = await supabase.auth.getUser();
  if (ae || !u?.user) return json({ error: "Nicht angemeldet" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Das Secret ANTHROPIC_API_KEY fehlt in Supabase." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }
  const product = String(body?.product ?? "").slice(0, 200);
  const shops: { name: string; domain: string }[] = (Array.isArray(body?.shops) ? body.shops : []).slice(0, 12)
    .filter((s: any) => s?.name && s?.domain);
  if (!product || shops.length === 0) return json({ error: "Produkt oder Shops fehlen" }, 400);

  const system = `Du recherchierst aktuelle Verkaufspreise für Spirituosen in Online-Shops.
Suche gezielt nach dem Produkt in den genannten Shops. Nimm nur Preise, die du auf einer Produktseite wirklich gesehen hast, und nur für die passende Flaschengröße.
Erfinde nie Preise. Wenn ein Shop das Produkt nicht führt oder du keinen Preis findest, lass den Shop weg.
Antworte am Ende ausschließlich mit JSON in dieser Form, ohne weiteren Text:
{"offers":[{"shop":"Shopname","price_eur":29.9,"url":"https://...","note":"kurz, z. B. nicht lieferbar, Aktionspreis, 0,5 l statt 0,7 l"}]}`;

  const user = `Produkt: ${product}${body?.abv ? `, ${body.abv} % vol.` : ""}
Shops (Domain): ${shops.map((s) => `${s.name} (${s.domain})`).join(", ")}
Suche den aktuellen Preis pro Flasche in möglichst vielen dieser Shops, Amazon, Conalco, Delicando und Drankdozijn zuerst.`;

  const messages: any[] = [{ role: "user", content: user }];
  let text = "";
  for (let round = 0; round < 4; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        system,
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 8,
          allowed_domains: shops.map((s) => s.domain),
        }],
        messages,
      }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return json({ error: `Claude-API: ${payload?.error?.message ?? "HTTP " + res.status}` }, 502);
    const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
    text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (payload?.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    break;
  }

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.offers)) {
    return json({ offers: [], note: "Keine Preise gefunden. " + text.slice(0, 160).replace(/\s+/g, " ") });
  }
  const offers = parsed.offers
    .map((o: any) => ({
      shop: String(o.shop ?? "").slice(0, 60),
      price_eur: typeof o.price_eur === "number" ? o.price_eur : parseFloat(String(o.price_eur ?? "").replace(",", ".")),
      url: typeof o.url === "string" && o.url.startsWith("http") ? o.url : null,
      note: o.note ? String(o.note).slice(0, 120) : null,
    }))
    .filter((o: any) => o.shop && isFinite(o.price_eur))
    .sort((a: any, b: any) => a.price_eur - b.price_eur);
  return json({ offers });
});
