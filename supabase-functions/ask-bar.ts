// Supabase Edge Function: ask-bar
// KI-Assistent für den Bar-Bestand. Claude fragt den Bestand über Werkzeuge ab (mit den Rechten des angemeldeten Benutzers).
// Änderungen führt die KI nie selbst aus: sie schlägt sie vor (propose_changes), die App fragt nach und ruft dann "execute" auf.
// Benötigt: Secret ANTHROPIC_API_KEY. Optional: Secret CHAT_MODEL (Standard claude-haiku-5-5).

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("CHAT_MODEL") ?? "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’`´]/g, "")
    .replace(/[^a-z0-9%.]+/g, " ").trim();

const STATUS_DE: Record<string, string> = { closed: "geschlossen", open: "offen", empty: "leer" };

/* ---------- Daten laden ---------- */

async function loadData(db: any) {
  const [b, r, l, c, w] = await Promise.all([
    db.from("bottles").select("*").limit(5000),
    db.from("rooms").select("id,name"),
    db.from("locations").select("id,name,room_id"),
    db.from("categories").select("id,name,parent_id"),
    db.from("wishlist").select("*"),
  ]);
  if (b.error) throw new Error(b.error.message);
  const room = new Map((r.data ?? []).map((x: any) => [x.id, x.name]));
  const loc = new Map((l.data ?? []).map((x: any) => [x.id, x.name]));
  const cat = new Map((c.data ?? []).map((x: any) => [x.id, x]));
  const rows = (b.data ?? []).map((x: any) => {
    const k: any = cat.get(x.category_id);
    const main: any = k?.parent_id ? cat.get(k.parent_id) : k;
    return {
      id: x.id, brand: x.brand, name: x.name, abv: x.abv === null ? null : Number(x.abv), size_ml: x.size_ml,
      status: x.status, quantity: x.quantity, fill_percent: x.fill_percent,
      category: k?.name ?? null, main_category: main?.name ?? null,
      room: room.get(x.room_id) ?? null, location: loc.get(x.location_id) ?? null,
      country: x.country, region: x.region, vintage: x.vintage, reorder: !!x.reorder, min_stock: x.min_stock,
      last_price: x.last_price === null || x.last_price === undefined ? null : Number(x.last_price), notes: x.notes,
    };
  });
  return { rows, wishlist: w.error ? [] : (w.data ?? []) };
}

const label = (r: any) => `${r.brand} ${r.name}${r.abv ? ` ${String(r.abv).replace(".", ",")} %` : ""}${r.size_ml ? ` ${r.size_ml} ml` : ""}`;
const brief = (r: any) => ({
  id: r.id, produkt: `${r.brand} ${r.name}`, abv: r.abv, ml: r.size_ml, status: STATUS_DE[r.status] ?? r.status,
  anzahl: r.quantity, fuellstand: r.status === "open" ? r.fill_percent : undefined,
  kategorie: [r.main_category, r.category].filter(Boolean).join(" / "), ort: [r.room, r.location].filter(Boolean).join(" / "),
  land: r.country, jahrgang: r.vintage, nachkaufen: r.reorder || undefined, notiz: r.notes || undefined,
});

/* ---------- Werkzeuge ---------- */

