import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import { STATUS, lsGet, lsSet } from './utils'
import { buildXlsx, readXlsx, parseCsv, csvFromRows } from './xlsx'

const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v.toLowerCase(), k]))

const HEADER = ['ID', 'Marke', 'Name', 'Hauptkategorie', 'Kategorie', 'ABV', 'Größe (ml)', 'Land', 'Region', 'Jahrgang',
  'Status', 'Anzahl', 'Füllstand %', 'Raum', 'Ort', 'Mindestbestand', 'Nachkaufen', 'Letzter Preis', 'Barcode',
  'Sammlung', 'Sample', 'Notizen']
const WIDTHS = [38, 20, 28, 16, 18, 7, 11, 14, 16, 10, 12, 8, 11, 16, 16, 14, 11, 12, 16, 10, 8, 30]

const yn = b => (b ? 'Ja' : 'Nein')
const norm = s => String(s ?? '').trim().toLowerCase()

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function buildRows({ bottles, cats, rooms, locations }) {
  const catById = Object.fromEntries(cats.map(c => [c.id, c]))
  const roomById = Object.fromEntries(rooms.map(r => [r.id, r]))
  const locById = Object.fromEntries(locations.map(l => [l.id, l]))
  const rows = [HEADER]
  for (const b of bottles) {
    const c = catById[b.category_id]
    const main = c?.parent_id ? catById[c.parent_id] : c
    rows.push([
      b.id, b.brand, b.name, main?.name ?? '', c?.name ?? '', b.abv === null ? null : Number(b.abv), b.size_ml,
      b.country ?? '', b.region ?? '', b.vintage ?? '', STATUS[b.status] ?? b.status, b.quantity, b.fill_percent,
      roomById[b.room_id]?.name ?? '', locById[b.location_id]?.name ?? '', b.min_stock, yn(b.reorder),
      b.last_price === null || b.last_price === undefined ? null : Number(b.last_price), b.barcode ?? '',
      yn(b.is_collection), yn(b.is_sample), b.notes ?? '',
    ])
  }
  return rows
}

/* ---------- Import: Zellen in Datenbankwerte umwandeln ---------- */

const toText = v => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())
const toNum = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'))
  return isFinite(n) ? n : NaN
}
const toInt = v => { const n = toNum(v); return n === null || Number.isNaN(n) ? n : Math.round(n) }
const toBool = v => {
  const s = norm(v)
  if (['ja', 'j', 'yes', 'true', '1', 'x'].includes(s)) return true
  if (['nein', 'n', 'no', 'false', '0', ''].includes(s)) return false
  return undefined
}

