import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabase'
import {
  SIZES, STATUS, BUCKET, lsGet, lsSet, abvLabel,
  digitsOnly, codeVariants, codeWarning, lookupBarcode, resizeImage, blobToBase64,
} from './utils'
import './App.css'

/* ---------- Logos ---------- */

const BackbarLogo = () => (
  <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
    <rect x="4" y="29" width="28" height="3" rx="1" fill="#c8891a"/>
    <rect x="4" y="25" width="28" height="1" fill="#c8891a" opacity="0.3"/>
    <rect x="6" y="11" width="4" height="14" rx="1" fill="#c8891a"/>
    <rect x="7" y="8" width="2" height="3" rx="1" fill="#c8891a"/>
    <rect x="12" y="9" width="5" height="16" rx="1" fill="#c8891a"/>
    <rect x="13" y="6" width="3" height="3" rx="1" fill="#c8891a"/>
    <rect x="19" y="12" width="4" height="13" rx="1" fill="#c8891a"/>
    <rect x="20" y="9" width="2" height="3" rx="1" fill="#c8891a"/>
    <rect x="25" y="14" width="4" height="11" rx="1" fill="#c8891a" opacity="0.7"/>
    <rect x="26" y="11" width="2" height="3" rx="1" fill="#c8891a" opacity="0.7"/>
  </svg>
)

const BottleIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
    <rect x="8" y="2" width="6" height="2" rx="1" fill="#c8891a"/>
    <rect x="9" y="4" width="4" height="2" rx="0.5" fill="#c8891a" opacity="0.6"/>
    <path d="M7 6C7 6 5 9 5 14a6 6 0 0012 0c0-5-2-8-2-8H7z" fill="#c8891a" opacity="0.2" stroke="#c8891a" strokeWidth="1.2"/>
    <line x1="5.5" y1="12" x2="16.5" y2="12" stroke="#c8891a" strokeWidth="0.8" opacity="0.5"/>
  </svg>
)

function Shell({ children, onLogout }) {
  return (
    <div className="app">
      <header>
        <div className="logo">
          <div className="logo-icon"><BackbarLogo /></div>
          <div className="logo-text">
            <h1>BoozeYard</h1>
            <p>Spirits Inventory</p>
          </div>
        </div>
        {onLogout && <button className="link-btn" onClick={onLogout}>Abmelden</button>}
      </header>
      {children}
    </div>
  )
}

/* ---------- Root: Login-Weiche ---------- */

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return <Shell><main><div className="empty">Lädt…</div></main></Shell>
  }
  if (!session) {
    return <Shell><main><Login /></main></Shell>
  }
  return <Main userId={session.user.id} onLogout={() => supabase.auth.signOut()} />
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError('Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.')
    setBusy(false)
  }

  return (
    <form className="form" onSubmit={submit}>
      <input type="email" placeholder="E-Mail" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
      <input type="password" placeholder="Passwort" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
      {error && <div className="msg error">{error}</div>}
      <button className="save-btn" disabled={busy}>{busy ? 'Anmelden…' : 'Anmelden'}</button>
    </form>
  )
}

/* ---------- Hauptansicht ---------- */

function Main({ userId, onLogout }) {
  const [tab, setTab] = useState('bottles')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bottles, setBottles] = useState([])
  const [rooms, setRooms] = useState([])
  const [locations, setLocations] = useState([])
  const [cats, setCats] = useState([])
  const [lookups, setLookups] = useState([])
  const [thumbs, setThumbs] = useState({})
  const [prefill, setPrefill] = useState({ key: 0, data: null })
  const [editId, setEditId] = useState(null)

  async function loadThumbs(rows) {
    const paths = rows.map(b => b.image_thumb).filter(Boolean)
    if (paths.length === 0) { setThumbs({}); return }
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    const map = {}
    ;(data || []).forEach(x => { if (x.signedUrl) map[x.path] = x.signedUrl })
    setThumbs(map)
  }

  async function loadAll() {
    const [b, r, l, c, lv] = await Promise.all([
      supabase.from('bottles').select('*').order('brand').order('name'),
      supabase.from('rooms').select('*').order('sort_order').order('name'),
      supabase.from('locations').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('lookup_values').select('*').order('name'),
    ])
    const err = b.error || r.error || l.error || c.error
    if (err) {
      setError('Daten konnten nicht geladen werden: ' + err.message)
    } else {
      setError(lv.error ? 'Hinweis: Picklisten fehlen noch (Datenbank-Update 03 ausführen).' : '')
      setBottles(b.data)
      setRooms(r.data)
      setLocations(l.data)
      setCats(c.data)
      setLookups(lv.data || [])
      loadThumbs(b.data)
    }
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  // Barcode erkannt: erst im eigenen Bestand suchen, dann in Open Food Facts
  async function handleCode(raw) {
    const code = digitsOnly(raw)
    if (!code) return
    const variants = codeVariants(code)
    const warn = codeWarning(code)
    const own = bottles.filter(b => b.barcode && variants.includes(digitsOnly(b.barcode)))
    let data
    if (own.length > 0) {
      const b = own[0]
      const total = own.filter(x => x.status !== 'empty').reduce((s, x) => s + x.quantity, 0)
      data = {
        barcode: code, brand: b.brand, name: b.name, category_id: b.category_id, abv: b.abv,
        size_ml: b.size_ml, country: b.country, region: b.region, vintage: b.vintage,
        is_collection: b.is_collection, min_stock: b.min_stock,
        note: `Schon im Bestand (${total}×) – Daten übernommen. Bitte Anzahl und Ort prüfen.`,
      }
    } else {
      const mains = cats.filter(c => !c.parent_id)
      const found = await lookupBarcode(variants, mains)
      if (found && found.got.length > 0) {
        data = { barcode: code, ...found, note: `Aus Open Food Facts übernommen: ${found.got.join(', ')}. Bitte prüfen und ergänzen.` }
      } else {
        data = { barcode: code, note: 'Barcode übernommen – keine Produktdaten gefunden. Bitte von Hand ausfüllen.' }
      }
    }
    if (warn) data.note = `${data.note} ${warn}`
    setPrefill(p => ({ key: p.key + 1, data }))
    setEditId(null)
    setTab('add')
  }

  // Etikett-Foto aus dem Scanner-Tab: direkt KI, dann Formular vorbefüllt
  async function handleLabel(file) {
    try {
      const r = await runAnalyze([file], cats, lookups)
      const { data, filled } = aiToPrefill(r, cats, lookups)
      data.frontFile = file
      data.note = filled.length > 0
        ? `Aus dem Etikett-Foto übernommen: ${filled.join(', ')}. Bitte alles prüfen und Anzahl und Ort ergänzen.`
        : 'Auf dem Foto konnte nichts sicher erkannt werden. Bitte von Hand ausfüllen.'
      setPrefill(p => ({ key: p.key + 1, data }))
      setEditId(null)
      setTab('add')
      return ''
    } catch (e) {
      return 'Auswertung fehlgeschlagen: ' + e.message
    }
  }

  const tabs = [
    ['bottles', 'Bestand'],
    ['rooms', 'Lagerorte'],
    ['scanner', 'Scanner'],
    ['add', '+ Neu'],
  ]
  const editing = editId ? bottles.find(b => b.id === editId) : null

  return (
    <Shell onLogout={onLogout}>
      <nav>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setEditId(null) }} className={tab === id ? 'active' : ''}>{label}</button>
        ))}
      </nav>
      <main>
        {error && <div className="msg error">{error}</div>}
        {loading && <div className="empty">Lädt…</div>}
        {!loading && tab === 'bottles' && !editing && (
          <BottleList bottles={bottles} cats={cats} rooms={rooms} locations={locations} thumbs={thumbs}
            reload={loadAll} onEdit={id => setEditId(id)} />
        )}
        {!loading && tab === 'bottles' && editing && (
          <BottleForm key={editing.id} userId={userId} bottle={editing} cats={cats} rooms={rooms}
            locations={locations} lookups={lookups} reload={loadAll} onDone={() => setEditId(null)} />
        )}
        {!loading && tab === 'rooms' && (
          <Rooms bottles={bottles} rooms={rooms} locations={locations} reload={loadAll} />
        )}
        {tab === 'scanner' && <Scanner onCode={handleCode} onLabel={handleLabel} />}
        {!loading && tab === 'add' && (
          <BottleForm key={prefill.key} userId={userId} prefill={prefill.data} cats={cats} rooms={rooms}
            locations={locations} lookups={lookups} reload={loadAll} />
        )}
      </main>
    </Shell>
  )
}

