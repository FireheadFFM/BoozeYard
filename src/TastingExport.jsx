import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabase'
import { BUCKET } from './utils'
import { fmtDate, starsText, fmtAvg, titleOf, metaOf, buildJournal, todayIso } from './tastingUtils'
import { makeDocx } from './docx'
import { makeGif } from './gif'

// Journal (Word/PDF) und GIF aus den Tasting-Daten

async function fetchBlob(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error) throw error
  return data
}

// Aufgaben mit begrenzter Parallelität; Ergebnis in Eingabe-Reihenfolge (Fehler = null)
async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = await fn(items[i], i) } catch { out[i] = null }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob)
    const r = { w: bmp.width, h: bmp.height }
    if (bmp.close) bmp.close()
    return r
  } catch { return { w: 3, h: 4 } }
}

/* ---------- Druckansicht (PDF) ---------- */

function JournalPrint({ journal, urls }) {
  const total = journal.reduce((s, g) => s + g.rows.length, 0)
  const dates = journal.map(g => g.event.event_date).filter(Boolean).sort()
  const range = dates.length ? (dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : ''
  return createPortal(
    <div className="jr-print-root">
      <div className="jr-doc">
        <h1>Whisky-Journal</h1>
        <div className="jr-sub">{[range, `${total} ${total === 1 ? 'Whisky' : 'Whiskys'}`].filter(Boolean).join(' · ')}</div>
        {journal.map(g => (
          <section key={g.event.id}>
            <h2>{g.event.name} · {fmtDate(g.event.event_date)}</h2>
            <table className="jr-table">
              <thead><tr><th className="c-img" /><th className="c-name">Whisky</th><th className="c-rate">Bewertung</th><th>Beschreibung</th></tr></thead>
              <tbody>
                {g.rows.map(({ t, ratings, avg }) => (
                  <tr key={t.id}>
                    <td className="c-img">{urls[t.id] && <img src={urls[t.id]} alt="" />}</td>
                    <td className="c-name"><b>{titleOf(t) || 'Unbenannt'}</b><div>{metaOf(t)}</div></td>
                    <td className="c-rate">
                      {ratings.map(r => (
                        <div key={r.id}><b>{r.rater}:</b> <span className="st">{r.stars ? starsText(r.stars) : '–'}</span>{r.special && <b className="sp"> ✦ außergewöhnlich</b>}</div>
                      ))}
                      {ratings.filter(r => r.stars).length > 1 && <div className="avg">Ø {fmtAvg(avg)}</div>}
                    </td>
                    <td>{ratings.filter(r => String(r.note || '').trim()).map(r => (
                      <div key={r.id}>{ratings.length > 1 && <b>{r.rater}: </b>}{String(r.note).trim()}</div>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  )
}

/* ---------- Bereich "Journal & GIF" ---------- */

export default function TastingExport({ events, tastings, ratings, selectedEvent }) {
  const [open, setOpen] = useState(false)
  const [evSel, setEvSel] = useState({})        // Veranstaltung-ID -> true/false (Standard: alle bzw. die aktuelle)
  const [minStars, setMinStars] = useState(0)
  const [onlySpecial, setOnlySpecial] = useState(false)
  const [byStars, setByStars] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [print, setPrint] = useState(null)      // { journal, urls }
  // GIF
  const [gifOpen, setGifOpen] = useState(false)
  const [gifOff, setGifOff] = useState({})      // Whisky-ID -> abgewählt
  const [thumbUrls, setThumbUrls] = useState({})
  const [delay, setDelay] = useState(1200)
  const [size, setSize] = useState(640)
  const [captions, setCaptions] = useState(true)
  const [prog, setProg] = useState(null)
  const [gifOut, setGifOut] = useState(null)    // { url, bytes, count }

  const isOn = id => (id in evSel ? evSel[id] : (selectedEvent ? id === selectedEvent : true))
  const eventIds = events.filter(e => isOn(e.id)).map(e => e.id)

  const journal = useMemo(
    () => buildJournal({ events, tastings, ratings, eventIds, minStars, onlySpecial, byStars }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, tastings, ratings, evSel, selectedEvent, minStars, onlySpecial, byStars],
  )
  const count = journal.reduce((s, g) => s + g.rows.length, 0)
  const gifRows = useMemo(() => journal.flatMap(g => g.rows).filter(r => r.t.image_front), [journal])
  const gifChosen = gifRows.filter(r => !gifOff[r.t.id])

  // Vorschaubilder für die GIF-Auswahl
  useEffect(() => {
    if (!gifOpen) return
    const paths = gifRows.map(r => r.t.image_thumb).filter(p => p && !thumbUrls[p])
    if (paths.length === 0) return
    let dead = false
    supabase.storage.from(BUCKET).createSignedUrls(paths, 3600).then(({ data }) => {
      if (dead) return
      const add = {}
      ;(data || []).forEach(x => { if (x.signedUrl) add[x.path] = x.signedUrl })
      setThumbUrls(m => ({ ...m, ...add }))
    })
    return () => { dead = true }
  }, [gifOpen, gifRows])

  // Druckansicht schaltet die App beim Drucken aus
  useEffect(() => {
    if (!print) return
    document.body.classList.add('jr-printing')
    return () => document.body.classList.remove('jr-printing')
  }, [print])

  async function loadThumbBytes() {
    const list = journal.flatMap(g => g.rows.map(r => r.t)).filter(t => t.image_thumb)
    const blobs = await pool(list, 6, t => fetchBlob(t.image_thumb))
    const map = new Map()
    for (let i = 0; i < list.length; i++) {
      if (!blobs[i]) continue
      const { w, h } = await imageSize(blobs[i])
      map.set(list[i].id, { bytes: new Uint8Array(await blobs[i].arrayBuffer()), blob: blobs[i], w, h })
    }
    return map
  }

  async function wordJournal() {
    setBusy('word'); setErr('')
    try {
      const imgs = await loadThumbBytes()
      saveBlob(makeDocx(journal, imgs), `Whisky-Journal-${todayIso()}.docx`)
    } catch (e) { setErr('Das Journal konnte nicht erstellt werden: ' + e.message) }
    setBusy('')
  }

  async function pdfJournal() {
    setBusy('pdf'); setErr('')
    try {
      const imgs = await loadThumbBytes()
      const urls = {}
      imgs.forEach((v, id) => { urls[id] = URL.createObjectURL(v.blob) })
      setPrint({ journal, urls })
    } catch (e) { setErr('Das Journal konnte nicht vorbereitet werden: ' + e.message) }
    setBusy('')
  }

  function closePrint() {
    if (print) Object.values(print.urls).forEach(u => URL.revokeObjectURL(u))
    setPrint(null)
  }

  async function createGif() {
    setBusy('gif'); setErr(''); setGifOut(null)
    try {
      setProg({ step: 'Bilder laden', done: 0, total: gifChosen.length })
      let done = 0
      const blobs = await pool(gifChosen, 4, async r => { const b = await fetchBlob(r.t.image_front); setProg({ step: 'Bilder laden', done: ++done, total: gifChosen.length }); return b })
      const items = []
      gifChosen.forEach((r, i) => {
        if (!blobs[i]) return
        const a = r.avg
        items.push({ blob: blobs[i], title: titleOf(r.t) || 'Unbenannt', sub: a !== null ? `${starsText(Math.round(a))} ${fmtAvg(a)}` : '' })
      })
      if (items.length === 0) throw new Error('keine Bilder geladen')
      const blob = await makeGif(items, { size, delayMs: delay, captions, onProgress: (d, t) => setProg({ step: 'GIF erzeugen', done: d, total: t }) })
      setGifOut({ url: URL.createObjectURL(blob), blob, count: items.length, skipped: gifChosen.length - items.length })
    } catch (e) { setErr('Das GIF konnte nicht erstellt werden: ' + e.message) }
    setProg(null)
    setBusy('')
  }

  async function shareGif() {
    const file = new File([gifOut.blob], `Whisky-Tasting-${todayIso()}.gif`, { type: 'image/gif' })
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] })
      else saveBlob(gifOut.blob, file.name)
    } catch { /* abgebrochen */ }
  }

  const estMb = Math.max(1, Math.round(gifChosen.length * Math.pow(size / 640, 2) * 0.18))

  if (!open) {
    return (
      <div className="card column t-export-entry">
        <h3>Journal &amp; GIF</h3>
        <p>Alle probierten Whiskys als Liste mit Bewertungen (Word oder PDF) oder die Etiketten als GIF.</p>
        <button type="button" className="scan-btn secondary" style={{ marginTop: 0 }} onClick={() => setOpen(true)}>Öffnen</button>
      </div>
    )
  }

  return (
    <div className="card column t-export">
      <div className="room-head"><h3>Journal &amp; GIF</h3><button type="button" className="mini" onClick={() => setOpen(false)}>Schließen</button></div>
      {err && <div className="msg error">{err}</div>}

      <div className="fld"><span>Veranstaltungen</span></div>
      <div className="t-evlist">
        {events.map(e => (
          <label key={e.id} className="qr-row">
            <input type="checkbox" checked={isOn(e.id)} onChange={() => setEvSel(s => ({ ...Object.fromEntries(events.map(x => [x.id, isOn(x.id)])), ...s, [e.id]: !isOn(e.id) }))} />
            <span>{e.name} · {fmtDate(e.event_date)} <em>{tastings.filter(t => t.event_id === e.id).length}</em></span>
          </label>
        ))}
      </div>
      <div className="filter-row">
        <select value={minStars} aria-label="Mindeststerne" onChange={e => setMinStars(Number(e.target.value))}>
          <option value={0}>Alle Sterne</option>
          {[2, 3, 4, 5].map(n => <option key={n} value={n}>ab {n} Sternen</option>)}
        </select>
        <select value={byStars ? 'stars' : 'order'} aria-label="Reihenfolge" onChange={e => setByStars(e.target.value === 'stars')}>
          <option value="order">Reihenfolge wie probiert</option>
          <option value="stars">Beste Sterne zuerst</option>
        </select>
      </div>
      <label className="qr-row"><input type="checkbox" checked={onlySpecial} onChange={e => setOnlySpecial(e.target.checked)} /><span>Nur „außergewöhnlich“</span></label>
      <div className="count">{count} {count === 1 ? 'Whisky' : 'Whiskys'} ausgewählt</div>

      <div className="row-btns">
        <button type="button" className="scan-btn" disabled={!count || !!busy} onClick={wordJournal}>{busy === 'word' ? 'Erstellt…' : 'Journal als Word'}</button>
        <button type="button" className="scan-btn secondary" disabled={!count || !!busy} onClick={pdfJournal}>{busy === 'pdf' ? 'Bereitet vor…' : 'Journal als PDF'}</button>
      </div>
      {print && (
        <div className="confirm-box">
          <p>Die Druckansicht ist bereit. Im Druckdialog „Als PDF speichern“ wählen, Ränder „Keine“, Skalierung 100 %.</p>
          <button type="button" className="scan-btn" onClick={() => window.print()}>Drucken / Als PDF speichern</button>
          <button type="button" className="ghost-btn" onClick={closePrint}>Schließen</button>
        </div>
      )}

      <button type="button" className="scan-btn secondary" style={{ marginTop: 4 }} disabled={!gifRows.length} onClick={() => setGifOpen(o => !o)}>
        {gifOpen ? 'GIF-Auswahl schließen' : `GIF aus Etiketten (${gifRows.length} Bilder)`}
      </button>

      {gifOpen && (
        <div className="t-gif">
          <p className="hint">Pro Whisky wird das erste Foto (Vorderseite) verwendet. Tippe ein Bild an, um es abzuwählen.</p>
          <div className="t-gifgrid">
            {gifRows.map(({ t }) => (
              <button key={t.id} type="button" className={'t-gifitem' + (gifOff[t.id] ? ' off' : '')} aria-pressed={!gifOff[t.id]} onClick={() => setGifOff(o => ({ ...o, [t.id]: !o[t.id] }))}>
                {thumbUrls[t.image_thumb] ? <img src={thumbUrls[t.image_thumb]} alt={titleOf(t)} /> : <span className="t-noimg">🥃</span>}
                <span className="t-gifcheck">{gifOff[t.id] ? '' : '✓'}</span>
                <span className="t-giftitle">{titleOf(t) || 'Unbenannt'}</span>
              </button>
            ))}
          </div>
          <div className="filter-row">
            <select value={delay} aria-label="Dauer pro Bild" onChange={e => setDelay(Number(e.target.value))}>
              <option value={700}>0,7 s pro Bild</option>
              <option value={1200}>1,2 s pro Bild</option>
              <option value={2000}>2 s pro Bild</option>
              <option value={3000}>3 s pro Bild</option>
            </select>
            <select value={size} aria-label="Größe" onChange={e => setSize(Number(e.target.value))}>
              <option value={480}>480 px (klein)</option>
              <option value={640}>640 px</option>
              <option value={800}>800 px (groß)</option>
            </select>
          </div>
          <label className="qr-row"><input type="checkbox" checked={captions} onChange={e => setCaptions(e.target.checked)} /><span>Name und Sterne einblenden</span></label>
          <div className="hint">{gifChosen.length} Bilder · Dateigröße etwa {estMb} MB</div>
          <button type="button" className="save-btn" disabled={!gifChosen.length || !!busy} onClick={createGif}>{busy === 'gif' ? 'Erstellt…' : 'GIF erstellen'}</button>
          {prog && (
            <div className="t-prog"><div className="fill-bar"><div className="fill-bar-inner" style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }} /></div><span>{prog.step} {prog.done}/{prog.total}</span></div>
          )}
          {gifOut && (
            <div className="t-gifout">
              <img src={gifOut.url} alt="GIF-Vorschau" />
              <div className="hint">{gifOut.count} Bilder · {(gifOut.blob.size / 1048576).toFixed(1).replace('.', ',')} MB{gifOut.skipped ? ` · ${gifOut.skipped} Bilder konnten nicht geladen werden` : ''}</div>
              <div className="row-btns">
                <button type="button" className="scan-btn" onClick={() => saveBlob(gifOut.blob, `Whisky-Tasting-${todayIso()}.gif`)}>Speichern</button>
                <button type="button" className="scan-btn secondary" onClick={shareGif}>Teilen</button>
              </div>
            </div>
          )}
        </div>
      )}
      {print && <JournalPrint journal={print.journal} urls={print.urls} />}
    </div>
  )
}