const TOOLS = [
  {
    name: "search_bottles",
    description: "Sucht Einträge im Bestand. query darf ungenau sein (Marke, Name, Stichwörter), die Suche ist tolerant. Filter sind optional. Leere Flaschen werden nur geliefert, wenn status 'empty' oder 'any' ist. Standard: alle nicht leeren.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Freitext, z. B. 'jack daniels single barrel'" },
        main_category: { type: "string", description: "Hauptkategorie, z. B. Whisky, Rum, Likör" },
        category: { type: "string", description: "Unterkategorie, z. B. Bourbon, Kräuter" },
        min_abv: { type: "number" }, max_abv: { type: "number" },
        status: { type: "string", enum: ["closed", "open", "empty", "any"], description: "Standard: nicht leer" },
        room: { type: "string" }, location: { type: "string" }, country: { type: "string" },
        only_reorder: { type: "boolean", description: "Nur zum Nachkaufen vorgemerkte" },
        limit: { type: "integer", description: "Maximal 30" },
      },
    },
  },
  { name: "stats", description: "Kennzahlen: Anzahl Flaschen gesamt, offen, geschlossen, je Hauptkategorie, Bestandswert aus den letzten Einkaufspreisen.", input_schema: { type: "object", properties: {} } },
  {
    name: "stale_bottles",
    description: "Nicht leere Flaschen, mit denen seit mindestens N Tagen nichts passiert ist (nicht geöffnet, nicht geändert).",
    input_schema: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] },
  },
  { name: "shopping_list", description: "Die Einkaufsliste: vorgemerkte Flaschen, Flaschen unter Mindestbestand und freie Einträge (neue Produkte).", input_schema: { type: "object", properties: {} } },
  {
    name: "show_bottles",
    description: "Zeigt dem Benutzer antippbare Karten zu diesen Einträgen (IDs aus search_bottles). Nutze es, wenn der Benutzer eine Liste will oder mehrere Treffer sinnvoll sind. Maximal 12.",
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "ask_choice",
    description: "Stellt dem Benutzer eine Rückfrage mit antippbaren Antworten, wenn mehrere Einträge passen könnten. Beendet deinen Zug.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, bottle_id: { type: "string" } }, required: ["label", "bottle_id"] } },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "propose_changes",
    description: "Schlägt Änderungen vor. Es wird NICHTS geändert, der Benutzer muss erst bestätigen. Beendet deinen Zug. Aktionen: mark_open (eine geschlossene Flasche öffnen, bottle_id), mark_empty (offene Flasche leer melden, bottle_id), set_fill (Füllstand offene Flasche, bottle_id, percent 0-100), set_quantity (Anzahl, bottle_id, quantity), set_reorder (Nachkaufen-Vormerkung, bottle_id, value true/false), add_wishlist (Produkt auf die Einkaufsliste, brand optional, name, quantity optional, notes optional), remove_wishlist (wishlist_id).",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["mark_open", "mark_empty", "set_fill", "set_quantity", "set_reorder", "add_wishlist", "remove_wishlist"] },
              bottle_id: { type: "string" }, wishlist_id: { type: "string" },
              percent: { type: "integer" }, quantity: { type: "integer" }, value: { type: "boolean" },
              brand: { type: "string" }, name: { type: "string" }, notes: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["changes"],
    },
  },
];

function searchBottles(rows: any[], a: any) {
  const tokens = norm(a.query).split(" ").filter((t) => t.length > 0);
  const st = a.status ?? "notempty";
  let list = rows.filter((r) => {
    if (st === "any") return true;
    if (st === "notempty") return r.status !== "empty";
    return r.status === st;
  });
  const has = (v: unknown, q: unknown) => norm(v).includes(norm(q));
  if (a.main_category) list = list.filter((r) => has(r.main_category, a.main_category));
  if (a.category) list = list.filter((r) => has(r.category, a.category) || has(r.main_category, a.category));
  if (a.room) list = list.filter((r) => has(r.room, a.room));
  if (a.location) list = list.filter((r) => has(r.location, a.location));
  if (a.country) list = list.filter((r) => has(r.country, a.country));
  if (typeof a.min_abv === "number") list = list.filter((r) => r.abv !== null && r.abv >= a.min_abv);
  if (typeof a.max_abv === "number") list = list.filter((r) => r.abv !== null && r.abv <= a.max_abv);
  if (a.only_reorder) list = list.filter((r) => r.reorder);
  let fuzzy = false;
  if (tokens.length > 0) {
    const scored = list.map((r) => {
      const hay = norm([r.brand, r.name, r.category, r.main_category, r.country, r.region, r.vintage, r.notes, r.abv ? r.abv + "%" : ""].join(" "));
      const n = tokens.filter((t) => hay.includes(t)).length;
      return { r, n };
    });
    let hit = scored.filter((x) => x.n === tokens.length);
    if (hit.length === 0 && tokens.length > 1) {
      hit = scored.filter((x) => x.n >= Math.ceil(tokens.length / 2));
      fuzzy = hit.length > 0;
    }
    list = hit.sort((x, y) => y.n - x.n).map((x) => x.r);
  }
  const order: Record<string, number> = { open: 0, closed: 1, empty: 2 };
  list = list.sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3));
  const limit = Math.min(30, a.limit ?? 20);
  return { treffer: list.length, ungenau_gesucht: fuzzy || undefined, eintraege: list.slice(0, limit).map(brief) };
}

