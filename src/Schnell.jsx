import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { BUCKET, STATUS, normKey, digitsOnly, codeVariants, lsGet, lsSet, resizeImage } from './utils'
import { decodeFromFile, runAnalyze, aiToPrefill, ensureRoom, ensureLocation, ensureLookup, clearReorderFor } from './shared'

/* ---------- Zwischenspeicher auf dem Handy (IndexedDB) ---------- */
// Damit ein Neuladen der App angefangene Fotos nicht vernichtet.

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('kein IndexedDB'))
    const r = indexedDB.open('boozeyard-quick', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
async function idbGet(key) {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const q = db.transaction('kv').objectStore('kv').get(key)
      q.onsuccess = () => resolve(q.result || null)
      q.onerror = () => reject(q.error)
    })
  } catch { return null }
}
async function idbPut(key, val) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite')
      t.objectStore('kv').put(val, key)
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
  } catch { /* Zwischenspeicher ist nur ein Zusatz */ }
}
async function idbDel(key) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite')
      t.objectStore('kv').delete(key)
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
  } catch { /* egal */ }
}

/* ---------- Hilfen ---------- */

const SLOT_LIST = [['front', 'Vorderseite', true], ['back', 'Rückseite (Barcode)', true], ['side', 'Seite / Hals', false]]
const FILLS = [100, 90, 75, 50, 25, 10]
const PARALLEL = 3
let counter = 0
const newId = () => `q${Date.now()}_${counter++}`

// Passender Eintrag im Bestand: erst Barcode, dann Marke + Name (+ Größe)
function findMatch(c, bottles) {
  let cands = []
  if (c.barcode) {
    const v = codeVariants(digitsOnly(c.barcode))
    cands = bottles.filter(b => b.barcode && v.includes(digitsOnly(b.barcode)))
  }
  const size = parseInt(c.size, 10)
  if (!cands.length && c.brand && c.name) {
    const key = normKey(c.brand + c.name)
    cands = bottles.filter(b => normKey(b.brand + b.name) === key && (!size || !b.size_ml || b.size_ml === size))
  }
  const rank = { closed: 0, open: 1, empty: 2 }
  return cands.sort((a, b) => rank[a.status] - rank[b.status])[0] || null
}

function missing(c) {
  const m = []
  if (!c.brand.trim()) m.push('Marke')
  if (!c.name.trim()) m.push('Name')
  if (!c.catId) m.push('Kategorie')
  if (!(parseInt(c.size, 10) > 0)) m.push('Größe')
  return m
}

function cardFromItem(it, preset) {
  const ai = it.ai || {}
  const country = ai.country === '__new' ? (ai.newCountry || '') : (ai.country || '')
  const region = ai.region === '__new' ? (ai.newRegion || '') : (ai.region || '')
  return {
    cid: newId(),
    members: [it],
    brand: ai.brand || '',
    name: ai.name || '',
    catId: ai.category_id || '',
    abv: ai.abv === null || ai.abv === undefined ? '' : String(ai.abv),
    size: ai.size_ml ? String(ai.size_ml) : '',
    vintage: ai.vintage || '',
    country, region,
    notes: ai.noteText || '',
    barcode: it.barcode || '',
    qty: preset.status === 'open' ? '1' : String(it.qty || 1),
    bstatus: preset.status,
    fill: preset.fill,
    include: true,
    mode: 'new',
    big: false,
    guess: { catId: !!ai.category_id, country: !!country, region: !!region },
    err: it.state === 'error' ? it.err : '',
  }
}