/* ---------- Bestandsliste mit Suche und Filtern ---------- */

function BottleList({ bottles, cats, rooms, locations, thumbs, reload, onEdit }) {
  const [q, setQ] = useState('')
  const [catId, setCatId] = useState('')
  const [status, setStatus] = useState('')
  const [roomId, setRoomId] = useState('')
  const [locId, setLocId] = useState('')
  const [msg, setMsg] = useState('')
  const [delId, setDelId] = useState(null)

  const catById = useMemo(() => Object.fromEntries(cats.map(c => [c.id, c])), [cats])
  const roomById = useMemo(() => Object.fromEntries(rooms.map(r => [r.id, r])), [rooms])
  const locById = useMemo(() => Object.fromEntries(locations.map(l => [l.id, l])), [locations])
  const mains = cats.filter(c => !c.parent_id)

  function mainOf(b) {
    const c = catById[b.category_id]
    if (!c) return null
    return c.parent_id ? catById[c.parent_id] : c
  }

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return bottles.filter(b => {
      const sub = catById[b.category_id]
      const main = mainOf(b)
      if (catId && main?.id !== catId) return false
      if (status && b.status !== status) return false
      if (roomId && b.room_id !== roomId) return false
      if (locId && b.location_id !== locId) return false
      if (terms.length) {
        const hay = [b.brand, b.name, b.vintage, b.country, b.region, b.notes, b.barcode,
          sub?.name, main?.name, roomById[b.room_id]?.name, locById[b.location_id]?.name]
          .filter(Boolean).join(' ').toLowerCase()
        if (!terms.every(t => hay.includes(t))) return false
      }
      return true
    })
  }, [bottles, q, catId, status, roomId, locId, catById, roomById, locById])

  const total = filtered.reduce((s, b) => s + (b.status === 'empty' ? 0 : b.quantity), 0)
  const roomLocs = locations.filter(l => l.room_id === roomId)

  function fail(error) {
    setMsg('Fehler: ' + error.message)
  }

  async function openOne(b) {
    setMsg('')
    if (b.quantity > 1) {
      const { error: e1 } = await supabase.from('bottles').update({ quantity: b.quantity - 1 }).eq('id', b.id)
      if (e1) return fail(e1)
      const { id, created_at, updated_at, user_id, captured_at, image_front, image_back, image_side, image_thumb, ...copy } = b
      const { error: e2 } = await supabase.from('bottles').insert({ ...copy, status: 'open', quantity: 1, fill_percent: 100 })
      if (e2) return fail(e2)
    } else {
      const { error: e1 } = await supabase.from('bottles').update({ status: 'open', fill_percent: 100 }).eq('id', b.id)
      if (e1) return fail(e1)
    }
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'opened', quantity: -1 })
    reload()
  }

  // Öffnen rückgängig: zurück in den Stapel, falls es dort noch gleiche geschlossene Flaschen gibt
  async function undoOpen(b) {
    setMsg('')
    const same = x => x.id !== b.id && x.status === 'closed' && x.brand === b.brand && x.name === b.name &&
      x.size_ml === b.size_ml && x.category_id === b.category_id && x.room_id === b.room_id &&
      x.location_id === b.location_id && (x.vintage || '') === (b.vintage || '') &&
      (x.abv ?? null) === (b.abv ?? null)
    const sib = b.quantity === 1 ? bottles.find(same) : null
    let targetId = b.id
    if (sib) {
      const { error: e1 } = await supabase.from('bottles').update({ quantity: sib.quantity + 1 }).eq('id', sib.id)
      if (e1) return fail(e1)
      const { error: e2 } = await supabase.from('bottles').delete().eq('id', b.id)
      if (e2) return fail(e2)
      targetId = sib.id
    } else {
      const { error } = await supabase.from('bottles').update({ status: 'closed', fill_percent: 100 }).eq('id', b.id)
      if (error) return fail(error)
    }
    await supabase.from('movements').insert({ bottle_id: targetId, type: 'adjustment', quantity: 1, notes: 'Öffnen rückgängig' })
    reload()
  }

  async function markEmpty(b) {
    setMsg('')
    const { error } = await supabase.from('bottles').update({ status: 'empty', fill_percent: 0 }).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'empty', quantity: -1 })
    reload()
  }

  // Leer rückgängig: Flasche war fast leer, daher zurück auf "offen" mit 10 %
  async function undoEmpty(b) {
    setMsg('')
    const { error } = await supabase.from('bottles').update({ status: 'open', fill_percent: 10 }).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'adjustment', quantity: 1, notes: 'Leer rückgängig' })
    reload()
  }

  // Ganzen Eintrag löschen (mit Bildern)
  async function deleteEntry(b) {
    setMsg('')
    const paths = [b.image_front, b.image_back, b.image_side, b.image_thumb].filter(Boolean)
    if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths)
    const { error } = await supabase.from('bottles').delete().eq('id', b.id)
    if (error) return fail(error)
    setDelId(null)
    reload()
  }

  // Nur eine Flasche aus einem Stapel (×N) entfernen
  async function deleteOne(b) {
    setMsg('')
    const { error } = await supabase.from('bottles').update({ quantity: b.quantity - 1 }).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'adjustment', quantity: -1, notes: 'Gelöscht (1 Flasche)' })
    setDelId(null)
    reload()
  }

  async function setFill(b, value) {
    const { error } = await supabase.from('bottles').update({ fill_percent: Number(value) }).eq('id', b.id)
    if (error) return fail(error)
    reload()
  }

  return (
    <>
      <div className="filters">
        <input className="search" type="search" placeholder="Suchen: Marke, Name, Herkunft, Notiz…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="filter-row">
          <select value={catId} onChange={e => setCatId(e.target.value)}>
            <option value="">Alle Kategorien</option>
            {mains.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Alle Status</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="filter-row">
          <select value={roomId} onChange={e => { setRoomId(e.target.value); setLocId('') }}>
            <option value="">Alle Räume</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={locId} onChange={e => setLocId(e.target.value)} disabled={!roomId || roomLocs.length === 0}>
            <option value="">Alle Orte</option>
            {roomLocs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="count">{filtered.length} Einträge · {total} Flaschen</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {filtered.length === 0 && (
        <div className="empty">{bottles.length === 0 ? 'Noch keine Flaschen eingetragen.' : 'Keine Treffer für diese Filter.'}</div>
      )}

      {filtered.map(b => {
        const sub = catById[b.category_id]
        const main = mainOf(b)
        const label = abvLabel(b.abv)
        const place = [roomById[b.room_id]?.name, locById[b.location_id]?.name].filter(Boolean).join(' › ')
        const thumb = b.image_thumb ? thumbs[b.image_thumb] : null
        return (
          <div key={b.id} className={'card' + (b.status === 'empty' ? ' dim' : '')}>
            <div className={'card-icon' + (thumb ? ' has-thumb' : '')}>
              {thumb ? <img className="thumb" src={thumb} alt="" loading="lazy" /> : <BottleIcon />}
            </div>
            <div className="card-info">
              <h3>{b.brand} {b.name}{b.vintage ? ` (${b.vintage})` : ''}</h3>
              <p>
                {[main?.name, sub && sub.id !== main?.id ? sub.name : null].filter(Boolean).join(' · ')}
                {b.abv !== null ? ` · ${b.abv} %` : ''}{` · ${b.size_ml} ml`}
              </p>
              {b.status === 'open' && (
                <div className="fill-row">
                  <div className="fill-bar"><div className="fill-bar-inner" style={{ width: `${b.fill_percent}%` }} /></div>
                  <select className="fill-select" value={b.fill_percent} onChange={e => setFill(b, e.target.value)}>
                    {[...new Set([100, 90, 75, 50, 25, 10, b.fill_percent])].sort((x, y) => y - x).map(v => <option key={v} value={v}>{v} %</option>)}
                  </select>
                </div>
              )}
              <span className="badge">
                {STATUS[b.status]}{b.quantity > 1 ? ` · ×${b.quantity}` : ''}{place ? ` · ${place}` : ''}
              </span>
              <div className="tags">
                {label && label !== 'Standard' && <span className="tag">{label}</span>}
                {b.is_collection && <span className="tag">Sammlung</span>}
                {b.is_sample && <span className="tag">Sample</span>}
                {b.min_stock !== null && b.status === 'closed' && b.quantity < b.min_stock && <span className="tag warn">Nachkaufen</span>}
              </div>
              {delId !== b.id && (
                <div className="actions">
                  {b.status === 'closed' && <button onClick={() => openOne(b)}>Öffnen</button>}
                  {b.status === 'open' && <button onClick={() => markEmpty(b)}>Leer</button>}
                  {b.status === 'open' && <button className="ghost" onClick={() => undoOpen(b)}>Rückgängig</button>}
                  {b.status === 'empty' && <button className="ghost" onClick={() => undoEmpty(b)}>Rückgängig</button>}
                  <button className="ghost" onClick={() => onEdit(b.id)}>Bearbeiten</button>
                  <button className="ghost del" onClick={() => setDelId(b.id)}>Löschen</button>
                </div>
              )}
              {delId === b.id && (
                <div className="del-confirm">
                  <p>{b.quantity > 1 ? `Dieser Eintrag hat ${b.quantity} Flaschen. Was soll gelöscht werden?` : 'Wirklich löschen? Die Flasche und ihre Bilder werden endgültig entfernt.'}</p>
                  <div className="actions">
                    {b.quantity > 1 && <button className="danger" onClick={() => deleteOne(b)}>1 Flasche</button>}
                    <button className="danger" onClick={() => deleteEntry(b)}>{b.quantity > 1 ? `Alle ${b.quantity}` : 'Ja, löschen'}</button>
                    <button className="ghost" onClick={() => setDelId(null)}>Abbrechen</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

/* ---------- Lagerorte ---------- */

function Rooms({ bottles, rooms, locations, reload }) {
  const [newRoom, setNewRoom] = useState('')
  const [newLoc, setNewLoc] = useState({})
  const [msg, setMsg] = useState('')

  function count(filterFn) {
    return bottles.filter(b => b.status !== 'empty' && filterFn(b)).reduce((s, b) => s + b.quantity, 0)
  }

  async function addRoom() {
    const name = newRoom.trim()
    if (!name) return
    const { error } = await supabase.from('rooms').insert({ name })
    if (error) return setMsg('Fehler: ' + error.message)
    setNewRoom('')
    setMsg('')
    reload()
  }

  async function addLocation(roomId) {
    const name = (newLoc[roomId] || '').trim()
    if (!name) return
    const { error } = await supabase.from('locations').insert({ room_id: roomId, name })
    if (error) return setMsg('Fehler: ' + error.message)
    setNewLoc({ ...newLoc, [roomId]: '' })
    setMsg('')
    reload()
  }

  return (
    <>
      {msg && <div className="msg error">{msg}</div>}
      {rooms.length === 0 && <div className="empty">Noch keine Lagerorte angelegt.</div>}
      {rooms.map(r => {
        const locs = locations.filter(l => l.room_id === r.id)
        return (
          <div key={r.id} className="card column">
            <div className="room-head">
              <h3>{r.name}</h3>
              <span className="badge">{count(b => b.room_id === r.id)} Flaschen</span>
            </div>
            <div className="chips">
              {locs.length === 0 && <span className="muted">Keine Unterorte</span>}
              {locs.map(l => (
                <span key={l.id} className="chip">{l.name} · {count(b => b.location_id === l.id)}</span>
              ))}
            </div>
            <div className="inline-add">
              <input placeholder="Neuer Ort, z. B. Kiste 4" value={newLoc[r.id] || ''} onChange={e => setNewLoc({ ...newLoc, [r.id]: e.target.value })} />
              <button onClick={() => addLocation(r.id)}>Hinzufügen</button>
            </div>
          </div>
        )
      })}
      <div className="card column">
        <div className="inline-add">
          <input placeholder="Neuer Raum" value={newRoom} onChange={e => setNewRoom(e.target.value)} />
          <button onClick={addRoom}>Anlegen</button>
        </div>
      </div>
    </>
  )
}

/* ---------- Scanner ---------- */

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']

async function createDetector(preferWasm) {
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

function Scanner({ onCode, onLabel }) {
  const videoRef = useRef(null)
  const labelCamRef = useRef(null)
  const labelGalRef = useRef(null)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const activeRef = useRef(false)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [info, setInfo] = useState('')
  const [torchOk, setTorchOk] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [devices, setDevices] = useState([])
  const [devIdx, setDevIdx] = useState(0)
  const [compat, setCompat] = useState(false)
  const [busy, setBusy] = useState(false)

  function stop() {
    activeRef.current = false
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    trackRef.current = null
    setScanning(false)
    setTorchOn(false)
  }

  useEffect(() => () => stop(), [])

  async function handle(code) {
    setBusy(true)
    setInfo(`Code ${code} erkannt – suche Produktdaten…`)
    await onCode(code)
    setBusy(false)
  }

  // Etikett fotografieren: Foto direkt an die KI, danach Formular
  async function labelPhoto(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    stop()
    setBusy(true)
    setInfo('Etikett wird ausgewertet… das dauert einige Sekunden.')
    const err = await onLabel(file)
    if (err) setInfo(err)
    setBusy(false)
  }

  async function start(deviceId, forceWasm) {
    setInfo('')
    stop()
    try {
      const video = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video })
      streamRef.current = stream
      activeRef.current = true
      const track = stream.getVideoTracks()[0]
      trackRef.current = track

      let caps = {}
      try { caps = track.getCapabilities ? track.getCapabilities() : {} } catch { /* ignorieren */ }
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }) } catch { /* ignorieren */ }
      }
      setTorchOk(!!caps.torch)

      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        setDevices(all.filter(d => d.kind === 'videoinput'))
      } catch { /* ignorieren */ }

      setScanning(true)
      const v = videoRef.current
      v.srcObject = stream
      await v.play()

      let { detector, wasm } = await createDetector(forceWasm ?? compat)
      if (wasm) setInfo('Kompatibler Scanner aktiv (lädt beim ersten Mal etwas länger).')
      let errors = 0

      const tick = async () => {
        if (!activeRef.current) return
        try {
          const found = await detector.detect(v)
          errors = 0
          if (found.length > 0) {
            const code = found[0].rawValue
            stop()
            handle(code)
            return
          }
        } catch {
          errors += 1
          if (errors >= 3 && !wasm) {
            try {
              const next = await createDetector(true)
              detector = next.detector
              wasm = true
              setInfo('Der Standard-Scanner funktioniert auf diesem Gerät nicht – kompatibler Scanner aktiv.')
            } catch { /* weiter versuchen */ }
          }
        }
        setTimeout(tick, wasm ? 200 : 120)
      }
      tick()
    } catch {
      stop()
      setInfo('Kamera konnte nicht gestartet werden. Bitte Zugriff erlauben oder den Code unten eintippen.')
    }
  }

  async function tapFocus() {
    const t = trackRef.current
    if (!t) return
    try {
      await t.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] })
      setTimeout(() => { t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}) }, 1500)
    } catch { /* nicht unterstützt */ }
  }

  async function toggleTorch() {
    const t = trackRef.current
    if (!t) return
    try {
      await t.applyConstraints({ advanced: [{ torch: !torchOn }] })
      setTorchOn(!torchOn)
    } catch { setInfo('Die Taschenlampe lässt sich auf diesem Gerät nicht schalten.') }
  }

  function nextCamera() {
    if (devices.length < 2) return
    const idx = (devIdx + 1) % devices.length
    setDevIdx(idx)
    start(devices[idx].deviceId)
  }

  function toggleCompat() {
    const next = !compat
    setCompat(next)
    if (scanning) start(devices[devIdx]?.deviceId, next)
  }

  return (
    <div className="scanner-box">
      <h3>Barcode Scanner</h3>
      <p>Kamera auf den Barcode der Flasche richten, etwa 20–30 cm Abstand. Zum Scharfstellen auf das Bild tippen. Ohne Barcode: das Etikett fotografieren, die KI liest die Daten ab.</p>
      {!scanning && <button className="scan-btn" onClick={() => start()} disabled={busy}>Kamera starten</button>}
      {!scanning && (
        <>
          <button className="scan-btn secondary label-btn" onClick={() => labelCamRef.current?.click()} disabled={busy}>Etikett fotografieren (KI)</button>
          <button type="button" className="gallery-link" onClick={() => labelGalRef.current?.click()} disabled={busy}>oder Etikett-Foto aus der Galerie wählen</button>
          <input ref={labelCamRef} type="file" accept="image/*" capture="environment" hidden onChange={labelPhoto} />
          <input ref={labelGalRef} type="file" accept="image/*" hidden onChange={labelPhoto} />
        </>
      )}
      <video ref={videoRef} playsInline muted onClick={tapFocus} style={{ display: scanning ? 'block' : 'none' }} />
      {scanning && (
        <div className="scan-tools">
          {torchOk && <button onClick={toggleTorch}>{torchOn ? 'Licht aus' : 'Licht an'}</button>}
          {devices.length > 1 && <button onClick={nextCamera}>Kamera wechseln</button>}
          <button onClick={toggleCompat}>{compat ? 'Standard-Scanner' : 'Kompatibler Scanner'}</button>
          <button onClick={stop}>Abbrechen</button>
        </div>
      )}
      <div className="inline-add manual">
        <input inputMode="numeric" placeholder="Code manuell eingeben (8, 12 oder 13 Ziffern)" value={manual} onChange={e => setManual(e.target.value)} />
        <button disabled={busy} onClick={() => manual.trim() && handle(manual.trim())}>Suchen</button>
      </div>
      {info && <div className="msg">{info}</div>}
    </div>
  )
}

