// Supabase Edge Function: export-data
// Liefert den Bestand als CSV (Semikolon, UTF-8) für Excel "Daten > Aus dem Web".
// Geschützt durch ein langes Zufalls-Token (Secret EXPORT_TOKEN), Aufruf: .../export-data?token=DEIN_TOKEN
// Wichtig: In den Funktions-Einstellungen "Verify JWT" ausschalten (Excel sendet keine Anmeldung).

import { createClient } from "npm:@supabase/supabase-js@2";

const STATUS: Record<string, string> = { closed: "Geschlossen", open: "Offen", empty: "Leer" };

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\r?\n/g, " ");
  return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const yn = (b: unknown) => (b ? "Ja" : "Nein");
const num = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(".", ","));

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const expected = Deno.env.get("EXPORT_TOKEN") ?? "";
  if (!expected || expected.length < 16 || token !== expected) {
    return new Response("Nicht erlaubt", { status: 401 });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Supabase liefert pro Abfrage höchstens 1000 Zeilen: seitenweise holen
  const fetchAll = async (make: () => any) => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const res = await make().range(from, from + 999);
      if (res.error) return { data: null, error: res.error };
      out.push(...res.data);
      if (res.data.length < 1000) break;
    }
    return { data: out, error: null };
  };
  const [b, r, l, c] = await Promise.all([
    fetchAll(() => db.from("bottles").select("*").order("brand").order("name").order("id")),
    db.from("rooms").select("id,name"),
    fetchAll(() => db.from("locations").select("id,name").order("id")),
    db.from("categories").select("id,name,parent_id"),
  ]);
  if (b.error) return new Response("Fehler: " + b.error.message, { status: 500 });

  const room = new Map((r.data ?? []).map((x: any) => [x.id, x.name]));
  const loc = new Map((l.data ?? []).map((x: any) => [x.id, x.name]));
  const cat = new Map((c.data ?? []).map((x: any) => [x.id, x]));

  const header = ["ID", "Marke", "Name", "Hauptkategorie", "Kategorie", "ABV", "Größe (ml)", "Land", "Region", "Jahrgang",
    "Status", "Anzahl", "Füllstand %", "Raum", "Ort", "Mindestbestand", "Nachkaufen", "Letzter Preis", "Barcode",
    "Sammlung", "Sample", "Notizen"];
  const lines = [header.join(";")];
  for (const x of b.data ?? []) {
    const k: any = cat.get(x.category_id);
    const main: any = k?.parent_id ? cat.get(k.parent_id) : k;
    lines.push([
      x.id, x.brand, x.name, main?.name, k?.name, num(x.abv), x.size_ml, x.country, x.region, x.vintage,
      STATUS[x.status] ?? x.status, x.quantity, x.fill_percent, room.get(x.room_id), loc.get(x.location_id),
      x.min_stock, yn(x.reorder), num(x.last_price), x.barcode, yn(x.is_collection), yn(x.is_sample), x.notes,
    ].map(cell).join(";"));
  }
  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
  });
});