async function runTool(db: any, data: any, name: string, a: any, ctx: any) {
  const { rows, wishlist } = data;
  switch (name) {
    case "search_bottles": return searchBottles(rows, a ?? {});
    case "stats": {
      const live = rows.filter((r: any) => r.status !== "empty");
      const byMain: Record<string, number> = {};
      let value = 0, priced = 0, unpriced = 0;
      for (const r of live) {
        byMain[r.main_category ?? "ohne Kategorie"] = (byMain[r.main_category ?? "ohne Kategorie"] ?? 0) + r.quantity;
        if (r.last_price !== null) { value += r.last_price * r.quantity; priced += r.quantity; } else unpriced += r.quantity;
      }
      return {
        flaschen_gesamt: live.reduce((s: number, r: any) => s + r.quantity, 0),
        geschlossen: live.filter((r: any) => r.status === "closed").reduce((s: number, r: any) => s + r.quantity, 0),
        offen: live.filter((r: any) => r.status === "open").reduce((s: number, r: any) => s + r.quantity, 0),
        je_hauptkategorie: byMain, bestandswert_eur: Math.round(value * 100) / 100,
        flaschen_mit_preis: priced, flaschen_ohne_preis: unpriced,
      };
    }
    case "stale_bottles": {
      const since = new Date(Date.now() - Math.max(1, a.days) * 86400000).toISOString();
      const { data: mv } = await db.from("movements").select("bottle_id").gte("moved_at", since).limit(20000);
      const recent = new Set((mv ?? []).map((m: any) => m.bottle_id));
      const stale = rows.filter((r: any) => r.status !== "empty" && !recent.has(r.id));
      return { treffer: stale.length, eintraege: stale.slice(0, 30).map(brief) };
    }
    case "shopping_list": {
      const low = rows.filter((r: any) => r.status === "closed" && r.min_stock !== null && r.quantity < r.min_stock);
      return {
        vorgemerkt: rows.filter((r: any) => r.reorder).map(brief),
        unter_mindestbestand: low.map((r: any) => ({ ...brief(r), mindestbestand: r.min_stock })),
        neue_produkte: wishlist.map((w: any) => ({ wishlist_id: w.id, produkt: `${w.brand ?? ""} ${w.name}`.trim(), menge: w.quantity ?? 1, notiz: w.notes ?? undefined })),
      };
    }
    case "show_bottles": {
      for (const id of (a.ids ?? []).slice(0, 12)) if (!ctx.shown.includes(id)) ctx.shown.push(id);
      return { ok: true };
    }
    default: return { error: "Unbekanntes Werkzeug" };
  }
}

/* ---------- Änderungen ausführen ---------- */

const UUID = /^[0-9a-f-]{36}$/i;

async function getBottle(db: any, id: string) {
  if (!UUID.test(String(id))) throw new Error("Ungültige Flaschen-ID");
  const { data, error } = await db.from("bottles").select("*").eq("id", id).single();
  if (error || !data) throw new Error("Flasche nicht gefunden");
  return data;
}
const ok = (r: any) => { if (r.error) throw new Error(r.error.message); return r; };