export default function Schnell({ userId, bottles, cats, rooms, locations, lookups, reload, onDone }) {
  const storeKey = `batch-${userId}`
  const [stage, setStage] = useState('setup')       // setup → capture → wait → review → done
  const [preset, setPreset] = useState(() => {
    const roomId = lsGet('quick_room') || ''
    const locId = lsGet('quick_loc') || ''
    return {
      roomId: rooms.some(r => r.id === roomId) ? roomId : '',
      locId: locations.some(l => l.id === locId) ? locId : '',
      newRoom: '', newLoc: '',
      status: lsGet('quick_status') === 'open' ? 'open' : 'closed',
      fill: Number(lsGet('quick_fill')) || 100,
    }
  })
  const [items, setItems] = useState([])
  const [draft, setDraft] = useState({})            // { front, back, side } als Dateien
  const [draftUrls, setDraftUrls] = useState({})
  const [draftQty, setDraftQty] = useState(1)
  const [saved, setSaved] = useState(null)          // gefundener Zwischenstand
  const [cards, setCards] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const startedRef = useRef(new Set())
  const prepRef = useRef(new Set())
  const inputs = useRef({})

  const roomLocs = locations.filter(l => l.room_id === preset.roomId)

  useEffect(() => {
    let alive = true
    idbGet(storeKey).then(v => { if (alive && v?.items?.length) setSaved(v) })
    return () => { alive = false }
  }, [storeKey])

  // Display wach halten, solange fotografiert oder ausgewertet wird
  useEffect(() => {
    if (!(stage === 'capture' || stage === 'wait') || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined
    let lock = null
    let alive = true
    const acquire = async () => {
      if (lock || document.visibilityState !== 'visible') return
      try {
        const l = await navigator.wakeLock.request('screen')
        if (!alive) { l.release().catch(() => {}); return }
        lock = l
        l.addEventListener('release', () => { if (lock === l) lock = null })
      } catch { /* nicht schlimm */ }
    }
    const onVis = () => { if (document.visibilityState === 'visible') acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      if (lock) lock.release().catch(() => {})
    }
  }, [stage])

  const patch = (id, p) => setItems(list => list.map(x => (x.id === id ? { ...x, ...p } : x)))

  async function analyzeItem(it) {
    try {
      const files = [it.blobs.front, it.blobs.back, it.blobs.side].filter(Boolean)
      const barcodeP = (async () => {
        try { return (await decodeFromFile(it.blobs.back)) || (await decodeFromFile(it.blobs.front)) } catch { return null }
      })()
      const [code, r] = await Promise.all([barcodeP, runAnalyze(files, cats, lookups)])
      const { data } = aiToPrefill(r, cats, lookups)
      patch(it.id, { state: 'done', barcode: code ? digitsOnly(code) : '', ai: data, err: '' })
    } catch (e) {
      patch(it.id, { state: 'error', err: e.message || 'Auswertung fehlgeschlagen', barcode: '', ai: {} })
    }
  }

  // Warteschlange: höchstens PARALLEL Auswertungen gleichzeitig
  useEffect(() => {
    let free = PARALLEL - items.filter(i => i.state === 'working').length
    for (const it of items) {
      if (free <= 0) break
      if (it.state === 'queued' && !startedRef.current.has(it.id)) {
        startedRef.current.add(it.id)
        free--
        patch(it.id, { state: 'working' })
        analyzeItem(it)
      }
    }
  }, [items])

  // Fotos im Hintergrund verkleinern (damit man sofort die nächste Flasche aufnehmen kann)
  useEffect(() => {
    for (const it of items) {
      if (it.state === 'preparing' && !prepRef.current.has(it.id)) {
        prepRef.current.add(it.id)
        prepareItem(it)
      }
    }
  }, [items])

  async function prepareItem(it) {
    try {
      const entries = await Promise.all(SLOT_LIST.filter(([slot]) => it.files?.[slot]).map(async ([slot]) => [slot, await resizeImage(it.files[slot], 1800, 0.85)]))
      setItems(list => list.map(x => (x.id === it.id ? { ...x, blobs: Object.fromEntries(entries), files: null, state: 'queued' } : x)))
    } catch (e) {
      setItems(list => list.map(x => (x.id === it.id ? { ...x, state: 'error', err: 'Foto konnte nicht verarbeitet werden: ' + (e.message || e) } : x)))
    }
  }

  // Zwischenstand sichern, sobald ein Foto-Paar fertig verkleinert ist
  const persistKey = items.filter(i => i.blobs).map(i => i.id).join(',')
  useEffect(() => {
    if (persistKey) persist(items)
  }, [persistKey])

  // Beim Warten: sobald alles ausgewertet ist, weiter zur Prüfung
  useEffect(() => {
    if (stage !== 'wait') return
    if (items.some(i => i.state === 'preparing' || i.state === 'queued' || i.state === 'working')) return
    const usable = items.filter(i => i.blobs)
    if (usable.length < items.length) setError(`${items.length - usable.length} Flasche${items.length - usable.length === 1 ? '' : 'n'} konnten nicht verarbeitet werden und fehlen in der Liste.`)
    setCards(buildCards(usable))
    setStage('review')
  }, [stage, items])

  function buildCards(list) {
    const groups = []
    for (const it of list) {
      const c = cardFromItem(it, preset)
      const key = it.barcode || (c.brand && c.name ? `n:${normKey(c.brand + c.name)}:${c.size}` : '')
      const g = key ? groups.find(x => x.key === key) : null
      if (g) { g.card.members.push(it); g.card.qty = String(g.card.members.reduce((n, m) => n + (preset.status === 'open' ? 1 : (m.qty || 1)), 0)) } else groups.push({ key, card: c })
    }
    const locId = preset.locId === '__new' ? '' : preset.locId
    return groups.map(({ card }) => {
      const m = findMatch(card, bottles)
      if (m && m.status === 'closed' && card.bstatus === 'closed' && m.location_id === locId && (m.room_id === preset.roomId)) card.mode = 'add'
      return card
    })
  }

  /* ---------- Einrichtung ---------- */

  function startCapture() {
    if (!preset.roomId) return setError('Bitte einen Raum wählen.')
    if (preset.roomId === '__new' && !preset.newRoom.trim()) return setError('Bitte den Namen des neuen Raums eintragen.')
    if (preset.locId === '__new' && !preset.newLoc.trim()) return setError('Bitte den Namen des neuen Ortes eintragen.')
    setError('')
    if (preset.roomId !== '__new') lsSet('quick_room', preset.roomId)
    if (preset.locId && preset.locId !== '__new') lsSet('quick_loc', preset.locId)
    lsSet('quick_status', preset.status)
    lsSet('quick_fill', String(preset.fill))
    setStage('capture')
  }

  function resume() {
    if (!saved) return
    if (saved.preset) setPreset(p => ({ ...p, ...saved.preset }))
    setItems(saved.items.map(s => ({
      id: s.id, blobs: s.blobs, qty: s.qty || 1,
      urls: Object.fromEntries(Object.entries(s.blobs).map(([k, b]) => [k, URL.createObjectURL(b)])),
      state: 'queued', err: '', barcode: '', ai: null,
    })))
    setSaved(null)
    setStage('capture')
  }

  async function discardSaved() {
    await idbDel(storeKey)
    setSaved(null)
  }

  /* ---------- Fotografieren ---------- */

  function pick(slot, file) {
    if (!file) return
    setDraftUrls(u => { if (u[slot]) URL.revokeObjectURL(u[slot]); return { ...u, [slot]: URL.createObjectURL(file) } })
    setDraft(d => ({ ...d, [slot]: file }))
  }

  function clearDraft() {
    Object.values(draftUrls).forEach(u => URL.revokeObjectURL(u))
    setDraft({})
    setDraftUrls({})
    setDraftQty(1)
  }

  const draftReady = !!(draft.front && draft.back)
  const draftAny = !!(draft.front || draft.back || draft.side)

  async function persist(list, p = preset) {
    await idbPut(storeKey, { preset: p, items: list.filter(i => i.blobs).map(i => ({ id: i.id, blobs: i.blobs, qty: i.qty || 1 })) })
  }

  // Speichert sofort (ohne Wartezeit); Verkleinern, Auswertung und Zwischenspeichern laufen im Hintergrund
  function commitDraft() {
    setError('')
    const it = {
      id: newId(), files: { ...draft }, blobs: null,
      urls: { ...draftUrls },                 // Vorschau-Adressen werden weiterverwendet
      state: 'preparing', err: '', barcode: '', ai: null,
      qty: preset.status === 'open' ? 1 : draftQty,
    }
    setItems(list => [...list, it])
    setDraft({})
    setDraftUrls({})
    setDraftQty(1)
    return true
  }

  async function finishCapture() {
    if (draftAny) {
      if (!draftReady) return
      commitDraft()
    }
    setStage('wait')
  }

  function removeItem(id) {
    const next = items.filter(i => i.id !== id)
    setItems(next)
    persist(next)
  }

  function retry(id) {
    const it = items.find(x => x.id === id)
    if (it && !it.blobs) { prepRef.current.delete(id); patch(id, { state: 'preparing', err: '' }); return }
    startedRef.current.delete(id)
    patch(id, { state: 'queued', err: '' })
  }

  /* ---------- Prüfen ---------- */

  const setCard = (cid, p) => setCards(list => list.map(c => (c.cid === cid ? { ...c, ...p } : c)))

  function split(cid) {
    setCards(list => list.flatMap(c => (c.cid !== cid ? [c] : c.members.map(m => ({ ...c, cid: newId(), members: [m], qty: preset.status === 'open' ? '1' : String(m.qty || 1), mode: 'new' })))))
  }

  const includedCards = cards.filter(c => c.include)

  async function uploadImages(bottleId, blobs, skipThumb) {
    const update = {}
    const stamp = Date.now()
    const put = async (path, blob, maxSide, quality) => {
      const small = await resizeImage(blob, maxSide, quality)
      const up = await supabase.storage.from(BUCKET).upload(path, small, { contentType: 'image/jpeg' })
      if (up.error) throw up.error
    }
    const jobs = []
    for (const [slot] of SLOT_LIST) {
      const b = blobs[slot]
      if (!b) continue
      const path = `${userId}/${bottleId}/${slot}-${stamp}.jpg`
      jobs.push(put(path, b, 1000, 0.8))
      update[`image_${slot}`] = path
      if (slot === 'front' && !skipThumb) {
        const tpath = `${userId}/${bottleId}/thumb-${stamp}.jpg`
        jobs.push(put(tpath, b, 240, 0.7))
        update.image_thumb = tpath
      }
    }
    await Promise.all(jobs)
    if (Object.keys(update).length > 0) {
      const { error: e } = await supabase.from('bottles').update(update).eq('id', bottleId)
      if (e) throw e
    }
  }

  async function saveAll() {
    const bad = includedCards.filter(c => missing(c).length > 0)
    if (bad.length > 0) return setError(`Bei ${bad.length} Flasche${bad.length > 1 ? 'n' : ''} fehlen Pflichtangaben (rot umrandet: ${[...new Set(bad.flatMap(missing))].join(', ')}).`)
    if (includedCards.length === 0) return setError('Es ist nichts zum Anlegen ausgewählt.')
    setBusy(true)
    setError('')
    const fails = []
    const imageFails = []
    let created = 0
    let added = 0
    let pieces = 0
    try {
      let roomId = preset.roomId
      let locationId = null
      let madeStructure = false
      if (roomId === '__new') { roomId = await ensureRoom(rooms, preset.newRoom.trim()); madeStructure = true }
      if (preset.locId === '__new') { locationId = await ensureLocation(locations, roomId, preset.newLoc.trim()); madeStructure = true }
      else if (preset.locId && locations.some(l => l.id === preset.locId && l.room_id === roomId)) locationId = preset.locId
      if (madeStructure) {
        setPreset(p => ({ ...p, roomId, locId: locationId || '', newRoom: '', newLoc: '' }))
        await reload()
      }

      const madeLookups = []
      const lk = () => lookups.concat(madeLookups)
      const remaining = []

      for (const c of includedCards) {
        try {
          const qtyParsed = parseInt(c.qty, 10)
          const qty = Number.isNaN(qtyParsed) ? 1 : Math.max(1, qtyParsed)
          const target = c.mode === 'add' ? findMatch(c, bottles) : null
          if (target && target.status === 'closed' && c.bstatus === 'closed') {
            const { error: e1 } = await supabase.from('bottles').update({ quantity: target.quantity + qty }).eq('id', target.id)
            if (e1) throw e1
            await supabase.from('movements').insert({ bottle_id: target.id, type: 'adjustment', quantity: qty, notes: 'Erfassung' })
            await clearReorderFor(bottles, target)
            if (!target.image_front) {
              try { await uploadImages(target.id, c.members[0].blobs, false) } catch (e) { imageFails.push(`${c.brand} ${c.name}: ${e.message}`) }
            }
            added++
            pieces += qty
            continue
          }

          const lookup = async (kind, text, ctry) => {
            const n = await ensureLookup(lk(), kind, text, ctry)
            if (!lk().some(l => l.kind === kind && l.name === n)) madeLookups.push({ kind, name: n, country: kind === 'region' ? (ctry || null) : null })
            return n
          }
          let country = c.country.trim()
          if (country) country = await lookup('country', country, null)
          let region = c.region.trim()
          if (region) region = await lookup('region', region, country)

          const abvNum = c.abv === '' ? null : parseFloat(String(c.abv).replace(',', '.'))
          const row = {
            category_id: c.catId,
            room_id: roomId,
            location_id: locationId,
            brand: c.brand.trim(),
            name: c.name.trim(),
            vintage: c.vintage.trim() || null,
            abv: Number.isNaN(abvNum) ? null : abvNum,
            size_ml: parseInt(c.size, 10),
            country: country || null,
            region: region || null,
            status: c.bstatus,
            quantity: qty,
            fill_percent: c.bstatus === 'open' ? Number(c.fill) : (c.bstatus === 'empty' ? 0 : 100),
            is_collection: false,
            is_sample: false,
            barcode: c.barcode.trim() || null,
            notes: c.notes.trim() || null,
            min_stock: null,
            reorder: false,
            last_price: null,
          }
          const { data, error: e1 } = await supabase.from('bottles').insert(row).select('id').single()
          if (e1) throw e1
          await supabase.from('movements').insert({ bottle_id: data.id, type: 'adjustment', quantity: qty, notes: 'Erfassung' })
          if (c.bstatus === 'closed') await clearReorderFor(bottles, row)
          created++
          pieces += qty
          try { await uploadImages(data.id, c.members[0].blobs, false) } catch (e) { imageFails.push(`${row.brand} ${row.name}: ${e.message}`) }
        } catch (e) {
          fails.push(`${c.brand || '?'} ${c.name || '?'}: ${e.message}`)
          remaining.push(c.cid)
        }
      }

      await reload()
      if (fails.length === 0) {
        await idbDel(storeKey)
        items.forEach(i => Object.values(i.urls || {}).forEach(u => URL.revokeObjectURL(u)))
        setResult({ created, added, pieces, imageFails })
        setStage('done')
      } else {
        setCards(list => list.filter(c => remaining.includes(c.cid) || !c.include))
        setError(`${fails.length} Flasche${fails.length > 1 ? 'n' : ''} konnten nicht angelegt werden und stehen noch in der Liste:\n${fails.join('\n')}${created + added > 0 ? `\n(${created + added} wurden angelegt.)` : ''}`)
      }
    } catch (e) {
      setError('Fehler beim Anlegen: ' + e.message)
    }
    setBusy(false)
  }

  async function discardAll() {
    if (!window.confirm('Alle Fotos dieser Erfassung verwerfen?')) return
    await idbDel(storeKey)
    items.forEach(i => Object.values(i.urls || {}).forEach(u => URL.revokeObjectURL(u)))
    clearDraft()
    startedRef.current = new Set()
    prepRef.current = new Set()
    setItems([])
    setCards([])
    setError('')
    setStage('setup')
  }

  function again() {
    startedRef.current = new Set()
    prepRef.current = new Set()
    setItems([])
    setCards([])
    setResult(null)
    setError('')
    setStage('setup')
  }

  const place = useMemo(() => {
    const r = preset.roomId === '__new' ? preset.newRoom : rooms.find(x => x.id === preset.roomId)?.name
    const l = preset.locId === '__new' ? preset.newLoc : locations.find(x => x.id === preset.locId)?.name
    return [r, l].filter(Boolean).join(' › ')
  }, [preset, rooms, locations])

  /* ---------- Ansichten ---------- */

  if (stage === 'done') {
    return (
      <div className="panel">
        <h3>Fertig</h3>
        <div className="msg ok">
          {result.created + result.added} Eintr{result.created + result.added === 1 ? 'ag' : 'äge'} verbucht, zusammen {result.pieces} Flasche{result.pieces === 1 ? '' : 'n'}
          {result.added > 0 ? ` (davon ${result.added}× zu vorhandenen Einträgen addiert)` : ''}.
        </div>
        {result.imageFails.length > 0 && <div className="msg error">Bilder, die nicht hochgeladen werden konnten:<br />{result.imageFails.join('\n')}</div>}
        <button className="save-btn" onClick={again}>Nächste Schnellerfassung</button>
        <button className="ghost-btn" onClick={onDone}>Zur Übersicht</button>
      </div>
    )
  }

  if (stage === 'review') {
    return (
      <div className="form">
        <h3 className="sec">Flaschen prüfen</h3>
        <div className="hint">Ziel: <b>{place}</b> · {preset.status === 'open' ? `offen, Füllstand ${preset.fill} %` : 'geschlossen'}. Gelb markierte Angaben sind KI-Vorschläge aus Fachwissen, rot umrandete Felder fehlen noch.</div>
        <div className="count">{includedCards.length} von {cards.length} Karten ausgewählt · {includedCards.reduce((s, c) => s + (parseInt(c.qty, 10) || 1), 0)} Flaschen</div>

        {cards.map(c => {
          const need = missing(c)
          const m = findMatch(c, bottles)
          const mains = cats.filter(x => !x.parent_id)
          return (
            <div key={c.cid} className={'deliv-item' + (c.include ? '' : ' off')}>
              <label className="check">
                <input type="checkbox" checked={c.include} onChange={e => setCard(c.cid, { include: e.target.checked })} />
                <span className="orig">{c.brand || c.name ? `${c.brand} ${c.name}` : 'Nicht erkannt'}{c.members.length > 1 ? ` · ${c.members.length} Flaschen zusammengefasst` : ''}</span>
              </label>
              {c.include && (
                <>
                  <div className={'q-photos' + (c.big ? ' big' : '')} onClick={() => setCard(c.cid, { big: !c.big })}>
                    {['front', 'back', 'side'].filter(s => c.members[0].urls?.[s]).map(s => <img key={s} src={c.members[0].urls[s]} alt="" />)}
                  </div>
                  {c.err && <div className="msg error">Die KI-Auswertung ist fehlgeschlagen ({c.err}). Bitte von Hand ausfüllen.</div>}
                  <div className="two">
                    <input className={!c.brand.trim() ? 'need' : ''} placeholder="Marke" value={c.brand} onChange={e => setCard(c.cid, { brand: e.target.value })} />
                    <input className={!c.name.trim() ? 'need' : ''} placeholder="Name" value={c.name} onChange={e => setCard(c.cid, { name: e.target.value })} />
                  </div>
                  <select className={!c.catId ? 'need' : (c.guess.catId ? 'guess' : '')} value={c.catId} onChange={e => setCard(c.cid, { catId: e.target.value })}>
                    <option value="">– Kategorie wählen –</option>
                    {mains.map(mn => (
                      <optgroup key={mn.id} label={mn.name}>
                        <option value={mn.id}>{mn.name} (allgemein)</option>
                        {cats.filter(x => x.parent_id === mn.id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <div className="four">
                    <label className="fld"><span>Menge</span><input type="number" min="1" value={c.qty} onChange={e => setCard(c.cid, { qty: e.target.value })} /></label>
                    <label className="fld"><span>ml</span><input className={!(parseInt(c.size, 10) > 0) ? 'need' : ''} inputMode="numeric" value={c.size} onChange={e => setCard(c.cid, { size: e.target.value })} /></label>
                    <label className="fld"><span>% vol</span><input inputMode="decimal" value={c.abv} onChange={e => setCard(c.cid, { abv: e.target.value })} /></label>
                    <label className="fld"><span>Jahrgang</span><input value={c.vintage} onChange={e => setCard(c.cid, { vintage: e.target.value })} /></label>
                  </div>
                  <div className="two">
                    <label className={'fld' + (c.guess.country ? ' guess' : '')}><span>Land</span><input value={c.country} onChange={e => setCard(c.cid, { country: e.target.value })} /></label>
                    <label className={'fld' + (c.guess.region ? ' guess' : '')}><span>Region / Stil</span><input value={c.region} onChange={e => setCard(c.cid, { region: e.target.value })} /></label>
                  </div>
                  <div className="two">
                    <label className="fld"><span>Status</span>
                      <select value={c.bstatus} onChange={e => setCard(c.cid, { bstatus: e.target.value, ...(e.target.value !== 'closed' && c.mode === 'add' ? { mode: 'new' } : {}) })}>
                        {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </label>
                    {c.bstatus === 'open'
                      ? <label className="fld"><span>Füllstand</span>
                        <select value={c.fill} onChange={e => setCard(c.cid, { fill: Number(e.target.value) })}>
                          {[...new Set([...FILLS, Number(c.fill)])].sort((a, b) => b - a).map(v => <option key={v} value={v}>{v} %</option>)}
                        </select>
                      </label>
                      : <label className="fld"><span>Barcode</span><input inputMode="numeric" value={c.barcode} onChange={e => setCard(c.cid, { barcode: e.target.value })} /></label>}
                  </div>
                  {c.bstatus === 'open' && <label className="fld"><span>Barcode</span><input inputMode="numeric" value={c.barcode} onChange={e => setCard(c.cid, { barcode: e.target.value })} /></label>}

                  {m && (
                    <>
                      <div className="hint">Schon im Bestand: {m.brand} {m.name} {m.size_ml} ml · ×{m.quantity} ({STATUS[m.status].toLowerCase()})</div>
                      {m.status === 'closed' && c.bstatus === 'closed' && (
                        <select value={c.mode} onChange={e => setCard(c.cid, { mode: e.target.value })}>
                          <option value="new">Als neuen Eintrag anlegen</option>
                          <option value="add">Zum vorhandenen Eintrag addieren</option>
                        </select>
                      )}
                    </>
                  )}
                  {need.length > 0 && <div className="hint need-t">Es fehlt noch: {need.join(', ')}</div>}
                  {c.members.length > 1 && <button type="button" className="link-danger q-split" onClick={() => split(c.cid)}>Wieder in {c.members.length} einzelne Flaschen aufteilen</button>}
                </>
              )}
            </div>
          )
        })}

        {error && <div className="msg error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
        <button className="save-btn" onClick={saveAll} disabled={busy}>{busy ? 'Legt an…' : `${includedCards.length} Karte${includedCards.length === 1 ? '' : 'n'} anlegen`}</button>
        <button className="ghost-btn" onClick={() => { setError(''); setStage('capture') }} disabled={busy}>Zurück zum Fotografieren</button>
        <button className="ghost-btn" onClick={discardAll} disabled={busy}>Alles verwerfen</button>
      </div>
    )
  }

  if (stage === 'wait') {
    const open = items.filter(i => i.state === 'queued' || i.state === 'working').length
    return (
      <div className="panel">
        <h3>Auswertung läuft</h3>
        <p className="hint">Noch {open} von {items.length} Flaschen werden gelesen. Der Bildschirm bleibt an, die Prüfung öffnet sich von selbst.</p>
        <div className="q-bar"><div style={{ width: `${items.length ? ((items.length - open) / items.length) * 100 : 0}%` }} /></div>
      </div>
    )
  }

  if (stage === 'capture') {
    return (
      <div className="panel">
        <h3>Flasche {items.length + 1}</h3>
        <div className="hint">Ziel: <b>{place}</b> · {preset.status === 'open' ? `offen, ${preset.fill} %` : 'geschlossen'}. Vorder- und Rückseite sind Pflicht, die Seite ist optional. Beim Barcode auf Schärfe achten.</div>

        <div className="q-slots">
          {SLOT_LIST.map(([slot, label, req]) => (
            <div key={slot} className="q-slot">
              <button type="button" className={'q-shot' + (draftUrls[slot] ? ' has' : '')} onClick={() => inputs.current[slot]?.click()} disabled={busy}>
                {draftUrls[slot] ? <img src={draftUrls[slot]} alt="" /> : <span>{label}{req ? '' : ' (optional)'}</span>}
              </button>
              {draftUrls[slot] && <small>{label}</small>}
              <input ref={el => { inputs.current[slot] = el }} type="file" accept="image/*" capture="environment" hidden
                onChange={e => { pick(slot, e.target.files?.[0]); e.target.value = '' }} />
            </div>
          ))}
        </div>

        {error && <div className="msg error">{error}</div>}
        {preset.status === 'closed' && (
          <div className="q-qty">
            <span>Anzahl dieser Flasche</span>
            <button type="button" aria-label="Anzahl verringern" onClick={() => setDraftQty(n => Math.max(1, n - 1))} disabled={draftQty <= 1}>−</button>
            <b>{draftQty}</b>
            <button type="button" aria-label="Anzahl erhöhen" onClick={() => setDraftQty(n => Math.min(99, n + 1))}>+</button>
          </div>
        )}
        <button className="save-btn" onClick={commitDraft} disabled={!draftReady || busy}>Speichern & nächste Flasche</button>
        <button className="ai-btn" onClick={finishCapture} disabled={busy || (draftAny && !draftReady) || (!draftAny && items.length === 0)}>
          {draftReady ? 'Diese Flasche speichern & fertig' : `Fertig – ${items.length} Flasche${items.length === 1 ? '' : 'n'} prüfen`}
        </button>
        {draftAny && !draftReady && <div className="hint">Für diese Flasche fehlt noch ein Pflichtfoto.</div>}
        {draftAny && <button className="link-danger" onClick={clearDraft}>Fotos dieser Flasche verwerfen</button>}

        {items.length > 0 && (
          <div className="file-list">
            <div className="count">Schon fotografiert</div>
            {items.map((it, i) => (
              <div key={it.id} className="file-item">
                <img src={it.urls.front} alt="" />
                <span>
                  Flasche {i + 1}{(it.qty || 1) > 1 ? ` (×${it.qty})` : ''}: {it.state === 'done' ? (it.ai?.brand || it.ai?.name ? `${it.ai.brand || ''} ${it.ai.name || ''}`.trim() : 'erkannt') : it.state === 'error' ? (it.err || 'Fehler') : it.state === 'preparing' ? 'wird vorbereitet…' : it.state === 'working' ? 'wird gelesen…' : 'wartet…'}
                </span>
                {it.state === 'error' && <button className="link-danger" onClick={() => retry(it.id)}>Nochmal</button>}
                <button className="link-danger" onClick={() => removeItem(it.id)}>Entfernen</button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Einrichtung
  return (
    <div className="panel">
      <h3>Foto-Schnellerfassung</h3>
      <p className="hint">Raum, Ort und Status einmal vorgeben, dann pro Flasche Front und Rück fotografieren. Die KI liest die Etiketten im Hintergrund, am Ende prüfst du alles in einer Liste.</p>

      {saved && (
        <div className="series-box q-resume">
          <span>Angefangene Erfassung mit <b>{saved.items.length}</b> Flasche{saved.items.length === 1 ? '' : 'n'} gefunden.</span>
          <button type="button" onClick={resume}>Fortsetzen</button>
          <button type="button" onClick={discardSaved}>Verwerfen</button>
        </div>
      )}

      <div className="two">
        <label className="fld"><span>Raum</span>
          <select value={preset.roomId} onChange={e => setPreset({ ...preset, roomId: e.target.value, locId: '' })}>
            <option value="">– wählen –</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            <option value="__new">+ Neuer Raum…</option>
          </select>
        </label>
        <label className="fld"><span>Ort</span>
          <select value={preset.locId} onChange={e => setPreset({ ...preset, locId: e.target.value })} disabled={!preset.roomId}>
            <option value="">– kein Ort –</option>
            {roomLocs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            {preset.roomId && <option value="__new">+ Neuer Ort…</option>}
          </select>
        </label>
      </div>
      {preset.roomId === '__new' && <input placeholder="Name des neuen Raums" value={preset.newRoom} onChange={e => setPreset({ ...preset, newRoom: e.target.value })} />}
      {preset.locId === '__new' && <input placeholder="Name des neuen Ortes, z. B. Karton 3" value={preset.newLoc} onChange={e => setPreset({ ...preset, newLoc: e.target.value })} />}

      <div className="two">
        <label className="fld"><span>Status</span>
          <select value={preset.status} onChange={e => setPreset({ ...preset, status: e.target.value })}>
            <option value="closed">Geschlossen</option>
            <option value="open">Offen</option>
          </select>
        </label>
        {preset.status === 'open' && (
          <label className="fld"><span>Füllstand</span>
            <select value={preset.fill} onChange={e => setPreset({ ...preset, fill: Number(e.target.value) })}>
              {FILLS.map(v => <option key={v} value={v}>{v} %</option>)}
            </select>
          </label>
        )}
      </div>
      {preset.status === 'open' && <div className="hint">Der Füllstand gilt für alle Flaschen dieser Runde, in der Prüfliste kannst du ihn pro Flasche ändern.</div>}

      {error && <div className="msg error">{error}</div>}
      <button className="scan-btn" onClick={startCapture}>Los geht’s – Fotos aufnehmen</button>
    </div>
  )
}
