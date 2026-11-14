// Supabase Edge Function: sync-youtube
// Holt alle Videos des YouTube-Kanals (Titel + Beschreibung) und lässt die KI die Rezepte (Zutaten) auslesen.
// Zwei Aktionen: { action: "sync" } lädt die Videos, { action: "extract" } wertet einige offene Videos aus (App ruft es wiederholt auf).
// Benötigt: Secrets YOUTUBE_API_KEY und ANTHROPIC_API_KEY. Optional: YOUTUBE_HANDLE (Standard @KultivierteTresenwesen), EXTRACT_MODEL.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("EXTRACT_MODEL") ?? "claude-haiku-5-5";
const HANDLE = Deno.env.get("YOUTUBE_HANDLE") ?? "@KultivierteTresenwesen";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function yt(path: string, params: Record<string, string>, key: string) {
  const u = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`YouTube-API: ${j?.error?.message ?? "HTTP " + r.status}`);
  return j;
}

// "PT8M57S" -> Sekunden
function seconds(iso: string) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

async function pendingCount(db: any) {
  const { count } = await db.from("recipes").select("id", { count: "exact", head: true }).is("extracted_at", null);
  return count ?? 0;
}

/* ---------- Videos laden ---------- */

async function sync(db: any, userId: string, key: string) {
  const ch = await yt("channels", { part: "contentDetails", forHandle: HANDLE }, key);
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`Kanal ${HANDLE} nicht gefunden`);

  const ids: string[] = [];
  let token = "";
  for (let page = 0; page < 60; page++) {
    const p = await yt("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "50", pageToken: token }, key);
    for (const it of p.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    token = p.nextPageToken ?? "";
    if (!token) break;
  }

  const videos: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await yt("videos", { part: "snippet,contentDetails", id: ids.slice(i, i + 50).join(",") }, key);
    for (const it of v.items ?? []) videos.push(it);
  }

  const { data: existing, error: ee } = await db.from("recipes").select("video_id,description,title").limit(5000);
  if (ee) throw new Error("Tabelle recipes nicht lesbar (SQL 07 ausgeführt?): " + ee.message);
  const known = new Map((existing ?? []).map((x: any) => [x.video_id, x]));

  const rows: any[] = [];
  let neu = 0, geaendert = 0;
  for (const v of videos) {
    const desc = v.snippet?.description ?? "";
    const old: any = known.get(v.id);
    if (!old) neu++;
    else if (old.description === desc && old.title === v.snippet?.title) continue;
    else geaendert++;
    const row: any = {
      user_id: userId, video_id: v.id, title: v.snippet?.title ?? "", description: desc,
      published_at: v.snippet?.publishedAt ?? null, duration_s: seconds(v.contentDetails?.duration),
    };
    // nur bei neuem Text neu auswerten lassen
    if (!old || old.description !== desc) { row.extracted_at = null; row.is_recipe = null; }
    rows.push(row);
  }
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from("recipes").upsert(rows.slice(i, i + 100), { onConflict: "user_id,video_id" });
    if (error) throw new Error("Speichern fehlgeschlagen: " + error.message);
  }
  return { videos: videos.length, neu, geaendert, offen: await pendingCount(db) };
}

/* ---------- Rezepte auslesen ---------- */

function prep(desc: string) {
  let t = String(desc ?? "").normalize("NFKC");
  t = t.replace(/https?:\/\/\S+/g, "").replace(/[►◄]/g, "").replace(/[ \t]+/g, " ");
  const cut = t.search(/DISCLAIMER/i);
  if (cut > 300) t = t.slice(0, cut);
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
}

const TOOL = {
  name: "save_recipe",
  description: "Speichert das Ergebnis der Auswertung.",
  input_schema: {
    type: "object",
    properties: {
      is_recipe: { type: "boolean", description: "true, wenn die Beschreibung ein Cocktail-Rezept mit Zutatenliste enthält" },
      cocktail: { type: "string", description: "Name des Cocktails ohne Zusätze wie 'Cocktail' oder 'Rezept'" },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", description: "Allgemeine Bezeichnung der Zutat, z. B. 'Rye Whiskey', 'Islay Single Malt', 'Bénédictine', 'Grüner Chartreuse', 'Limettensaft'" },
            product: { type: ["string", "null"], description: "Konkretes Produkt/Marke, falls genannt, sonst null" },
            amount_text: { type: "string", description: "Menge wie im Text, z. B. '3 cl', '0,5', '2 Dashes'" },
            amount_cl: { type: ["number", "null"], description: "Menge in cl, wenn Einheit cl, ml oder oz bekannt (ml/10, oz*3), sonst null" },
            kind: { type: "string", enum: ["bottle", "fresh"], description: "bottle = Spirituose, Likör, Wermut, Bitter, Aperitif, Wein, Schaumwein. fresh = Säfte, Sirupe, Zucker, Eis, Soda, Früchte, Kräuter, Eiweiß" },
          },
          required: ["type", "amount_text", "kind"],
        },
      },
    },
    required: ["is_recipe"],
  },
};