async function applyAction(db: any, a: any): Promise<{ text: string; undo: any[] }> {
  switch (a.action) {
    case "mark_empty": {
      const b = await getBottle(db, a.bottle_id);
      if (b.status !== "open") throw new Error(`${b.brand} ${b.name} ist nicht offen`);
      ok(await db.from("bottles").update({ status: "empty", fill_percent: 0 }).eq("id", b.id));
      await db.from("movements").insert({ bottle_id: b.id, type: "empty", quantity: -1, notes: "KI-Assistent" });
      return { text: `${b.brand} ${b.name}: als leer markiert`, undo: [{ type: "restore", bottle_id: b.id, fields: { status: b.status, fill_percent: b.fill_percent, quantity: b.quantity } }] };
    }
    case "mark_open": {
      const b = await getBottle(db, a.bottle_id);
      if (b.status !== "closed") throw new Error(`${b.brand} ${b.name} ist nicht geschlossen`);
      if (b.quantity > 1) {
        ok(await db.from("bottles").update({ quantity: b.quantity - 1 }).eq("id", b.id));
        const { id, created_at, updated_at, user_id, captured_at, image_front, image_back, image_side, image_thumb, ...copy } = b;
        const ins = ok(await db.from("bottles").insert({ ...copy, status: "open", quantity: 1, fill_percent: 100 }).select("id").single());
        await db.from("movements").insert({ bottle_id: b.id, type: "opened", quantity: -1, notes: "KI-Assistent" });
        return { text: `${b.brand} ${b.name}: eine Flasche geöffnet`, undo: [{ type: "delete_bottle", id: ins.data.id }, { type: "restore", bottle_id: b.id, fields: { quantity: b.quantity } }] };
      }
      ok(await db.from("bottles").update({ status: "open", fill_percent: 100 }).eq("id", b.id));
      await db.from("movements").insert({ bottle_id: b.id, type: "opened", quantity: -1, notes: "KI-Assistent" });
      return { text: `${b.brand} ${b.name}: geöffnet`, undo: [{ type: "restore", bottle_id: b.id, fields: { status: "closed", fill_percent: b.fill_percent, quantity: b.quantity } }] };
    }
    case "set_fill": {
      const b = await getBottle(db, a.bottle_id);
      if (b.status !== "open") throw new Error(`${b.brand} ${b.name} ist nicht offen`);
      const p = Math.max(0, Math.min(100, Math.round(Number(a.percent))));
      ok(await db.from("bottles").update({ fill_percent: p }).eq("id", b.id));
      return { text: `${b.brand} ${b.name}: Füllstand ${p} %`, undo: [{ type: "restore", bottle_id: b.id, fields: { fill_percent: b.fill_percent } }] };
    }
    case "set_quantity": {
      const b = await getBottle(db, a.bottle_id);
      const q = Math.max(0, Math.round(Number(a.quantity)));
      ok(await db.from("bottles").update({ quantity: q }).eq("id", b.id));
      if (q !== b.quantity) await db.from("movements").insert({ bottle_id: b.id, type: "adjustment", quantity: q - b.quantity, notes: "KI-Assistent" });
      return { text: `${b.brand} ${b.name}: Anzahl ${q}`, undo: [{ type: "restore", bottle_id: b.id, fields: { quantity: b.quantity } }] };
    }
    case "set_reorder": {
      const b = await getBottle(db, a.bottle_id);
      ok(await db.from("bottles").update({ reorder: !!a.value }).eq("id", b.id));
      return { text: `${b.brand} ${b.name}: ${a.value ? "auf die Einkaufsliste gesetzt" : "von der Einkaufsliste genommen"}`, undo: [{ type: "restore", bottle_id: b.id, fields: { reorder: !!b.reorder } }] };
    }
    case "add_wishlist": {
      const name = String(a.name ?? "").trim();
      if (!name) throw new Error("Produktname fehlt");
      const ins = ok(await db.from("wishlist").insert({
        brand: String(a.brand ?? "").trim(), name, quantity: Math.max(1, Math.round(Number(a.quantity ?? 1))), notes: a.notes ? String(a.notes) : null,
      }).select("id").single());
      return { text: `${`${a.brand ?? ""} ${name}`.trim()}: auf die Einkaufsliste gesetzt`, undo: [{ type: "delete_wishlist", id: ins.data.id }] };
    }
    case "remove_wishlist": {
      if (!UUID.test(String(a.wishlist_id))) throw new Error("Ungültige ID");
      const { data: w } = await db.from("wishlist").select("*").eq("id", a.wishlist_id).single();
      if (!w) throw new Error("Eintrag nicht gefunden");
      ok(await db.from("wishlist").delete().eq("id", w.id));
      return { text: `${`${w.brand ?? ""} ${w.name}`.trim()}: von der Einkaufsliste genommen`, undo: [{ type: "readd_wishlist", row: { brand: w.brand ?? "", name: w.name, quantity: w.quantity ?? 1, notes: w.notes } }] };
    }
    default: throw new Error("Unbekannte Aktion");
  }
}

