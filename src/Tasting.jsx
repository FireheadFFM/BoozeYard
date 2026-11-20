import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { BUCKET, fetchAll, lsGet, lsSet } from './utils'
import { runAnalyze, resizeCached } from './shared'
import { todayIso, fmtDate, starsText, avgStars, fmtAvg, titleOf, metaOf, sortRatings, hasSpecial } from './tastingUtils'
import TastingExport from './TastingExport'

// Tasting: Whiskys auf Messen und Verkostungen erfassen (Etikett-Foto), mit Sternen, "außergewöhnlich" und Kurzbeschreibung bewerten

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

const SORTS = [
  ['date_desc', 'Datum: neueste zuerst'],
  ['date_asc', 'Datum: älteste zuerst'],
  ['stars', 'Sterne: beste zuerst'],
  ['special', 'Außergewöhnlich zuerst'],
]

/* ---------- Diktieren ---------- */

function Dictate({ onText }) {
  const [live, setLive] = useState(false)
  const recRef = useRef(null)
  useEffect(() => () => { try { recRef.current?.stop() } catch { /* ignorieren */ } }, [])
  if (!SR) return null
  function toggle() {
    if (live) { try { recRef.current?.stop() } catch { /* ignorieren */ } return }
    const r = new SR()
    r.lang = 'de-DE'
    r.interimResults = false
    r.continuous = true
    let text = ''
    r.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += ' ' + e.results[i][0].transcript
    }
    r.onerror = () => setLive(false)
    r.onend = () => {
      setLive(false)
      recRef.current = null
      const t = text.trim()
      if (t) onText(t)
    }
    recRef.current = r
    setLive(true)
    try { r.start() } catch { setLive(false) }
  }
  return (
    <button type="button" className={'t-mic' + (live ? ' live' : '')} onClick={toggle} aria-label={live ? 'Diktat beenden' : 'Beschreibung diktieren'}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  )
}

/* ---------- Hauptansicht ---------- */

