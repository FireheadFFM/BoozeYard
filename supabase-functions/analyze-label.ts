// Supabase Edge Function: analyze-label
// Wertet 1–3 Flaschenfotos mit Claude Haiku 5.5 aus (festes Antwortformat über Tool-Use) und gibt die Produktdaten zurück.
// Der Schlüssel liegt als Secret ANTHROPIC_API_KEY in Supabase und nie in der App.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-haiku-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SYSTEM = `Du hilfst beim Erfassen von Flaschen für ein Bar-Inventar.
Du bekommst 1 bis 3 Fotos einer Flasche (Vorderetikett, Rückenetikett, Seite) und eine Liste erlaubter Kategorien, Länder und Regionen.
Lies nur ab, was auf den Etiketten steht oder eindeutig daraus folgt. Rate nichts. Wenn eine Angabe nicht erkennbar ist, setze null.
Gib das Ergebnis ausschließlich über das Werkzeug save_bottle ab. Lass Felder weg, die nicht erkennbar sind.`;

function buildInstruction(taxonomy: any): string {
  return `Werte die Fotos aus und rufe das Werkzeug save_bottle auf.

Erlaubte Kategorien (Hauptkategorie: Subkategorien):
${JSON.stringify(taxonomy?.categories ?? {})}

Bekannte Länder: ${JSON.stringify(taxonomy?.countries ?? [])}
Bekannte Regionen/Stile: ${JSON.stringify(taxonomy?.regions ?? [])}

Hinweise: main_category und sub_category müssen exakt einem Eintrag der Liste entsprechen. Das Herkunftsland ist das Land der Destillerie bzw. Produktion, nicht der Importeur. Bei Blends aus mehreren Ländern lass country weg. Alkoholgehalt und Füllmenge stehen oft auf dem Rückenetikett.`;
}

const TOOL = {
  name: "save_bottle",
  description: "Speichert die aus den Etiketten gelesenen Produktdaten. Nicht erkennbare Felder weglassen.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Marke bzw. Hersteller, so wie auf dem Etikett geschrieben" },
      name: { type: "string", description: "Produktname ohne die Marke, inklusive Altersangabe oder Abfüllung (z. B. 'Aged 5 Years')" },
      main_category: { type: "string", description: "Genau ein Eintrag aus den Hauptkategorien" },
      sub_category: { type: "string", description: "Genau ein Eintrag aus den Subkategorien dieser Hauptkategorie" },
      abv: { type: "number", description: "Alkoholgehalt in Prozent (z. B. 40 oder 46.3)" },
      size_ml: { type: "integer", description: "Flaschengröße in Millilitern (z. B. 700)" },
      country: { type: "string", description: "Herkunftsland, wenn möglich exakt aus der Länderliste" },
      region: { type: "string", description: "Region oder Stil, wenn möglich exakt aus der Regionenliste" },
      vintage: { type: "string", description: "Jahrgang oder Destillationsjahr" },
      notes: { type: "string", description: "Höchstens ein kurzer Satz mit Auffälligem" },
    },
    required: [],
  },
};

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() && !["null", "unbekannt", "n/a"].includes(v.trim().toLowerCase()) ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt" }, 405);

  // Nur angemeldete Benutzer dürfen die Funktion aufrufen (sonst könnte jeder mit dem öffentlichen Schlüssel Guthaben verbrauchen)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData?.user) return json({ error: "Nicht angemeldet" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Das Secret ANTHROPIC_API_KEY fehlt in Supabase." }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ungültige Anfrage" }, 400);
  }

  const images = (Array.isArray(body?.images) ? body.images : []).slice(0, 3);
  if (images.length === 0) return json({ error: "Kein Bild übergeben" }, 400);
  for (const img of images) {
    if (typeof img?.data !== "string" || img.data.length > 4_000_000) {
      return json({ error: "Ein Bild ist ungültig oder zu groß" }, 400);
    }
  }

  const content: unknown[] = images.map((img: any) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: img.data },
  }));
  content.push({ type: "text", text: buildInstruction(body?.taxonomy) });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "save_bottle" },
      messages: [{ role: "user", content }],
    }),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.error?.message ?? `HTTP ${res.status}`;
    return json({ error: `Claude-API: ${detail}` }, 502);
  }

  const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
  const toolBlock = blocks.find((b) => b.type === "tool_use" && b.name === "save_bottle");
  let parsed: Record<string, unknown> | null =
    toolBlock && typeof toolBlock.input === "object" && toolBlock.input ? toolBlock.input : null;
  if (!parsed) {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    parsed = extractJson(text);
    if (!parsed) {
      const snippet = (text || JSON.stringify(blocks)).slice(0, 200).replace(/\s+/g, " ");
      return json({
        error: `Die Antwort konnte nicht gelesen werden (stop_reason: ${payload?.stop_reason ?? "?"}). Anfang der Antwort: ${snippet}`,
      }, 502);
    }
  }

  const size = num(parsed.size_ml);
  return json({
    result: {
      brand: str(parsed.brand),
      name: str(parsed.name),
      main_category: str(parsed.main_category),
      sub_category: str(parsed.sub_category),
      abv: num(parsed.abv),
      size_ml: size !== null ? Math.round(size) : null,
      country: str(parsed.country),
      region: str(parsed.region),
      vintage: str(parsed.vintage),
      notes: str(parsed.notes),
    },
  });
});