async function applyUndo(db: any, step: any) {
  if (step.type === "restore") {
    const b = await getBottle(db, step.bottle_id);
    const f: any = {};
    for (const k of ["status", "fill_percent", "quantity", "reorder"]) if (k in (step.fields ?? {})) f[k] = step.fields[k];
    ok(await db.from("bottles").update(f).eq("id", b.id));
    if ("quantity" in f && f.quantity !== b.quantity) {
      await db.from("movements").insert({ bottle_id: b.id, type: "adjustment", quantity: f.quantity - b.quantity, notes: "KI-Assistent rückgängig" });
    }
  } else if (step.type === "delete_bottle") {
    if (UUID.test(String(step.id))) ok(await db.from("bottles").delete().eq("id", step.id));
  } else if (step.type === "delete_wishlist") {
    if (UUID.test(String(step.id))) ok(await db.from("wishlist").delete().eq("id", step.id));
  } else if (step.type === "readd_wishlist") {
    ok(await db.from("wishlist").insert({
      brand: String(step.row?.brand ?? ""), name: String(step.row?.name ?? ""), quantity: Number(step.row?.quantity ?? 1), notes: step.row?.notes ?? null,
    }));
  }
}

/* ---------- Beschreibung eines Vorschlags für die Rückfrage ---------- */

function describe(a: any, rows: any[], wishlist: any[]) {
  const byId = (id: string) => rows.find((r) => r.id === id);
  const r = a.bottle_id ? byId(a.bottle_id) : null;
  const who = r ? label(r) : "";
  switch (a.action) {
    case "mark_open": return `${who}: eine Flasche öffnen`;
    case "mark_empty": return `${who}: als leer markieren`;
    case "set_fill": return `${who}: Füllstand auf ${a.percent} %`;
    case "set_quantity": return `${who}: Anzahl auf ${a.quantity}`;
    case "set_reorder": return `${who}: ${a.value ? "auf die Einkaufsliste setzen" : "von der Einkaufsliste nehmen"}`;
    case "add_wishlist": return `${`${a.brand ?? ""} ${a.name ?? ""}`.trim()}${a.quantity > 1 ? ` (${a.quantity}×)` : ""}: neu auf die Einkaufsliste`;
    case "remove_wishlist": { const w = wishlist.find((x) => x.id === a.wishlist_id); return `${w ? `${w.brand ?? ""} ${w.name}`.trim() : "Eintrag"}: von der Einkaufsliste entfernen`; }
    default: return String(a.action);
  }
}

const systemPrompt = () => `Du bist der Bar-Assistent in der Bestands-App eines Barmanns (Hausbar mit über 1000 Flaschen, Spirituosen, Liköre, Bitters, Sirupe).
Heute ist ${new Date().toISOString().slice(0, 10)}.
Regeln:
- Antworte auf Deutsch, kurz und klar, in ein bis drei Sätzen. Die Antworten werden oft vorgelesen: keine Aufzählungszeichen, keine Markdown-Formatierung, keine Emojis, keine IDs im Text.
- Fakten über den Bestand holst du immer mit den Werkzeugen. Erfinde nie Flaschen, Mengen oder Preise.
- Der Benutzer spricht oft ungenau. Suche tolerant (zum Beispiel nur nach Marke und einem Stichwort). Mehrere Flaschen mit gleichem Namen können sich im Alkoholgehalt, in der Größe oder im Status unterscheiden.
- Passt genau ein Eintrag, nimm ihn. Passen mehrere plausibel und die Wahl ändert das Ergebnis oder eine Änderung, stelle eine Rückfrage mit ask_choice. Bei reinen Fragen ("wie viele?") fasse mehrere Treffer stattdessen kurz zusammen.
- "ist leer" betrifft eine offene Flasche. Gibt es mehrere offene, frage nach. Gibt es keine offene, sage das und biete an, was stattdessen sinnvoll ist.
- Änderungen führst du nie selbst aus. Rufe propose_changes auf und erkläre in einem kurzen Satz, was du vorschlägst. Du behauptest nie, etwas sei schon geändert.
- Für "setz X auf die Einkaufsliste": Suche X auch unter leeren Flaschen (status any). Gibt es eine passende Flasche, nutze set_reorder. Gibt es keine, nutze add_wishlist mit Marke und Name.
- Bei Listen nutze show_bottles, damit der Benutzer die Einträge antippen kann, und nenne im Text nur die Anzahl und das Wichtigste.
- Cocktailfragen beantwortest du aus deinem Allgemeinwissen und prüfst die Zutaten mit search_bottles gegen den Bestand. Weise kurz darauf hin, dass Rezepte aus deinem Wissen stammen.
- Außerhalb von Bar, Bestand und Getränken hilfst du nicht.`;

