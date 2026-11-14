// Supabase Edge Function: analyze-invoice
// Liest Rechnungen/Lieferscheine (Fotos oder PDF) mit Claude und gibt die Positionen strukturiert zurück.
// Der Schlüssel liegt als Secret ANTHROPIC_API_KEY in Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `Du liest Rechnungen und Lieferscheine eines Getränkehändlers für ein Bar-Inventar.
Erfasse nur Waren, die in den Barbestand gehören: Spirituosen, Liköre, Wein, Bitters, Sirupe, Essenzen und ähnliche Zutaten.
Überspringe Pfand, Versand, Rabatte, Gutscheine, Zahlungsgebühren, Gläser und sonstiges Zubehör.
Lies Zahlen exakt vom Beleg ab. Rate keine Preise, Mengen oder EANs. Fehlt eine Angabe auf dem Beleg, lass das Feld weg.
Menge ist die Anzahl Flaschen (bzw. Einheiten). Steht eine Position als Karton mit mehreren Flaschen, rechne auf Flaschen um und gib den Preis pro Flasche an.
Der Einzelpreis ist der Preis pro Flasche so, wie er auf dem Beleg steht (netto oder brutto, je nach Beleg).
Vierstellige Zahlen am Ende einer Bezeichnung, die kein plausibles Jahr zwischen 1900 und 2030 sind (zum Beispiel 3305, 0805, 0721, 0203), sind interne Artikelcodes des Händlers und gehören nicht in den Namen. Jahreszahlen übernimmst du nur, wenn sie ein Jahrgang oder Alter sein können.
Marke und Name trennst du sauber (Marke = Hersteller/Marke, Name = Produktname inkl. Alter/Abfüllung ohne Größe und Alkoholgehalt).
Fehlen Alkoholgehalt, Land, Region oder Kategorie auf dem Beleg, darfst du sie aus deinem Fachwissen ergänzen, aber nur wenn du dir bei dem Produkt sicher bist. Trage dann die Namen dieser Felder in "enriched" ein.
Gib alles ausschließlich über das Werkzeug save_invoice ab.`;

const TOOL = {
  name: "save_invoice",
  description: "Speichert Kopfdaten und Positionen des Belegs.",
  input_schema: {
    type: "object",
    properties: {
      supplier: { type: "string", description: "Name des Lieferanten/Shops" },
      invoice_no: { type: "string", description: "Rechnungs- oder Lieferscheinnummer" },
      date: { type: "string", description: "Belegdatum als YYYY-MM-DD" },
      total: { type: "number", description: "Gesamtbetrag laut Beleg" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "Originaltext der Position" },
            brand: { type: "string" },
            name: { type: "string" },
            quantity: { type: "integer", description: "Anzahl Flaschen" },
            unit_price: { type: "number", description: "Preis pro Flasche" },
            size_ml: { type: "integer" },
            abv: { type: "number" },
            ean: { type: "string", description: "EAN/Barcode, falls auf dem Beleg" },
            sku: { type: "string", description: "Artikelnummer des Lieferanten" },
            main_category: { type: "string", description: "Genau ein Eintrag aus den Hauptkategorien" },
            sub_category: { type: "string", description: "Genau ein Eintrag aus den Subkategorien dieser Hauptkategorie" },
            country: { type: "string" },
            region: { type: "string" },
            vintage: { type: "string" },
            enriched: { type: "array", items: { type: "string" }, description: "Felder, die nicht vom Beleg stammen, sondern aus Fachwissen ergänzt wurden" },
          },
          required: ["description", "quantity"],
        },
      },
    },
    required: ["items"],
  },
};

const str = (v: unknown) => (typeof v === "string" && v.trim() && !["null", "unbekannt", "n/a"].includes(v.trim().toLowerCase()) ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
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

  const files = (Array.isArray(body?.files) ? body.files : []).slice(0, 5);
  if (files.length === 0) return json({ error: "Keine Datei übergeben" }, 400);

  const content: unknown[] = [];
  for (const f of files) {
    if (typeof f?.data !== "string" || f.data.length > 9_000_000) return json({ error: "Eine Datei ist ungültig oder zu groß" }, 400);
    if (f.media_type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
    }
  }
  const tax = body?.taxonomy ?? {};
  content.push({
    type: "text",
    text: `Lies den Beleg und rufe save_invoice auf.\nErlaubte Kategorien (Hauptkategorie: Subkategorien): ${JSON.stringify(tax.categories ?? {})}\nBekannte Länder: ${JSON.stringify(tax.countries ?? [])}\nBekannte Regionen: ${JSON.stringify(tax.regions ?? [])}\nmain_category und sub_category müssen exakt einem Eintrag der Liste entsprechen. Sirup, Bitters und Essenzen haben eigene Kategorien.`,
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "save_invoice" },
      messages: [{ role: "user", content }],
    }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) return json({ error: `Claude-API: ${payload?.error?.message ?? "HTTP " + res.status}` }, 502);

  const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
  const tool = blocks.find((b) => b.type === "tool_use" && b.name === "save_invoice");
  if (!tool?.input) {
    return json({ error: `Die Antwort konnte nicht gelesen werden (stop_reason: ${payload?.stop_reason ?? "?"}).` }, 502);
  }
  const p: any = tool.input;
  const items = (Array.isArray(p.items) ? p.items : []).map((i: any) => ({
    description: str(i.description) ?? "",
    brand: str(i.brand),
    name: str(i.name),
    quantity: Math.max(1, Math.round(num(i.quantity) ?? 1)),
    unit_price: num(i.unit_price),
    size_ml: num(i.size_ml) !== null ? Math.round(num(i.size_ml)!) : null,
    abv: num(i.abv),
    ean: str(i.ean),
    sku: str(i.sku),
    main_category: str(i.main_category),
    sub_category: str(i.sub_category),
    country: str(i.country),
    region: str(i.region),
    vintage: str(i.vintage),
    enriched: Array.isArray(i.enriched) ? i.enriched.filter((x: unknown) => typeof x === "string") : [],
  }));
  return json({
    result: {
      supplier: str(p.supplier),
      invoice_no: str(p.invoice_no),
      date: str(p.date),
      total: num(p.total),
      items,
      truncated: payload?.stop_reason === "max_tokens",
    },
  });
});