const SYSTEM = `Du liest die Beschreibung eines Videos vom Cocktail-Kanal "Kultivierte Tresenwesen" (deutsch).
Entscheide, ob das Video ein Cocktail-Rezept mit Zutatenliste enthält. Das Rezept steht meist in einem Abschnitt wie "Rezept des ...", "Rezept & verwendete Zutaten" oder einer Liste mit Mengen (cl, ml, oz, Dashes).
Übernimm nur die Zutaten des Rezepts. Werkzeug, Gläser, Bücher, Shop-Links und Quellen sind keine Zutaten. Zutaten, die nur in einer Shop-Liste stehen und nicht im Rezept, sind auch keine Zutaten.
Halte dich an den Text und erfinde nichts. Fehlt die Einheit (zum Beispiel "0,5 Demerara Zuckersirup"), übernimm die Menge so, wie sie steht, und setze amount_cl auf null.
Ist es kein Rezept-Video (Verlosung, Barbesuch, Ankündigung), setze is_recipe auf false.`;

async function extractOne(apiKey: string, row: any) {
  const body = `Titel: ${row.title}\n\nBeschreibung:\n${prep(row.description)}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500, system: SYSTEM, tools: [TOOL],
      tool_choice: { type: "tool", name: "save_recipe" }, messages: [{ role: "user", content: body }],
    }),
  });
  const p = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Claude-API: ${p?.error?.message ?? "HTTP " + res.status}`);
  const tu = (p?.content ?? []).find((b: any) => b.type === "tool_use");
  if (!tu) throw new Error("Keine Auswertung erhalten");
  return tu.input;
}

async function extract(db: any, apiKey: string, limit: number) {
  const { data: todo, error } = await db.from("recipes").select("id,title,description")
    .is("extracted_at", null).order("published_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const errors: string[] = [];
  let done = 0;
  for (let i = 0; i < (todo ?? []).length; i += 4) {
    await Promise.all((todo ?? []).slice(i, i + 4).map(async (row: any) => {
      try {
        const r = await extractOne(apiKey, row);
        const isRecipe = !!r.is_recipe && Array.isArray(r.ingredients) && r.ingredients.length > 0;
        const ings = isRecipe ? r.ingredients.slice(0, 20).map((x: any) => ({
          type: String(x.type ?? "").slice(0, 80), product: x.product ? String(x.product).slice(0, 80) : null,
          amount_text: String(x.amount_text ?? "").slice(0, 30),
          amount_cl: typeof x.amount_cl === "number" ? x.amount_cl : null,
          kind: x.kind === "fresh" ? "fresh" : "bottle",
        })) : null;
        const { error: ue } = await db.from("recipes").update({
          is_recipe: isRecipe, cocktail: isRecipe ? String(r.cocktail ?? row.title).slice(0, 100) : null,
          ingredients: ings, extracted_at: new Date().toISOString(),
        }).eq("id", row.id);
        if (ue) throw new Error(ue.message);
        done++;
      } catch (e) { errors.push(`${row.title}: ${(e as Error).message}`); }
    }));
  }
  return { verarbeitet: done, offen: await pendingCount(db), fehler: errors.slice(0, 5) };
}

/* ---------- Hauptprogramm ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: u, error: ae } = await db.auth.getUser();
  if (ae || !u?.user) return json({ error: "Nicht angemeldet" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* leer */ }

  try {
    if (body?.action === "status") {
      const { count: total } = await db.from("recipes").select("id", { count: "exact", head: true });
      const { count: rec } = await db.from("recipes").select("id", { count: "exact", head: true }).eq("is_recipe", true);
      return json({ videos: total ?? 0, rezepte: rec ?? 0, offen: await pendingCount(db) });
    }
    if (body?.action === "sync") {
      const key = Deno.env.get("YOUTUBE_API_KEY");
      if (!key) return json({ error: "Das Secret YOUTUBE_API_KEY fehlt in Supabase." }, 500);
      return json(await sync(db, u.user.id, key));
    }
    if (body?.action === "extract") {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return json({ error: "Das Secret ANTHROPIC_API_KEY fehlt in Supabase." }, 500);
      return json(await extract(db, apiKey, Math.min(12, Math.max(1, Number(body.limit) || 8))));
    }
    return json({ error: "Unbekannte Aktion" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
