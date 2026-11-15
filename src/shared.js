import { supabase } from './supabase'
import { resizeImage, blobToBase64, productKey } from './utils'

// Gemeinsame Hilfsfunktionen für Formular, Scanner und Foto-Schnellerfassung

export const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

/* ---------- Barcode lesen ---------- */

export const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']

export async function createDetector(preferWasm) {
  if (!preferWasm && 'BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats()
      const formats = FORMATS.filter(f => sup.includes(f))
      if (formats.length > 0) return { detector: new window.BarcodeDetector({ formats }), wasm: false }
    } catch { /* weiter mit Ersatz */ }
  }
  const { BarcodeDetector } = await import('barcode-detector/ponyfill')
  return { detector: new BarcodeDetector({ formats: FORMATS }), wasm: true }
}

// Barcode aus einem Foto lesen: mehrere Versuche mit Größen, Drehungen und Kontrast
export async function decodeFromFile(file) {
  let bmp
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { bmp = await createImageBitmap(file) }
  const make = (maxSide, rot, enhance) => {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const c = document.createElement('canvas')
    const swap = rot === 90 || rot === 270
    c.width = swap ? h : w
    c.height = swap ? w : h
    const ctx = c.getContext('2d')
    if (enhance) ctx.filter = 'grayscale(1) contrast(1.6)'
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h)
    return c
  }
  const attempts = [[2400, 0, false], [1400, 0, false], [1400, 0, true], [2400, 90, false], [2400, 270, false], [1000, 0, true]]
  for (const wasm of [false, true]) {
    let detector
    try { detector = (await createDetector(wasm)).detector } catch { continue }
    for (const [side, rot, enh] of attempts) {
      try {
        const found = await detector.detect(make(side, rot, enh))
        if (found.length > 0 && found[0].rawValue) { bmp.close && bmp.close(); return found[0].rawValue }
      } catch { /* nächster Versuch */ }
    }
  }
  bmp.close && bmp.close()
  return null
}


/* ---------- KI-Auswertung eines Etiketts ---------- */

export async function runAnalyze(files, cats, lookups) {
  const mains = cats.filter(c => !c.parent_id)
  const images = []
  for (const file of files) {
    const blob = await resizeImage(file, 1200, 0.8)
    images.push({ media_type: 'image/jpeg', data: await blobToBase64(blob) })
  }
  const taxonomy = {
    categories: Object.fromEntries(mains.map(c => [c.name, cats.filter(x => x.parent_id === c.id).map(x => x.name)])),
    countries: lookups.filter(l => l.kind === 'country').map(l => l.name),
    regions: [...new Set(lookups.filter(l => l.kind === 'region').map(l => l.name))],
  }
  const { data, error: fnError } = await supabase.functions.invoke('analyze-label', { body: { images, taxonomy } })
  if (fnError) {
    let detail = fnError.message
    try { const j = await fnError.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error)
  if (!data?.result) throw new Error('Keine Antwort erhalten')
  return data.result
}

/* ---------- Auswahllisten ---------- */

export async function ensureLookup(lookups, kind, name, country) {
  const existing = lookups.find(l => l.kind === kind && l.name.toLowerCase() === name.toLowerCase() &&
    (kind === 'country' || !l.country || l.country === country))
  if (existing) return existing.name
  const { error } = await supabase.from('lookup_values').insert({ kind, name, country: kind === 'region' ? (country || null) : null })
  if (error) throw error
  return name
}


export function aiToPrefill(r, cats, lookups) {
  const mains = cats.filter(c => !c.parent_id)
  const data = {}
  const filled = []
  if (r.brand) { data.brand = r.brand; filled.push('Marke') }
  if (r.name) { data.name = r.name; filled.push('Name') }
  const m = r.main_category ? mains.find(c => sameText(c.name, r.main_category)) : null
  if (m) {
    const sub = r.sub_category ? cats.find(c => c.parent_id === m.id && sameText(c.name, r.sub_category)) : null
    data.category_id = sub ? sub.id : m.id
    filled.push(sub ? 'Kategorie und Subkategorie' : 'Kategorie')
  }
  if (r.abv !== null && r.abv !== undefined) { data.abv = r.abv; filled.push('Alkoholgehalt') }
  if (r.size_ml) { data.size_ml = r.size_ml; filled.push('Größe') }
  if (r.vintage) { data.vintage = r.vintage; filled.push('Jahrgang') }
  let country = ''
  if (r.country) {
    const known = lookups.find(l => l.kind === 'country' && sameText(l.name, r.country))
    if (known) { data.country = known.name; country = known.name }
    else { data.country = '__new'; data.newCountry = r.country; country = r.country }
    filled.push('Herkunftsland')
  }
  if (r.region) {
    const known = lookups.find(l => l.kind === 'region' && sameText(l.name, r.region) && (!l.country || !country || l.country === country))
    if (known) data.region = known.name
    else { data.region = '__new'; data.newRegion = r.region }
    filled.push('Region / Stil')
  }
  if (r.notes) data.noteText = r.notes
  return { data, filled }
}

export async function ensureRoom(rooms, name) {
  const existing = rooms.find(r => r.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing.id
  const { data, error } = await supabase.from('rooms').insert({ name }).select('id').single()
  if (error) throw error
  return data.id
}

export async function ensureLocation(locations, roomId, name) {
  const existing = locations.find(l => l.room_id === roomId && l.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing.id
  const { data, error } = await supabase.from('locations').insert({ room_id: roomId, name }).select('id').single()
  if (error) throw error
  return data.id
}


// Kommt eine geschlossene Flasche eines Produkts dazu: "Nachkaufen"-Vormerkung aller Einträge dieses Produkts entfernen
export async function clearReorderFor(bottles, ref) {
  const key = productKey(ref)
  const ids = bottles.filter(x => x.reorder && productKey(x) === key).map(x => x.id)
  if (ids.length === 0) return
  await supabase.from('bottles').update({ reorder: false }).in('id', ids)
}