/* ---------- Hauptprogramm ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: u, error: ae } = await db.auth.getUser();
  if (ae || !u?.user) return json({ error: "Nicht angemeldet" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }

  // Bestätigte Änderungen ausführen
  if (body?.execute) {
    const actions = (Array.isArray(body.execute.actions) ? body.execute.actions : []).slice(0, 25);
    const done: string[] = [], errors: string[] = [], undo: any[] = [];
    for (const a of actions) {
      try { const r = await applyAction(db, a); done.push(r.text); undo.unshift(...r.undo); }
      catch (e) { errors.push((e as Error).message); }
    }
    return json({ done, errors, undo });
  }
  if (body?.undo) {
    const steps = (Array.isArray(body.undo.steps) ? body.undo.steps : []).slice(0, 50);
    const errors: string[] = [];
    for (const s of steps) { try { await applyUndo(db, s); } catch (e) { errors.push((e as Error).message); } }
    return json({ ok: errors.length === 0, errors });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Das Secret ANTHROPIC_API_KEY fehlt in Supabase." }, 500);

  const history = (Array.isArray(body?.messages) ? body.messages : []).slice(-20)
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (history.length === 0 || history[history.length - 1].role !== "user") return json({ error: "Keine Frage übergeben" }, 400);

  let data: any;
  try { data = await loadData(db); } catch (e) { return json({ error: "Bestand konnte nicht geladen werden: " + (e as Error).message }, 500); }

  const messages: any[] = history;
  const ctx = { shown: [] as string[] };

  for (let round = 0; round < 8; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(), tools: TOOLS, messages }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return json({ error: `Claude-API: ${payload?.error?.message ?? "HTTP " + res.status}` }, 502);

    const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    const calls = blocks.filter((b) => b.type === "tool_use");

    const choice = calls.find((c) => c.name === "ask_choice");
    const propose = calls.find((c) => c.name === "propose_changes");
    if (choice || propose) {
      // übrige Werkzeuge (z. B. show_bottles) noch auswerten
      for (const c of calls) if (c !== choice && c !== propose) await runTool(db, data, c.name, c.input, ctx);
      const shown = ctx.shown.map((id) => data.rows.find((r: any) => r.id === id)).filter(Boolean).map(brief);
      if (choice) {
        const opts = (choice.input?.options ?? []).filter((o: any) => data.rows.some((r: any) => r.id === o.bottle_id)).slice(0, 6);
        return json({ reply: choice.input?.question || text, choices: opts, shown });
      }
      const changes = (propose!.input?.changes ?? []).slice(0, 25);
      const items = changes.map((a: any) => ({ ...a, label: describe(a, data.rows, data.wishlist) }));
      return json({ reply: text || "Soll ich das so ändern?", proposal: { items }, shown });
    }

    if (payload.stop_reason !== "tool_use" || calls.length === 0) {
      const shown = ctx.shown.map((id) => data.rows.find((r: any) => r.id === id)).filter(Boolean).map(brief);
      return json({ reply: text || "Dazu habe ich keine Antwort.", shown });
    }

    messages.push({ role: "assistant", content: blocks });
    const results: any[] = [];
    for (const c of calls) {
      let out: unknown;
      try { out = await runTool(db, data, c.name, c.input, ctx); } catch (e) { out = { error: (e as Error).message }; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 14000) });
    }
    messages.push({ role: "user", content: results });
  }
  return json({ reply: "Das war mir zu verwickelt. Kannst du die Frage anders stellen?" });
});