export default function Tasting({ userId, cats, lookups, wishlist = [], reload }) {
  const [events, setEvents] = useState([])
  const [tastings, setTastings] = useState([])
  const [ratings, setRatings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [eventSel, setEventSel] = useState('')       // '' = alle Veranstaltungen
  const [evForm, setEvForm] = useState(null)         // { mode: 'new'|'edit', name, date, del }
  const [sortBy, setSortBy] = useState(() => (SORTS.some(s => s[0] === lsGet('tasting_sort')) ? lsGet('tasting_sort') : 'date_desc'))
  const [minStars, setMinStars] = useState(0)
  const [onlySpecial, setOnlySpecial] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [thumbs, setThumbs] = useState({})           // Pfad -> signierte URL
  const [local, setLocal] = useState({})             // Whisky-ID -> lokale Vorschau
  const [work, setWork] = useState({})               // Whisky-ID -> 'upload' | 'ai'
  const [errs, setErrs] = useState({})               // Whisky-ID -> Fehlertext
  const [confirm, setConfirm] = useState('')         // 'r:<id>' | 't:<id>' | 'e'
  const [raterOpen, setRaterOpen] = useState(null)   // Whisky-ID, bei der gerade ein Bewerter hinzugefügt wird
  const [raterName, setRaterName] = useState('')
  const photoRef = useRef(null)
  const backRef = useRef(null)
  const backFor = useRef(null)
  const filesRef = useRef({})
  const tastingsRef = useRef([])
  const ratingsRef = useRef([])
  tastingsRef.current = tastings
  ratingsRef.current = ratings

  async function loadThumbs(rows) {
    const paths = rows.map(t => t.image_thumb).filter(Boolean)
    if (paths.length === 0) return
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    const map = {}
    ;(data || []).forEach(x => { if (x.signedUrl) map[x.path] = x.signedUrl })
    setThumbs(map)
  }

  async function load() {
    const [ev, tg, rt] = await Promise.all([
      fetchAll(() => supabase.from('tasting_events').select('*').order('event_date', { ascending: false }).order('created_at', { ascending: false }).order('id')),
      fetchAll(() => supabase.from('tastings').select('*').order('created_at').order('id')),
      fetchAll(() => supabase.from('tasting_ratings').select('*').order('created_at').order('id')),
    ])
    const err = ev.error || tg.error || rt.error
    if (err) {
      setError(/relation|does not exist|schema cache/i.test(err.message)
        ? 'Die Tasting-Tabellen fehlen noch. Bitte in Supabase die Datei 09_update.sql ausführen.'
        : 'Daten konnten nicht geladen werden: ' + err.message)
    } else {
      setError('')
      setEvents(ev.data)
      setTastings(tg.data)
      setRatings(rt.data)
      setEventSel(cur => {
        if (cur && ev.data.some(e => e.id === cur)) return cur
        const stored = lsGet('tasting_event')
        if (stored && ev.data.some(e => e.id === stored)) return stored
        return ev.data[0]?.id || ''
      })
      if (ev.data.length === 0) setEvForm({ mode: 'new', name: '', date: todayIso() })
      loadThumbs(tg.data)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Neu angelegte Karte in den Blick holen
  useEffect(() => {
    if (!openId) return
    const t = setTimeout(() => { try { document.getElementById('t-' + openId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch { /* ignorieren */ } }, 60)
    return () => clearTimeout(t)
  }, [openId])

  const fail = e => setMsg('Fehler: ' + (e?.message || e))

  /* ----- Veranstaltungen ----- */

  function pickEvent(id) {
    setEventSel(id)
    if (id) lsSet('tasting_event', id)
    setEvForm(null)
    setConfirm('')
  }

  async function saveEvent() {
    const name = evForm.name.trim()
    if (!name) return setMsg('Fehler: Bitte einen Namen für die Veranstaltung eintragen.')
    if (!evForm.date) return setMsg('Fehler: Bitte ein Datum wählen.')
    setMsg('')
    if (evForm.mode === 'new') {
      const { data, error: e } = await supabase.from('tasting_events').insert({ name, event_date: evForm.date }).select('*').single()
      if (e) return fail(e)
      setEvents(l => [data, ...l])
      pickEvent(data.id)
    } else {
      const { error: e } = await supabase.from('tasting_events').update({ name, event_date: evForm.date }).eq('id', eventSel)
      if (e) return fail(e)
      setEvents(l => l.map(x => (x.id === eventSel ? { ...x, name, event_date: evForm.date } : x)))
      setEvForm(null)
    }
  }

  async function deleteEvent() {
    const id = eventSel
    const paths = tastings.filter(t => t.event_id === id).flatMap(t => [t.image_front, t.image_back, t.image_thumb]).filter(Boolean)
    try {
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths)
      const { error: e } = await supabase.from('tasting_events').delete().eq('id', id)
      if (e) throw e
    } catch (e) { return fail(e) }
    const rest = events.filter(x => x.id !== id)
    setEvents(rest)
    setTastings(l => l.filter(t => t.event_id !== id))
    setRatings(l => l.filter(r => tastings.find(t => t.id === r.tasting_id)?.event_id !== id))
    setEvForm(null)
    setConfirm('')
    pickEvent(rest[0]?.id || '')
  }

  /* ----- Whisky anlegen und Foto auswerten ----- */

  const applyLocal = (id, patch) => setTastings(l => l.map(t => (t.id === id ? { ...t, ...patch } : t)))
  const setErr = (id, text) => setErrs(e => { const n = { ...e }; if (text) n[id] = text; else delete n[id]; return n })
  const setBusy = (id, v) => setWork(w => { const n = { ...w }; if (v) n[id] = v; else delete n[id]; return n })

  async function download(path) {
    const { data, error: e } = await supabase.storage.from(BUCKET).download(path)
    if (e) throw e
    return data
  }

  // Aus der KI-Antwort nur Felder übernehmen, die noch leer sind (Eingaben von Hand bleiben)
  function aiPatch(id, r) {
    const cur = tastingsRef.current.find(x => x.id === id) || {}
    const patch = {}
    if (!cur.brand && r.brand) patch.brand = r.brand
    if (!cur.name && r.name) patch.name = r.name
    if ((cur.abv === null || cur.abv === undefined || cur.abv === '') && r.abv !== null && r.abv !== undefined) patch.abv = r.abv
    if (!cur.country && r.country) patch.country = r.country
    if (!cur.region && r.region) patch.region = r.region
    return patch
  }

  async function savePatch(id, patch) {
    if (Object.keys(patch).length === 0) return
    applyLocal(id, patch)
    const { error: e } = await supabase.from('tastings').update(patch).eq('id', id)
    if (e) fail(e)
  }

  async function processPhoto(id, file) {
    setBusy(id, 'upload')
    setErr(id, '')
    const stamp = Date.now()
    const put = async (path, blob) => {
      const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
      if (up.error) throw up.error
    }
    const frontPath = `${userId}/tasting/${id}/front-${stamp}.jpg`
    const thumbPath = `${userId}/tasting/${id}/thumb-${stamp}.jpg`
    const uploadJob = (async () => {
      const [big, small] = await Promise.all([resizeCached(file, 1000, 0.8), resizeCached(file, 240, 0.7)])
      await Promise.all([put(frontPath, big), put(thumbPath, small)])
      return { image_front: frontPath, image_thumb: thumbPath }
    })()
    const aiJob = runAnalyze([file], cats, lookups)
    const [up, ai] = await Promise.allSettled([uploadJob, aiJob])
    const patch = {}
    const problems = []
    if (up.status === 'fulfilled') Object.assign(patch, up.value)
    else problems.push('Das Foto konnte nicht gespeichert werden (' + (up.reason?.message || 'Fehler') + ').')
    if (ai.status === 'fulfilled') Object.assign(patch, aiPatch(id, ai.value))
    else problems.push('Die Erkennung hat nicht geklappt (' + (ai.reason?.message || 'Fehler') + '). Du kannst den Namen eintippen oder später „Erkennen“ tippen.')
    await savePatch(id, patch)
    setBusy(id, '')
    setErr(id, problems.join(' '))
  }

  async function recognize(id) {
    setBusy(id, 'ai')
    setErr(id, '')
    try {
      const t = tastingsRef.current.find(x => x.id === id)
      const f = filesRef.current[id] || {}
      const front = f.front || (t?.image_front ? await download(t.image_front) : null)
      if (!front) throw new Error('kein Foto vorhanden')
      const files = [front]
      const back = f.back || (t?.image_back ? await download(t.image_back) : null)
      if (back) files.push(back)
      const r = await runAnalyze(files, cats, lookups)
      const patch = aiPatch(id, r)
      await savePatch(id, patch)
      if (Object.keys(patch).length === 0) setErr(id, 'Auf dem Foto wurde nichts Neues erkannt.')
    } catch (e) {
      setErr(id, 'Die Erkennung hat nicht geklappt (' + e.message + ').')
    }
    setBusy(id, '')
  }

  async function addBack(id, file) {
    filesRef.current[id] = { ...(filesRef.current[id] || {}), back: file }
    setBusy(id, 'upload')
    try {
      const path = `${userId}/tasting/${id}/back-${Date.now()}.jpg`
      const blob = await resizeCached(file, 1000, 0.8)
      const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
      if (up.error) throw up.error
      await savePatch(id, { image_back: path })
    } catch (e) {
      setErr(id, 'Die Rückseite konnte nicht gespeichert werden (' + e.message + ').')
      setBusy(id, '')
      return
    }
    await recognize(id)
  }

  async function createWhisky(file) {
    if (!eventSel) return setMsg('Fehler: Bitte zuerst eine Veranstaltung wählen.')
    setMsg('')
    const { data: row, error: e1 } = await supabase.from('tastings').insert({ event_id: eventSel, brand: '', name: '' }).select('*').single()
    if (e1) return fail(e1)
    const { data: rt, error: e2 } = await supabase.from('tasting_ratings').insert({ tasting_id: row.id, rater: lsGet('tasting_me') || 'Ich', is_me: true }).select('*').single()
    if (e2) fail(e2)
    setTastings(l => [...l, row])
    if (rt) setRatings(l => [...l, rt])
    setOpenId(row.id)
    if (file) {
      filesRef.current[row.id] = { front: file }
      setLocal(m => ({ ...m, [row.id]: URL.createObjectURL(file) }))
      processPhoto(row.id, file)
    }
  }

  function onPhoto(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) createWhisky(file)
  }
  function onBack(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file && backFor.current) addBack(backFor.current, file)
  }

  /* ----- Felder und Bewertungen ----- */

  const editField = (id, k, v) => applyLocal(id, { [k]: v })
  async function saveField(id, k) {
    const t = tastingsRef.current.find(x => x.id === id)
    if (!t) return
    let v = t[k]
    if (k === 'abv') {
      v = String(v ?? '').trim() === '' ? null : parseFloat(String(v).replace(',', '.'))
      if (v !== null && !isFinite(v)) v = null
      applyLocal(id, { abv: v })
    } else {
      v = typeof v === 'string' ? v.trim() : v
      applyLocal(id, { [k]: v })
      if (!v && (k === 'country' || k === 'region')) v = null
    }
    const { error: e } = await supabase.from('tastings').update({ [k]: v }).eq('id', id)
    if (e) fail(e)
  }

  async function patchRating(id, patch, save = true) {
    setRatings(l => l.map(r => (r.id === id ? { ...r, ...patch } : r)))
    if (!save) return
    const { error: e } = await supabase.from('tasting_ratings').update(patch).eq('id', id)
    if (e) fail(e)
  }
  async function saveRatingText(id, k) {
    const r = ratingsRef.current.find(x => x.id === id)
    if (!r) return
    let v = String(r[k] ?? '').trim()
    if (k === 'rater' && !v) v = r.is_me ? 'Ich' : 'Gast'
    if (k === 'rater' && r.is_me) lsSet('tasting_me', v)
    if (k === 'note' && !v) v = null
    await patchRating(id, { [k]: v })
  }
  function setStars(r, n) {
    patchRating(r.id, { stars: r.stars === n ? null : n })
  }
  function appendNote(r, text) {
    const cur = ratingsRef.current.find(x => x.id === r.id)?.note || ''
    patchRating(r.id, { note: (cur ? cur.trim() + ' ' : '') + text })
  }

  const knownRaters = useMemo(() => {
    const cnt = {}
    for (const r of ratings) if (!r.is_me && r.rater) cnt[r.rater] = (cnt[r.rater] || 0) + 1
    return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b))
  }, [ratings])

  async function addRater(tid, nameRaw) {
    const name = String(nameRaw || '').trim()
    if (!name) return
    if (ratingsRef.current.some(r => r.tasting_id === tid && r.rater.toLowerCase() === name.toLowerCase())) { setRaterName(''); return setMsg(`Fehler: „${name}“ hat hier schon eine Bewertung.`) }
    setMsg('')
    const { data, error: e } = await supabase.from('tasting_ratings').insert({ tasting_id: tid, rater: name, is_me: false }).select('*').single()
    if (e) return fail(e)
    setRatings(l => [...l, data])
    setRaterName('')
    setRaterOpen(null)
  }

  async function deleteRating(id) {
    const { error: e } = await supabase.from('tasting_ratings').delete().eq('id', id)
    if (e) return fail(e)
    setRatings(l => l.filter(r => r.id !== id))
    setConfirm('')
  }

  async function deleteWhisky(t) {
    try {
      const paths = [t.image_front, t.image_back, t.image_thumb].filter(Boolean)
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths)
      const { error: e } = await supabase.from('tastings').delete().eq('id', t.id)
      if (e) throw e
    } catch (e) { return fail(e) }
    setTastings(l => l.filter(x => x.id !== t.id))
    setRatings(l => l.filter(r => r.tasting_id !== t.id))
    setOpenId(null)
    setConfirm('')
  }

  const onWishlist = t => {
    const key = titleOf(t).toLowerCase()
    return !!key && wishlist.some(w => `${w.brand || ''} ${w.name || ''}`.trim().toLowerCase() === key)
  }
  async function addWishlist(t) {
    if (!titleOf(t)) return setMsg('Fehler: Bitte zuerst Marke und Name eintragen.')
    const { error: e } = await supabase.from('wishlist').insert({ brand: t.brand || '', name: t.name || t.brand, quantity: 1 })
    if (e) return fail(e)
    setMsg(`${titleOf(t)} steht jetzt auf der Wunschliste (Einkauf).`)
    reload && reload()
  }

  /* ----- Liste ----- */

  const evById = useMemo(() => Object.fromEntries(events.map(e => [e.id, e])), [events])
  const rBy = useMemo(() => {
    const m = {}
    for (const r of ratings) (m[r.tasting_id] ||= []).push(r)
    for (const k of Object.keys(m)) m[k] = sortRatings(m[k])
    return m
  }, [ratings])

  const rows = useMemo(() => {
    let list = tastings
      .filter(t => !eventSel || t.event_id === eventSel)
      .map(t => { const rs = rBy[t.id] || []; return { t, rs, avg: avgStars(rs), special: hasSpecial(rs) } })
    if (minStars) list = list.filter(x => x.avg !== null && x.avg >= minStars)
    if (onlySpecial) list = list.filter(x => x.special)
    const byTime = (a, b) => String(a.t.created_at).localeCompare(String(b.t.created_at))
    if (sortBy === 'stars') list.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || byTime(b, a))
    else if (sortBy === 'special') list.sort((a, b) => (b.special ? 1 : 0) - (a.special ? 1 : 0) || (b.avg ?? -1) - (a.avg ?? -1) || byTime(b, a))
    return list
  }, [tastings, rBy, eventSel, minStars, onlySpecial, sortBy])

  const groups = useMemo(() => {
    if (sortBy !== 'date_desc' && sortBy !== 'date_asc') return [{ key: 'all', ev: null, rows }]
    const asc = sortBy === 'date_asc'
    const ids = [...new Set(rows.map(x => x.t.event_id))]
    ids.sort((a, b) => {
      const d = String(evById[a]?.event_date || '').localeCompare(String(evById[b]?.event_date || ''))
      return asc ? d : -d
    })
    return ids.map(id => {
      const rs = rows.filter(x => x.t.event_id === id)
      rs.sort((a, b) => (asc ? 1 : -1) * String(a.t.created_at).localeCompare(String(b.t.created_at)))
      return { key: id, ev: evById[id], rows: rs }
    })
  }, [rows, sortBy, evById])

  const curEvent = eventSel ? evById[eventSel] : null

  function renderCard({ t, rs, avg, special }) {
    const open = openId === t.id
    const img = local[t.id] || (t.image_thumb ? thumbs[t.image_thumb] : '')
    const busy = work[t.id]
    const title = titleOf(t) || (busy ? 'Wird erkannt…' : (t.image_front || local[t.id]) ? 'Noch nicht erkannt' : 'Unbenannt')
    const rated = rs.filter(r => r.stars).length
    const canRecognize = !!(t.image_front || filesRef.current[t.id]?.front)
    const used = new Set(rs.map(r => r.rater.toLowerCase()))
    const suggestions = knownRaters.filter(n => !used.has(n.toLowerCase()))
    return (
      <div key={t.id} id={'t-' + t.id} className={'card column t-card' + (open ? ' open' : '')}>
        <div className="t-head" onClick={() => setOpenId(open ? null : t.id)}>
          <div className={'card-icon has-thumb' + (img ? '' : ' empty')}>
            {img ? <img className="thumb" src={img} alt="" /> : <span className="t-noimg">{busy ? '…' : '🥃'}</span>}
          </div>
          <div className="card-info">
            <h3>{title}</h3>
            <p>{metaOf(t) || (busy === 'ai' || busy === 'upload' ? 'Foto wird ausgewertet…' : '')}</p>
            {!eventSel && evById[t.event_id] && <p className="muted t-evline">{evById[t.event_id].name} · {fmtDate(evById[t.event_id].event_date)}</p>}
            <div className="t-sum">
              {avg !== null ? <span className="t-stars-sum">{starsText(Math.round(avg))} <b>{fmtAvg(avg)}</b></span> : <span className="muted">noch nicht bewertet</span>}
              {rs.length > 1 && <span className="muted"> · {rated}/{rs.length} Bewertungen</span>}
              {special && <span className="tag warn t-special-tag">✦ außergewöhnlich</span>}
            </div>
          </div>
        </div>

        {open && (
          <div className="t-body">
            {errs[t.id] && <div className="msg error">{errs[t.id]}</div>}
            {busy && <div className="hint">{busy === 'upload' ? 'Foto wird gespeichert und ausgewertet…' : 'Wird ausgewertet…'}</div>}
            <div className="t-fields">
              <label className="fld"><span>Marke</span><input value={t.brand || ''} onChange={e => editField(t.id, 'brand', e.target.value)} onBlur={() => saveField(t.id, 'brand')} /></label>
              <label className="fld"><span>Name</span><input value={t.name || ''} onChange={e => editField(t.id, 'name', e.target.value)} onBlur={() => saveField(t.id, 'name')} /></label>
              <label className="fld"><span>Alkohol (%)</span><input inputMode="decimal" value={t.abv ?? ''} onChange={e => editField(t.id, 'abv', e.target.value)} onBlur={() => saveField(t.id, 'abv')} /></label>
              <label className="fld"><span>Land</span><input value={t.country || ''} onChange={e => editField(t.id, 'country', e.target.value)} onBlur={() => saveField(t.id, 'country')} /></label>
              <label className="fld wide"><span>Region / Stil</span><input value={t.region || ''} onChange={e => editField(t.id, 'region', e.target.value)} onBlur={() => saveField(t.id, 'region')} /></label>
            </div>
            <div className="row-btns">
              {canRecognize && <button type="button" className="mini" disabled={!!busy} onClick={() => recognize(t.id)}>Erkennen (KI)</button>}
              <button type="button" className="mini" disabled={!!busy} onClick={() => { backFor.current = t.id; backRef.current?.click() }}>{t.image_back ? 'Rückseite ersetzen' : 'Rückseite fotografieren'}</button>
            </div>

            <h4 className="t-sec">Bewertungen</h4>
            {rs.map(r => (
              <div key={r.id} className="t-rating">
                <div className="t-rhead">
                  <input className="t-rater" value={r.rater} aria-label="Name" onChange={e => patchRating(r.id, { rater: e.target.value }, false)} onBlur={() => saveRatingText(r.id, 'rater')} />
                  {!r.is_me && confirm !== 'r:' + r.id && <button type="button" className="t-x" aria-label="Bewertung entfernen" onClick={() => setConfirm('r:' + r.id)}>×</button>}
                  {confirm === 'r:' + r.id && <button type="button" className="mini danger-mini" onClick={() => deleteRating(r.id)}>Wirklich entfernen</button>}
                </div>
                <div className="t-stars">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button key={n} type="button" className={'t-star' + (r.stars >= n ? ' on' : '')} aria-label={`${n} Sterne`} onClick={() => setStars(r, n)}>{r.stars >= n ? '★' : '☆'}</button>
                  ))}
                  <button type="button" className={'t-special' + (r.special ? ' on' : '')} aria-pressed={!!r.special} onClick={() => patchRating(r.id, { special: !r.special })}>✦ Außergewöhnlich</button>
                </div>
                <div className="t-note">
                  <textarea rows={2} placeholder="Kurze Beschreibung (tippen oder diktieren)" value={r.note || ''}
                    onChange={e => patchRating(r.id, { note: e.target.value }, false)} onBlur={() => saveRatingText(r.id, 'note')} />
                  <Dictate onText={text => appendNote(r, text)} />
                </div>
              </div>
            ))}

            {raterOpen === t.id ? (
              <div className="t-addrater">
                {suggestions.length > 0 && (
                  <div className="chips">
                    {suggestions.map(n => <button key={n} type="button" className="chip chip-btn" onClick={() => addRater(t.id, n)}>{n}</button>)}
                  </div>
                )}
                <div className="inline-add">
                  <input placeholder="Name, z. B. Tom" value={raterName} onChange={e => setRaterName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addRater(t.id, raterName) }} />
                  <button type="button" onClick={() => addRater(t.id, raterName)}>Hinzufügen</button>
                </div>
                <button type="button" className="ghost-btn" onClick={() => { setRaterOpen(null); setRaterName('') }}>Abbrechen</button>
              </div>
            ) : (
              <button type="button" className="mini t-add-r" onClick={() => { setRaterOpen(t.id); setRaterName('') }}>+ Bewertung von…</button>
            )}

            <div className="row-btns t-foot">
              <button type="button" className="mini" disabled={onWishlist(t)} onClick={() => addWishlist(t)}>{onWishlist(t) ? 'Auf der Wunschliste ✓' : 'Auf die Wunschliste'}</button>
              {confirm !== 't:' + t.id
                ? <button type="button" className="mini danger-mini" onClick={() => setConfirm('t:' + t.id)}>Löschen</button>
                : <button type="button" className="mini danger-mini" onClick={() => deleteWhisky(t)}>Wirklich löschen</button>}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div className="empty">Lädt…</div>
  if (error) return <div className="msg error">{error}</div>

  return (
    <div className="tasting">
      {msg && <div className={'msg' + (msg.startsWith('Fehler') ? ' error' : '')}>{msg}</div>}

      <div className="card column">
        <div className="fld"><span>Veranstaltung</span>
          <select value={eventSel} onChange={e => pickEvent(e.target.value)}>
            <option value="">Alle Veranstaltungen</option>
            {events.map(e => <option key={e.id} value={e.id}>{e.name} · {fmtDate(e.event_date)}</option>)}
          </select>
        </div>
        <div className="row-btns">
          <button type="button" className="mini" onClick={() => setEvForm(f => (f?.mode === 'new' ? null : { mode: 'new', name: '', date: todayIso() }))}>+ Neue Veranstaltung</button>
          {curEvent && <button type="button" className="mini" onClick={() => setEvForm(f => (f?.mode === 'edit' ? null : { mode: 'edit', name: curEvent.name, date: curEvent.event_date }))}>Bearbeiten</button>}
        </div>
        {evForm && (
          <div className="edit-box">
            <label className="fld"><span>Name</span><input placeholder="z. B. Whisky Messe Frankfurt" value={evForm.name} onChange={e => setEvForm({ ...evForm, name: e.target.value })} /></label>
            <label className="fld"><span>Datum</span><input type="date" value={evForm.date} onChange={e => setEvForm({ ...evForm, date: e.target.value })} /></label>
            <button type="button" className="save-btn" onClick={saveEvent}>{evForm.mode === 'new' ? 'Veranstaltung anlegen' : 'Speichern'}</button>
            {evForm.mode === 'edit' && (confirm !== 'e'
              ? <button type="button" className="danger-btn slim" onClick={() => setConfirm('e')}>Veranstaltung löschen</button>
              : (
                <div className="confirm-box">
                  <p>„{curEvent?.name}“ mit allen {tastings.filter(t => t.event_id === eventSel).length} Whiskys und Bewertungen wird endgültig gelöscht.</p>
                  <button type="button" className="scan-btn" onClick={deleteEvent}>Endgültig löschen</button>
                  <button type="button" className="ghost-btn" onClick={() => setConfirm('')}>Abbrechen</button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="t-add">
        <button type="button" className="scan-btn t-big" disabled={!eventSel} onClick={() => photoRef.current?.click()}>Whisky fotografieren</button>
        <button type="button" className="scan-btn secondary t-big" disabled={!eventSel} onClick={() => createWhisky(null)}>Ohne Foto eintragen</button>
        {!eventSel && <div className="hint">Wähle oben eine Veranstaltung (statt „Alle“) oder lege eine neue an, dann kannst du Whiskys erfassen.</div>}
        <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
        <input ref={backRef} type="file" accept="image/*" capture="environment" hidden onChange={onBack} />
      </div>

      <div className="filters t-filters">
        <div className="filter-row">
          <select value={sortBy} aria-label="Sortierung" onChange={e => { setSortBy(e.target.value); lsSet('tasting_sort', e.target.value) }}>
            {SORTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={minStars} aria-label="Mindeststerne" onChange={e => setMinStars(Number(e.target.value))}>
            <option value={0}>Alle Sterne</option>
            {[2, 3, 4, 5].map(n => <option key={n} value={n}>ab {n} Sternen</option>)}
          </select>
        </div>
        <label className="qr-row">
          <input type="checkbox" checked={onlySpecial} onChange={e => setOnlySpecial(e.target.checked)} />
          <span>Nur „außergewöhnlich“</span>
        </label>
        <div className="count">{rows.length} {rows.length === 1 ? 'Whisky' : 'Whiskys'}</div>
      </div>

      {rows.length === 0 && <div className="empty">{tastings.length === 0 ? 'Noch kein Whisky erfasst. Tippe auf „Whisky fotografieren“.' : 'Keine Whiskys für diese Auswahl.'}</div>}
      {groups.map(g => (
        <div key={g.key}>
          {g.ev && <div className="t-group">{g.ev.name} · {fmtDate(g.ev.event_date)} <span>{g.rows.length}</span></div>}
          {g.rows.map(renderCard)}
        </div>
      ))}

      <TastingExport events={events} tastings={tastings} ratings={ratings} selectedEvent={eventSel} />
    </div>
  )
}
