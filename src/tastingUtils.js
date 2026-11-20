// Hilfsfunktionen für Tasting, Journal und GIF

export const pad2 = n => String(n).padStart(2, '0')

// Heutiges Datum (lokal) als JJJJ-MM-TT
export function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// JJJJ-MM-TT -> TT.MM.JJJJ
export function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

export const starsText = n => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '')

// Durchschnitt der vergebenen Sterne (null, wenn noch keine Bewertung mit Sternen)
export function avgStars(ratings) {
  const v = ratings.filter(r => r.stars).map(r => r.stars)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

export const fmtAvg = n => (n === null || n === undefined ? '' : n.toFixed(1).replace('.', ','))

export const titleOf = t => `${t.brand || ''} ${t.name || ''}`.trim()

// Zweite Zeile: 46 % · Schottland · Speyside
export function metaOf(t) {
  const abv = t.abv !== null && t.abv !== undefined && t.abv !== '' ? `${String(t.abv).replace('.', ',')} %` : ''
  return [abv, t.country, t.region].filter(Boolean).join(' · ')
}

// Bewertungen eines Whiskys: meine zuerst, dann nach Anlage
export function sortRatings(list) {
  return [...list].sort((a, b) => (b.is_me ? 1 : 0) - (a.is_me ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at)))
}

export const hasSpecial = ratings => ratings.some(r => r.special)

// Journal: nach Veranstaltung gruppiert (älteste Veranstaltung zuerst), Whiskys in Probier-Reihenfolge oder nach Sternen
export function buildJournal({ events, tastings, ratings, eventIds, minStars = 0, onlySpecial = false, byStars = false }) {
  const rBy = {}
  for (const r of ratings) (rBy[r.tasting_id] ||= []).push(r)
  const evs = events.filter(e => !eventIds || eventIds.includes(e.id))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || String(a.created_at).localeCompare(String(b.created_at)))
  const out = []
  for (const e of evs) {
    let rows = tastings.filter(t => t.event_id === e.id)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(t => { const rs = sortRatings(rBy[t.id] || []); return { t, ratings: rs, avg: avgStars(rs) } })
    if (minStars) rows = rows.filter(r => r.avg !== null && r.avg >= minStars)
    if (onlySpecial) rows = rows.filter(r => hasSpecial(r.ratings))
    if (byStars) rows = [...rows].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
    if (rows.length) out.push({ event: e, rows })
  }
  return out
}
