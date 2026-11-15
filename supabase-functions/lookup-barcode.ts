// Supabase Edge Function: lookup-barcode
// Sucht per Claude-Websuche ein Produkt zu einem Barcode (EAN/UPC), wenn Open Food Facts und Open Products Facts nichts kennen.
// Wird nur auf Knopfdruck aufgerufen (kostet ein paar Cent). Benötigt: Secret ANTHROPIC_API_KEY, Websuche in der Anthropic Console aktiv.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("LOOKUP_MODEL") ?? "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const str = (v: unknown) => (typeof v === "string" && v.trim() && !["null", "unbekannt", "n/a"].includes(v.trim().toLowerCase()) ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
};

const REPORT = {
  name: "report_product",
  description: "Meldet das Ergebnis der Barcode-Suche. found=false, wenn kein eindeutiges Produkt zu genau diesem Code gefunden wurde.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "true nur, wenn eine Seite diesen Code eindeutig einem Produkt zuordnet" },
      brand: { type: "string", description: "Marke bzw. Hersteller" },
      name: { type: "string", description: "Produktname ohne die Marke, inklusive Altersangabe oder Abfüllung" },
      main_category: { type: "string", description: "Genau ein Eintrag aus den Hauptkategorien" },
      sub_category: { type: "string", description: "Genau ein Eintrag aus den Subkategorien dieser Hauptkategorie" },
      abv: { type: "number", description: "Alkoholgehalt in Prozent" },
      size_ml: { type: "integer", description: "Flaschengröße in Millilitern" },
      country: { type: "string", description: "Herkunftsland, wenn möglich exakt aus der Länderliste" },
      region: { type: "string", description: "Region oder Stil, wenn möglich exakt aus der Regionenliste" },
      vintage: { type: "string", description: "Jahrgang oder Destillationsjahr" },
      source_url: { type: "string", description: "Link zur Seite, auf der der Code dem Produkt zugeordnet ist" },
    },
    required: ["found"],
  },
};

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
  const ean = String(body?.ean ?? "").replace(/\D/g, "");
  if (![8, 12, 13].includes(ean.length)) return json({ error: "Der Barcode muss 8, 12 oder 13 Ziffern haben." }, 400);
  const tax = body?.taxonomy ?? {};

  const system = `Du recherchierst, welches Produkt (Spirituose, Likör, Bitter, Sirup o. Ä.) zu einem Barcode gehört.
Suche im Web nach dem Code. Melde ein Produkt nur, wenn eine Seite genau diesen Code eindeutig diesem Produkt zuordnet. Rate nichts, erfinde nichts.
Gibt es keine eindeutige Zuordnung oder widersprechen sich die Treffer, melde found=false.
Gib das Ergebnis ausschließlich über das Werkzeug report_product ab. Felder, die du nicht sicher weißt, lässt du weg.`;

  const user = `Barcode: ${ean}${ean.length === 12 ? ` (auch als EAN-13 mit führender 0: 0${ean})` : ""}${ean.length === 13 && ean[0] === "0" ? ` (auch als UPC-A: ${ean.slice(1)})` : ""}

Erlaubte Kategorien (Hauptkategorie: Subkategorien):
${JSON.stringify(tax.categories ?? {})}
Bekannte Länder: ${JSON.stringify(tax.countries ?? [])}
Bekannte Regionen/Stile: ${JSON.stringify(tax.regions ?? [])}

main_category und sub_category müssen exakt einem Eintrag der Liste entsprechen. Das Herkunftsland ist das Land der Produktion, nicht des Importeurs. Rufe danach report_product auf.`;

  const search = { type: "web_search_20250305", name: "web_search", max_uses: 4 };

  const call = async (messages: any[], force: boolean) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2500, system, tools: [search, REPORT],
        ...(force ? { tool_choice: { type: "tool", name: "report_product" } } : {}),
        messages,
      }),
    });
    const payload = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, payload };
  };

  const messages: any[] = [{ role: "user", content: user }];
  let report: any = null;
  let lastBlocks: any[] = [];
  for (let round = 0; round < 4 && !report; round++) {
    const r = await call(messages, false);
    if (!r.ok) return json({ error: `Claude-API: ${r.payload?.error?.message ?? "HTTP " + r.status}` }, 502);
    lastBlocks = Array.isArray(r.payload?.content) ? r.payload.content : [];
    report = lastBlocks.find((b) => b.type === "tool_use" && b.name === "report_product")?.input ?? null;
    if (report) break;
    if (r.payload?.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: lastBlocks }); continue; }
    break;
  }

  // Nur Text geliefert: Abgabe in einem zweiten Schritt erzwingen
  if (!report) {
    messages.push({ role: "assistant", content: lastBlocks.filter((b) => b.type !== "tool_use") });
    messages.push({ role: "user", content: "Gib jetzt das Ergebnis über report_product ab (found=false, wenn nichts Eindeutiges gefunden wurde)." });
    const r = await call(messages, true);
    if (!r.ok) return json({ error: `Claude-API: ${r.payload?.error?.message ?? "HTTP " + r.status}` }, 502);
    const blocks: any[] = Array.isArray(r.payload?.content) ? r.payload.content : [];
    report = blocks.find((b) => b.type === "tool_use" && b.name === "report_product")?.input ?? null;
  }

  if (!report || report.found !== true || !(str(report.brand) || str(report.name))) {
    return json({ result: { found: false } });
  }
  const size = num(report.size_ml);
  const url = typeof report.source_url === "string" && report.source_url.startsWith("http") ? report.source_url.slice(0, 300) : null;
  return json({
    result: {
      found: true,
      brand: str(report.brand),
      name: str(report.name),
      main_category: str(report.main_category),
      sub_category: str(report.sub_category),
      abv: num(report.abv),
      size_ml: size !== null ? Math.round(size) : null,
      country: str(report.country),
      region: str(report.region),
      vintage: str(report.vintage),
      notes: null,
      source_url: url,
    },
  });
});