/* ---------- KI-Auswertung (gemeinsam für Formular und Scanner-Tab) ---------- */

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

async function runAnalyze(files, cats, lookups) {
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

// KI-Ergebnis in Vorbelegungs-Daten für das Formular umwandeln
function aiToPrefill(r, cats, lookups) {
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

/* ---------- Formular: Flasche anlegen oder bearbeiten ---------- */

async function ensureRoom(rooms, name) {
  const existing = rooms.find(r => r.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing.id
  const { data, error } = await supabase.from('rooms').insert({ name }).select('id').single()
  if (error) throw error
  return data.id
}

async function ensureLocation(locations, roomId, name) {
  const existing = locations.find(l => l.room_id === roomId && l.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing.id
  const { data, error } = await supabase.from('locations').insert({ room_id: roomId, name }).select('id').single()
  if (error) throw error
  return data.id
}

async function ensureLookup(lookups, kind, name, country) {
  const existing = lookups.find(l => l.kind === kind && l.name.toLowerCase() === name.toLowerCase() &&
    (kind === 'country' || !l.country || l.country === country))
  if (existing) return existing.name
  const { error } = await supabase.from('lookup_values').insert({ kind, name, country: kind === 'region' ? (country || null) : null })
  if (error) throw error
  return name
}

function initialForm(bottle, prefill, cats) {
  const edit = !!bottle
  const src = bottle || prefill || {}
  const catById = Object.fromEntries(cats.map(c => [c.id, c]))
  let mainId = src.mainId || ''
  let subId = ''
  if (src.category_id && catById[src.category_id]) {
    const c = catById[src.category_id]
    if (c.parent_id) { mainId = c.parent_id; subId = c.id } else { mainId = c.id }
  }
  const size = src.size_ml
  return {
    brand: src.brand || '',
    name: src.name || '',
    mainId, subId,
    abv: src.abv === null || src.abv === undefined ? '' : String(src.abv),
    size: size ? (SIZES.includes(size) ? String(size) : 'other') : '700',
    customSize: size && !SIZES.includes(size) ? String(size) : '',
    vintage: src.vintage || '',
    country: src.country || '',
    region: src.region || '',
    newCountry: src.newCountry || '', newRegion: src.newRegion || '',
    status: edit ? bottle.status : 'closed',
    quantity: edit ? bottle.quantity : 1,
    fill_percent: edit ? bottle.fill_percent : 100,
    roomId: edit ? (bottle.room_id || '') : (lsGet('by_room') || ''),
    locId: edit ? (bottle.location_id || '') : (lsGet('by_loc') || ''),
    newRoom: '', newLoc: '',
    is_collection: !!src.is_collection,
    is_sample: edit ? bottle.is_sample : false,
    is_purchase: false,
    min_stock: src.min_stock === null || src.min_stock === undefined ? '' : String(src.min_stock),
    barcode: src.barcode || '',
    notes: edit ? (bottle.notes || '') : (src.noteText || ''),
  }
}

const SLOTS = [['front', 'Vorderseite'], ['back', 'Rückseite'], ['side', 'Seite (Füllstand)']]

function ImageSlot({ label, url, onPick, onRemove }) {
  const camRef = useRef(null)
  const galRef = useRef(null)
  const take = e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }
  return (
    <div className="img-slot">
      <div className="img-box" onClick={() => camRef.current?.click()}>
        {url ? <img src={url} alt={label} /> : <span>+ Foto</span>}
      </div>
      <div className="img-label">{label}</div>
      <div className="img-btns">
        <button type="button" onClick={() => camRef.current?.click()}>Kamera</button>
        <button type="button" className="ghost" onClick={() => galRef.current?.click()}>Galerie</button>
      </div>
      {url && <button type="button" className="link-danger" onClick={onRemove}>Entfernen</button>}
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={take} />
      <input ref={galRef} type="file" accept="image/*" hidden onChange={take} />
    </div>
  )
}

function BottleForm({ userId, bottle, prefill, cats, rooms, locations, lookups, reload, onDone }) {
  const edit = !!bottle
  const mains = cats.filter(c => !c.parent_id)
  const [f, setF] = useState(() => initialForm(bottle, prefill, cats))
  const [msg, setMsg] = useState(prefill?.note || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const fRef = useRef(null)

  // Bilder: pro Platz entweder vorhandener Pfad, neue Datei oder entfernt
  const [imgs, setImgs] = useState(() => ({
    front: { path: bottle?.image_front || null, file: prefill?.frontFile || null, preview: prefill?.frontFile ? URL.createObjectURL(prefill.frontFile) : null, removed: false },
    back: { path: bottle?.image_back || null, file: null, preview: null, removed: false },
    side: { path: bottle?.image_side || null, file: null, preview: null, removed: false },
  }))
  const [signed, setSigned] = useState({})

  useEffect(() => {
    const paths = [bottle?.image_front, bottle?.image_back, bottle?.image_side].filter(Boolean)
    if (paths.length === 0) return
    supabase.storage.from(BUCKET).createSignedUrls(paths, 3600).then(({ data }) => {
      const map = {}
      ;(data || []).forEach(x => { if (x.signedUrl) map[x.path] = x.signedUrl })
      setSigned(map)
    })
  }, [bottle])

  fRef.current = f
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))
  const main = mains.find(c => c.id === f.mainId)
  const subs = cats.filter(c => c.parent_id === f.mainId)
  const roomLocs = locations.filter(l => l.room_id === f.roomId)
  const roomsValid = rooms.some(r => r.id === f.roomId)
  const locValid = locations.some(l => l.id === f.locId && l.room_id === f.roomId)

  const countries = useMemo(() => {
    const names = lookups.filter(l => l.kind === 'country').map(l => l.name)
    if (f.country && !names.includes(f.country)) names.push(f.country)
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'de'))
  }, [lookups, f.country])

  const regions = useMemo(() => {
    const names = lookups
      .filter(l => l.kind === 'region' && (!f.country || !l.country || l.country === f.country))
      .map(l => l.name)
    if (f.region && !names.includes(f.region)) names.push(f.region)
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'de'))
  }, [lookups, f.country, f.region])

  function pickImage(slot, file) {
    setImgs(prev => ({ ...prev, [slot]: { ...prev[slot], file, preview: URL.createObjectURL(file), removed: false } }))
  }
  function removeImage(slot) {
    setImgs(prev => ({ ...prev, [slot]: { path: prev[slot].path, file: null, preview: null, removed: true } }))
  }
  function slotUrl(slot) {
    const s = imgs[slot]
    if (s.preview) return s.preview
    if (s.removed) return null
    return s.path ? signed[s.path] || null : null
  }

  // Bilder hochladen / entfernen und die Pfade in der Flasche eintragen
  async function syncImages(bottleId) {
    const update = {}
    const toDelete = []
    for (const [slot] of SLOTS) {
      const s = imgs[slot]
      if (s.file) {
        const blob = await resizeImage(s.file, 1000, 0.8)
        const path = `${userId}/${bottleId}/${slot}-${Date.now()}.jpg`
        const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
        if (up.error) throw up.error
        update[`image_${slot}`] = path
        if (s.path) toDelete.push(s.path)
        if (slot === 'front') {
          const thumb = await resizeImage(s.file, 240, 0.7)
          const tpath = `${userId}/${bottleId}/thumb-${Date.now()}.jpg`
          const tu = await supabase.storage.from(BUCKET).upload(tpath, thumb, { contentType: 'image/jpeg' })
          if (tu.error) throw tu.error
          update.image_thumb = tpath
          if (bottle?.image_thumb) toDelete.push(bottle.image_thumb)
        }
      } else if (s.removed && s.path) {
        update[`image_${slot}`] = null
        toDelete.push(s.path)
        if (slot === 'front') {
          update.image_thumb = null
          if (bottle?.image_thumb) toDelete.push(bottle.image_thumb)
        }
      }
    }
    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from('bottles').update(update).eq('id', bottleId)
      if (error) throw error
    }
    if (toDelete.length > 0) await supabase.storage.from(BUCKET).remove(toDelete)
  }

  // Foto-Auswertung mit Claude (über die Supabase-Funktion analyze-label)
  function applyAi(r) {
    if (!r) throw new Error('Keine Antwort erhalten')
    const cur = fRef.current
    const next = { ...cur }
    const filled = []
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

    if (r.brand) { next.brand = r.brand; filled.push('Marke') }
    if (r.name) { next.name = r.name; filled.push('Name') }

    const m = r.main_category ? mains.find(c => same(c.name, r.main_category)) : null
    if (m) {
      next.mainId = m.id
      const s = r.sub_category ? cats.find(c => c.parent_id === m.id && same(c.name, r.sub_category)) : null
      next.subId = s ? s.id : ''
      filled.push(s ? 'Kategorie und Subkategorie' : 'Kategorie')
    }

    if (r.abv !== null && r.abv !== undefined) { next.abv = String(r.abv); filled.push('Alkoholgehalt') }
    if (r.size_ml) {
      if (SIZES.includes(r.size_ml)) { next.size = String(r.size_ml); next.customSize = '' }
      else { next.size = 'other'; next.customSize = String(r.size_ml) }
      filled.push('Größe')
    }
    if (r.vintage) { next.vintage = r.vintage; filled.push('Jahrgang') }

    if (r.country) {
      const known = lookups.find(l => l.kind === 'country' && same(l.name, r.country))
      if (known) { next.country = known.name; next.newCountry = '' }
      else { next.country = '__new'; next.newCountry = r.country }
      filled.push('Herkunftsland')
    }
    if (r.region) {
      const country = next.country === '__new' ? next.newCountry : next.country
      const known = lookups.find(l => l.kind === 'region' && same(l.name, r.region) && (!l.country || !country || l.country === country))
      if (known) { next.region = known.name; next.newRegion = '' }
      else { next.region = '__new'; next.newRegion = r.region }
      filled.push('Region / Stil')
    }
    if (r.notes && !next.notes) { next.notes = r.notes; filled.push('Notiz') }

    setF(next)
    setMsg(filled.length > 0
      ? `Aus dem Foto übernommen: ${filled.join(', ')}. Bitte alles prüfen.`
      : 'Auf dem Foto konnte nichts sicher erkannt werden.')
  }

  async function analyze() {
    setError('')
    setMsg('')
    const files = SLOTS.map(([slot]) => imgs[slot].file).filter(Boolean)
    if (files.length === 0) return setError('Bitte zuerst mindestens ein Foto auswählen.')
    setAnalyzing(true)
    try {
      const result = await runAnalyze(files, cats, lookups)
      applyAi(result)
    } catch (e) {
      setError('Auswertung fehlgeschlagen: ' + e.message)
    }
    setAnalyzing(false)
  }

  function validate() {
    if (!f.brand.trim() || !f.name.trim()) return 'Marke und Name sind Pflichtfelder.'
    if (!f.mainId) return 'Bitte eine Kategorie wählen.'
    if (subs.length > 0 && !f.subId) return 'Bitte eine Subkategorie wählen.'
    if (main?.abv_required && f.abv === '') return 'Bei dieser Kategorie ist der Alkoholgehalt Pflicht.'
    const sizeMl = f.size === 'other' ? parseInt(f.customSize, 10) : parseInt(f.size, 10)
    if (!sizeMl || sizeMl <= 0) return 'Bitte eine Flaschengröße angeben.'
    if (!f.roomId || (f.roomId === '__new' && !f.newRoom.trim())) return 'Bitte einen Raum wählen.'
    if (f.locId === '__new' && !f.newLoc.trim()) return 'Bitte einen Namen für den neuen Ort eingeben.'
    if (f.country === '__new' && !f.newCountry.trim()) return 'Bitte einen Namen für das neue Land eingeben.'
    if (f.region === '__new' && !f.newRegion.trim()) return 'Bitte einen Namen für die neue Region eingeben.'
    return ''
  }

  async function save() {
    setError('')
    setMsg('')
    const problem = validate()
    if (problem) return setError(problem)

    setBusy(true)
    try {
      const sizeMl = f.size === 'other' ? parseInt(f.customSize, 10) : parseInt(f.size, 10)
      const roomId = f.roomId === '__new' ? await ensureRoom(rooms, f.newRoom.trim()) : f.roomId
      let locationId = null
      if (f.locId === '__new') locationId = await ensureLocation(locations, roomId, f.newLoc.trim())
      else if (f.locId && locations.some(l => l.id === f.locId && l.room_id === roomId)) locationId = f.locId

      let country = f.country === '__new' ? await ensureLookup(lookups, 'country', f.newCountry.trim(), null) : f.country
      let region = f.region === '__new' ? await ensureLookup(lookups, 'region', f.newRegion.trim(), country) : f.region

      const qtyParsed = parseInt(f.quantity, 10)
      const qty = Number.isNaN(qtyParsed) ? 1 : Math.max(edit ? 0 : 1, qtyParsed)

      const row = {
        category_id: f.subId || f.mainId,
        room_id: roomId,
        location_id: locationId,
        brand: f.brand.trim(),
        name: f.name.trim(),
        vintage: f.vintage.trim() || null,
        abv: f.abv === '' ? null : parseFloat(String(f.abv).replace(',', '.')),
        size_ml: sizeMl,
        country: country || null,
        region: region || null,
        status: f.status,
        quantity: qty,
        fill_percent: f.status === 'open' ? Number(f.fill_percent) : (f.status === 'empty' ? 0 : 100),
        is_collection: f.is_collection,
        is_sample: f.is_sample,
        barcode: f.barcode.trim() || null,
        notes: f.notes.trim() || null,
        min_stock: f.min_stock === '' ? null : parseInt(f.min_stock, 10),
      }

      lsSet('by_room', roomId)
      lsSet('by_loc', locationId || '')

      if (edit) {
        const { error: e1 } = await supabase.from('bottles').update(row).eq('id', bottle.id)
        if (e1) throw e1
        if (qty !== bottle.quantity) {
          await supabase.from('movements').insert({ bottle_id: bottle.id, type: 'adjustment', quantity: qty - bottle.quantity, notes: 'Manuell geändert' })
        }
        try {
          await syncImages(bottle.id)
        } catch (e) {
          await reload()
          setBusy(false)
          return setError('Gespeichert, aber die Bilder konnten nicht verarbeitet werden: ' + e.message)
        }
        await reload()
        onDone && onDone()
        return
      }

      const { data, error: e1 } = await supabase.from('bottles').insert(row).select('id').single()
      if (e1) throw e1
      await supabase.from('movements').insert({
        bottle_id: data.id,
        type: f.is_purchase ? 'purchase' : 'adjustment',
        quantity: qty,
        notes: f.is_purchase ? null : 'Erfassung',
      })

      let imageProblem = ''
      try { await syncImages(data.id) } catch (e) { imageProblem = ' Die Bilder konnten nicht hochgeladen werden: ' + e.message }

      setMsg(`Gespeichert: ${row.brand} ${row.name}.${imageProblem}`)
      setF(prev => ({
        ...prev,
        brand: '', name: '', vintage: '', abv: '', barcode: '', notes: '', quantity: 1,
        roomId, locId: locationId || '', newRoom: '', newLoc: '', newCountry: '', newRegion: '',
      }))
      setImgs({
        front: { path: null, file: null, preview: null, removed: false },
        back: { path: null, file: null, preview: null, removed: false },
        side: { path: null, file: null, preview: null, removed: false },
      })
      reload()
    } catch (e) {
      setError('Fehler beim Speichern: ' + e.message)
    }
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const paths = [bottle.image_front, bottle.image_back, bottle.image_side, bottle.image_thumb].filter(Boolean)
      if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths)
      const { error: e1 } = await supabase.from('bottles').delete().eq('id', bottle.id)
      if (e1) throw e1
      await reload()
      onDone && onDone()
    } catch (e) {
      setError('Fehler beim Löschen: ' + e.message)
      setBusy(false)
    }
  }

  return (
    <div className="form">
      {edit && (
        <div className="edit-head">
          <button type="button" className="link-back" onClick={onDone}>← Zurück</button>
          <h2>Flasche bearbeiten</h2>
        </div>
      )}
      {msg && <div className="msg">{msg}</div>}
      {error && <div className="msg error">{error}</div>}

      <input placeholder="Marke *" value={f.brand} onChange={e => set('brand', e.target.value)} />
      <input placeholder="Produktname *" value={f.name} onChange={e => set('name', e.target.value)} />

      <select value={f.mainId} onChange={e => setF(prev => ({ ...prev, mainId: e.target.value, subId: '' }))}>
        <option value="">Kategorie wählen *</option>
        {mains.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {subs.length > 0 && (
        <select value={f.subId} onChange={e => set('subId', e.target.value)}>
          <option value="">Subkategorie wählen *</option>
          {subs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}

      {main && (
        <input
          placeholder={`Alkoholgehalt in %${main.abv_required ? ' *' : ' (optional)'}`}
          inputMode="decimal" value={f.abv} onChange={e => set('abv', e.target.value)}
        />
      )}

      <select value={f.size} onChange={e => set('size', e.target.value)}>
        {SIZES.map(s => <option key={s} value={s}>{s} ml{s === 700 ? ' (Standard)' : ''}</option>)}
        <option value="other">Sonstige…</option>
      </select>
      {f.size === 'other' && <input placeholder="Größe in ml" inputMode="numeric" value={f.customSize} onChange={e => set('customSize', e.target.value)} />}

      <select value={f.country} onChange={e => setF(prev => ({ ...prev, country: e.target.value, region: prev.region === '__new' ? '' : prev.region }))}>
        <option value="">Herkunftsland wählen</option>
        {countries.map(c => <option key={c} value={c}>{c}</option>)}
        <option value="__new">+ Neues Land…</option>
      </select>
      {f.country === '__new' && <input placeholder="Name des neuen Landes" value={f.newCountry} onChange={e => set('newCountry', e.target.value)} />}

      <select value={f.region} onChange={e => set('region', e.target.value)}>
        <option value="">Region / Stil wählen</option>
        {regions.map(r => <option key={r} value={r}>{r}</option>)}
        <option value="__new">+ Neue Region / Stil…</option>
      </select>
      {f.region === '__new' && <input placeholder="Name der neuen Region / des Stils" value={f.newRegion} onChange={e => set('newRegion', e.target.value)} />}

      <input placeholder="Jahrgang (optional)" value={f.vintage} onChange={e => set('vintage', e.target.value)} />

      <div className="two">
        <select value={f.status} onChange={e => set('status', e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="number" min={edit ? 0 : 1} placeholder="Anzahl" value={f.quantity} onChange={e => set('quantity', e.target.value)} />
      </div>
      {f.status === 'open' && (
        <select value={f.fill_percent} onChange={e => set('fill_percent', e.target.value)}>
          {[100, 90, 75, 50, 25, 10].map(v => <option key={v} value={v}>Füllstand {v} %</option>)}
        </select>
      )}

      <select value={roomsValid || f.roomId === '__new' ? f.roomId : ''} onChange={e => setF(prev => ({ ...prev, roomId: e.target.value, locId: '' }))}>
        <option value="">Raum wählen *</option>
        {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        <option value="__new">+ Neuer Raum…</option>
      </select>
      {f.roomId === '__new' && <input placeholder="Name des neuen Raums" value={f.newRoom} onChange={e => set('newRoom', e.target.value)} />}

      {f.roomId && (
        <select value={locValid || f.locId === '__new' ? f.locId : ''} onChange={e => set('locId', e.target.value)}>
          <option value="">– kein Ort –</option>
          {roomLocs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="__new">+ Neuer Ort…</option>
        </select>
      )}
      {f.locId === '__new' && <input placeholder="Name des neuen Ortes, z. B. Kiste 4" value={f.newLoc} onChange={e => set('newLoc', e.target.value)} />}

      <div className="img-grid">
        {SLOTS.map(([slot, label]) => (
          <ImageSlot key={slot} label={label} url={slotUrl(slot)} onPick={file => pickImage(slot, file)} onRemove={() => removeImage(slot)} />
        ))}
      </div>

      <button type="button" className="ai-btn" onClick={analyze} disabled={analyzing}>
        {analyzing ? 'Wertet aus…' : 'Foto auswerten (KI)'}
      </button>
      <p className="hint">Liest Marke, Name, Kategorie, Alkoholgehalt, Größe und Herkunft von den gewählten Fotos ab und füllt die Felder vor. Bereits eingetragene Produktdaten werden dabei ersetzt.</p>

      <input placeholder="Barcode (optional)" inputMode="numeric" value={f.barcode} onChange={e => set('barcode', e.target.value)} />
      <input placeholder="Mindestbestand (optional)" type="number" min="0" value={f.min_stock} onChange={e => set('min_stock', e.target.value)} />
      <input placeholder="Notizen (optional)" value={f.notes} onChange={e => set('notes', e.target.value)} />

      <label className="check"><input type="checkbox" checked={f.is_collection} onChange={e => set('is_collection', e.target.checked)} /> Gehört zur Sammlung</label>
      <label className="check"><input type="checkbox" checked={f.is_sample} onChange={e => set('is_sample', e.target.checked)} /> Gratis-Muster (Sample)</label>
      {!edit && <label className="check"><input type="checkbox" checked={f.is_purchase} onChange={e => set('is_purchase', e.target.checked)} /> Neu gekauft (Wareneingang)</label>}

      <button className="save-btn" onClick={save} disabled={busy}>{busy ? 'Speichert…' : (edit ? 'Änderungen speichern' : 'Speichern')}</button>

      {edit && !confirmDelete && (
        <button type="button" className="danger-btn" onClick={() => setConfirmDelete(true)} disabled={busy}>Flasche löschen</button>
      )}
      {edit && confirmDelete && (
        <div className="confirm-box">
          <p>Wirklich löschen? Die Flasche, ihre Bilder und ihre Bewegungen werden endgültig entfernt.</p>
          <div className="two">
            <button type="button" className="danger-btn" onClick={remove} disabled={busy}>Ja, löschen</button>
            <button type="button" className="scan-btn secondary" onClick={() => setConfirmDelete(false)}>Abbrechen</button>
          </div>
        </div>
      )}
    </div>
  )
}
