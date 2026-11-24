import qrcode from './qrcode-lib'

// QR-Codes für Räume und Orte: Link in die App, Erzeugung komplett im Browser (qrcode-lib.js, MIT-Lizenz)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Basis-Adresse der App, z. B. https://fireheadffm.github.io/BoozeYard/
export function appBase() {
  return new URL(import.meta.env.BASE_URL || '/', window.location.origin).href
}

export function placeLink(kind, id) {
  return `${appBase()}?${kind === 'room' ? 'raum' : 'ort'}=${id}`
}

// Erkennt einen Orts-/Raum-Link (aus QR-Code oder Adresszeile). Ergebnis: { kind: 'room'|'location', id } oder null
export function parsePlaceCode(text) {
  if (!text) return null
  let u
  try { u = new URL(String(text).trim(), window.location.origin) } catch { return null }
  const ort = u.searchParams.get('ort')
  const raum = u.searchParams.get('raum')
  if (ort && UUID.test(ort)) return { kind: 'location', id: ort.toLowerCase() }
  if (raum && UUID.test(raum)) return { kind: 'room', id: raum.toLowerCase() }
  return null
}

// QR als SVG-Pfad (ein Pfad für alle dunklen Felder, ohne Rand)
export function qrPath(text) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (q.isDark(r, c)) {
        let e = c
        while (e < n && q.isDark(r, e)) e++
        d += `M${c} ${r}h${e - c}v1h-${e - c}z`
        c = e
      } else c++
    }
  }
  return { n, d }
}

// Lesbare Ortsnummer: "Nr. 17", "nr 17", "#17" oder nur "17" (1–5 Ziffern, also nie ein Barcode) -> 17, sonst null
export function parseLocCode(text) {
  const m = String(text ?? '').trim().match(/^(?:#|nr\.?\s*)?(\d{1,5})$/i)
  return m ? parseInt(m[1], 10) : null
}
export const fmtLocCode = c => (c === null || c === undefined ? '' : `Nr. ${c}`)