export function planImport(table, { bottles, cats, rooms, locations }) {
  const head = (table[0] || []).map(h => String(h ?? '').trim())
  const col = Object.fromEntries(head.map((h, i) => [h, i]))
  if (col['ID'] === undefined) throw new Error('Die Spalte "ID" fehlt. Bitte die exportierte Datei verwenden.')
  const byId = Object.fromEntries(bottles.map(b => [b.id, b]))
  const catById = Object.fromEntries(cats.map(c => [c.id, c]))
  const roomById = Object.fromEntries(rooms.map(r => [r.id, r]))
  const locById = Object.fromEntries(locations.map(l => [l.id, l]))
  const plans = []
  let ignored = 0

  for (let r = 1; r < table.length; r++) {
    const row = table[r] || []
    const get = label => (col[label] === undefined ? undefined : row[col[label]])
    const id = toText(get('ID'))
    const bottle = id ? byId[id] : null
    if (!bottle) { if (row.some(x => x !== null && x !== undefined && x !== '')) ignored++; continue }

    const update = {}
    const changes = []
    const problems = []
    const cur = { ...bottle }
    const setIf = (key, label, value, shown, oldShown) => {
      const same = (value ?? null) === (cur[key] ?? null) || (typeof value === 'number' && Number(cur[key]) === value)
      if (!same) { update[key] = value; changes.push({ label, from: oldShown ?? cur[key] ?? '–', to: shown ?? value ?? '–' }) }
    }

    for (const [label, key, conv, required] of [
      ['Marke', 'brand', toText, true], ['Name', 'name', toText, true], ['Land', 'country', toText],
      ['Region', 'region', toText], ['Jahrgang', 'vintage', toText], ['Barcode', 'barcode', toText], ['Notizen', 'notes', toText],
    ]) {
      const raw = get(label)
      if (raw === undefined) continue
      const v = conv(raw)
      if (required && v === null) { problems.push(`${label} darf nicht leer sein`); continue }
      setIf(key, label, v)
    }
    for (const [label, key, conv, min, max] of [
      ['ABV', 'abv', toNum, 0, 100], ['Größe (ml)', 'size_ml', toInt, 1, 100000], ['Anzahl', 'quantity', toInt, 0, 100000],
      ['Füllstand %', 'fill_percent', toInt, 0, 100], ['Mindestbestand', 'min_stock', toInt, 0, 100000],
      ['Letzter Preis', 'last_price', toNum, 0, 1000000],
    ]) {
      const raw = get(label)
      if (raw === undefined) continue
      const v = conv(raw)
      if (Number.isNaN(v) || (v !== null && (v < min || v > max))) { problems.push(`${label}: "${raw}" ist ungültig`); continue }
      if ((key === 'size_ml' || key === 'quantity' || key === 'fill_percent') && v === null) { problems.push(`${label} darf nicht leer sein`); continue }
      setIf(key, label, v)
    }
    for (const [label, key] of [['Nachkaufen', 'reorder'], ['Sammlung', 'is_collection'], ['Sample', 'is_sample']]) {
      const raw = get(label)
      if (raw === undefined) continue
      const v = toBool(raw)
      if (v === undefined) { problems.push(`${label}: "${raw}" bitte Ja oder Nein`); continue }
      setIf(key, label, v, yn(v), yn(!!cur[key]))
    }
    const st = get('Status')
    if (st !== undefined) {
      const key = STATUS_BY_LABEL[norm(st)]
      if (!key) problems.push(`Status: "${st}" unbekannt`)
      else if (key !== cur.status) {
        update.status = key
        changes.push({ label: 'Status', from: STATUS[cur.status], to: STATUS[key] })
        if (key === 'closed') update.fill_percent = 100
        if (key === 'empty') update.fill_percent = 0
      }
    }
    const catName = get('Kategorie')
    if (catName !== undefined && toText(catName)) {
      const matches = cats.filter(c => norm(c.name) === norm(catName))
      if (matches.length !== 1) problems.push(`Kategorie: "${catName}" ${matches.length ? 'ist mehrdeutig' : 'unbekannt'}`)
      else if (matches[0].id !== bottle.category_id) {
        update.category_id = matches[0].id
        changes.push({ label: 'Kategorie', from: catById[bottle.category_id]?.name ?? '–', to: matches[0].name })
      }
    }
    const roomName = get('Raum')
    const locName = get('Ort')
    if (roomName !== undefined || locName !== undefined) {
      let roomId = bottle.room_id
      if (roomName !== undefined && toText(roomName)) {
        const rm = rooms.find(x => norm(x.name) === norm(roomName))
        if (!rm) problems.push(`Raum: "${roomName}" unbekannt`)
        else roomId = rm.id
      }
      let locId = bottle.location_id
      if (locName !== undefined) {
        const t = toText(locName)
        if (!t) locId = null
        else {
          const lc = locations.find(x => x.room_id === roomId && norm(x.name) === norm(t))
          if (!lc) problems.push(`Ort: "${t}" gibt es im Raum nicht`)
          else locId = lc.id
        }
      } else if (roomId !== bottle.room_id) locId = null
      if (problems.length === 0 || !problems.some(p => p.startsWith('Raum') || p.startsWith('Ort'))) {
        if (roomId !== bottle.room_id) { update.room_id = roomId; changes.push({ label: 'Raum', from: roomById[bottle.room_id]?.name ?? '–', to: roomById[roomId]?.name ?? '–' }) }
        if (locId !== bottle.location_id) { update.location_id = locId; changes.push({ label: 'Ort', from: locById[bottle.location_id]?.name ?? '–', to: locById[locId]?.name ?? '–' }) }
      }
    }
    if (changes.length > 0 || problems.length > 0) plans.push({ bottle, update, changes, problems })
  }
  return { plans, ignored, total: table.length - 1 }
}

async function callYt(body) {
  const { data, error } = await supabase.functions.invoke('sync-youtube', { body })
  if (error) {
    let detail = error.message
    try { const j = await error.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

function YoutubeRezepte() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { callYt({ action: 'status' }).then(setSt).catch(e => setErr(e.message)) }, [])

  async function run() {
    setBusy(true); setErr(''); setLog('Lädt Videos von YouTube…')
    let lastErr = ''
    try {
      const s = await callYt({ action: 'sync' })
      let open = s.offen
      setLog(`${s.videos} Videos gefunden (${s.neu} neu, ${s.geaendert} geändert).${open > 0 ? ' Liest Rezepte aus…' : ''}`)
      let guard = 0
      while (open > 0 && guard < 100) {
        const r = await callYt({ action: 'extract', limit: 8 })
        if (r.fehler?.length) lastErr = r.fehler[0]
        if (r.verarbeitet === 0) { setErr('Auswertung bricht ab: ' + (lastErr || 'unbekannter Fehler')); break }
        open = r.offen
        setLog(`Liest Rezepte aus… noch ${open} offen`)
        guard++
      }
      if (open === 0) setLog('Fertig.' + (lastErr ? ' Einzelne Videos ließen sich nicht auswerten: ' + lastErr : ''))
      setSt(await callYt({ action: 'status' }))
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <>
      <h3 style={{ marginTop: 28 }}>YouTube-Rezepte für den Assistenten</h3>
      <p className="hint">Lädt alle Videos deines Kanals und liest die Zutaten aus den Beschreibungen. Danach kann der Assistent fragen wie „Was kann ich aus meinen Videos mixen?“ beantworten. Nach neuen Videos einfach erneut aktualisieren, bereits gelesene Videos werden nicht noch einmal ausgewertet.</p>
      {st && <div className="count">{st.videos} Videos · {st.rezepte} Rezepte erkannt{st.offen > 0 ? ` · ${st.offen} noch nicht ausgewertet` : ''}</div>}
      <button className="scan-btn secondary" onClick={run} disabled={busy}>{busy ? 'Läuft…' : (st && st.videos > 0 ? 'Rezepte aktualisieren' : 'Rezepte laden')}</button>
      {log && <div className="msg">{log}</div>}
      {err && <div className="msg error">{err}</div>}
    </>
  )
}

export default function Export({ bottles, cats, rooms, locations, reload }) {
  const data = { bottles, cats, rooms, locations }
  const baseUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-data`
  const [token, setToken] = useState(lsGet('export_token') || '')
  const [copied, setCopied] = useState('')
  const [plan, setPlan] = useState(null)
  const [picked, setPicked] = useState({})
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const stamp = new Date().toISOString().slice(0, 10)
  const url = `${baseUrl}?token=${token || 'DEIN_TOKEN'}`
  const mCode = `let\n    Quelle = Csv.Document(Web.Contents("${url}"), [Delimiter=";", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n    Kopf = Table.PromoteHeaders(Quelle, [PromoteAllScalars=true])\nin\n    Kopf`

  function saveToken(v) { setToken(v.trim()); lsSet('export_token', v.trim()) }

  async function copy(text, key) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1800) } catch { setError('Kopieren nicht möglich – bitte von Hand markieren.') }
  }

  function exportXlsx() {
    download(buildXlsx(buildRows(data), { widths: WIDTHS }), `BoozeYard-Bestand-${stamp}.xlsx`)
  }
  function exportCsv() {
    download(new Blob([csvFromRows(buildRows(data))], { type: 'text/csv;charset=utf-8' }), `BoozeYard-Bestand-${stamp}.csv`)
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(''); setMsg(''); setPlan(null)
    try {
      const table = /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : await readXlsx(await file.arrayBuffer())
      const p = planImport(table, data)
      setPlan(p)
      setPicked(Object.fromEntries(p.plans.map((x, i) => [i, x.problems.length === 0])))
    } catch (err) {
      setError('Datei konnte nicht gelesen werden: ' + err.message)
    }
  }

  async function apply() {
    setBusy(true); setError(''); setMsg('')
    let ok = 0, fail = 0
    for (let i = 0; i < plan.plans.length; i++) {
      if (!picked[i]) continue
      const { bottle, update } = plan.plans[i]
      if (Object.keys(update).length === 0) continue
      const { error: e1 } = await supabase.from('bottles').update(update).eq('id', bottle.id)
      if (e1) { fail++; continue }
      if (update.quantity !== undefined && update.quantity !== bottle.quantity) {
        await supabase.from('movements').insert({ bottle_id: bottle.id, type: 'adjustment', quantity: update.quantity - bottle.quantity, notes: 'Excel-Import' })
      }
      ok++
    }
    await reload()
    setPlan(null)
    setBusy(false)
    setMsg(`${ok} Flaschen aktualisiert${fail ? `, ${fail} Fehler` : ''}.`)
  }

  const nPicked = useMemo(() => Object.values(picked).filter(Boolean).length, [picked])

  return (
    <div className="panel">
      <h3>Excel-Export</h3>
      <p className="hint">Alle {bottles.length} Einträge als Tabelle. Zum Bearbeiten am PC: Spalte „ID“ nicht ändern, Zeilen nicht löschen oder hinzufügen.</p>
      <div className="row-btns">
        <button className="scan-btn" onClick={exportXlsx}>Excel-Datei laden (.xlsx)</button>
        <button className="scan-btn secondary" onClick={exportCsv}>CSV laden</button>
      </div>

      <h3 style={{ marginTop: 28 }}>Änderungen aus Excel einlesen</h3>
      <p className="hint">Datei laden, die Änderungen werden erst als Vorschau gezeigt. Gelesen werden die Spalten des Exports (Marke, Name, Kategorie, ABV, Größe, Land, Region, Jahrgang, Status, Anzahl, Füllstand, Raum, Ort, Mindestbestand, Nachkaufen, Preis, Barcode, Sammlung, Sample, Notizen). Neue Zeilen ohne ID werden ignoriert, neue Flaschen legst du in der App an.</p>
      <label className="file-btn">Excel- oder CSV-Datei wählen
        <input type="file" accept=".xlsx,.csv,text/csv" hidden onChange={onFile} />
      </label>
      {error && <div className="msg error">{error}</div>}
      {msg && <div className="msg">{msg}</div>}

      {plan && (
        <div className="import-plan">
          <div className="count">
            {plan.plans.length === 0 ? 'Keine Änderungen gefunden.' : `${plan.plans.length} Flaschen mit Änderungen`}
            {plan.ignored > 0 && ` · ${plan.ignored} Zeilen ohne passende ID ignoriert`}
          </div>
          {plan.plans.map((p, i) => (
            <div key={p.bottle.id} className={'plan-card' + (p.problems.length ? ' bad' : '')}>
              <label className="check">
                <input type="checkbox" checked={!!picked[i]} disabled={p.problems.length > 0}
                  onChange={e => setPicked(s => ({ ...s, [i]: e.target.checked }))} />
                <strong>{p.bottle.brand} {p.bottle.name}</strong>
              </label>
              {p.changes.map(c => (
                <div key={c.label} className="chg"><span>{c.label}</span> {String(c.from)} → <b>{String(c.to)}</b></div>
              ))}
              {p.problems.map(t => <div key={t} className="chg err">{t}</div>)}
            </div>
          ))}
          {plan.plans.length > 0 && (
            <button className="save-btn" onClick={apply} disabled={busy || nPicked === 0}>
              {busy ? 'Schreibt…' : `${nPicked} Änderungen übernehmen`}
            </button>
          )}
          <button className="ghost-btn" onClick={() => setPlan(null)} disabled={busy}>Verwerfen</button>
        </div>
      )}

      <h3 style={{ marginTop: 28 }}>Live-Verbindung für Excel</h3>
      <p className="hint">Excel kann den Bestand bei jedem Öffnen frisch laden. Einmalig einrichten: in Supabase die Funktion export-data anlegen und das Secret EXPORT_TOKEN setzen (ein langer Zufallstext, mindestens 16 Zeichen). Denselben Text hier eintragen, er bleibt nur auf diesem Gerät gespeichert.</p>
      <input placeholder="EXPORT_TOKEN" value={token} onChange={e => saveToken(e.target.value)} />
      <div className="url-box">{url}</div>
      <div className="row-btns">
        <button className="scan-btn secondary" onClick={() => copy(url, 'url')}>{copied === 'url' ? 'Kopiert' : 'Link kopieren'}</button>
        <button className="scan-btn secondary" onClick={() => copy(mCode, 'm')}>{copied === 'm' ? 'Kopiert' : 'Power-Query-Code kopieren'}</button>
      </div>
      <p className="hint">In Excel: Daten → Daten abrufen → Aus anderen Quellen → Leere Abfrage → Erweiterter Editor → Code einfügen → Fertig → Schließen und laden. Danach unter Daten → Alle aktualisieren (oder beim Öffnen automatisch, in den Abfrageeigenschaften „Daten beim Öffnen der Datei aktualisieren“). Die Live-Daten sind schreibgeschützt, zum Ändern nutze die Excel-Datei oben.</p>

      <YoutubeRezepte />
    </div>
  )
}
