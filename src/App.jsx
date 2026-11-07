import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabase'
import './App.css'

/* ---------- Hilfsfunktionen ---------- */

const SIZES = [20, 30, 50, 100, 200, 350, 500, 700, 750, 1000, 1500, 1750]
const STATUS = { closed: 'Geschlossen', open: 'Offen', empty: 'Leer' }

function lsGet(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value) } catch { /* ignorieren */ }
}

function abvLabel(abv) {
  if (abv === null || abv === undefined || abv === '') return null
  const a = Number(abv)
  if (a <= 0.5) return 'Alkoholfrei'
  if (a < 46) return 'Standard'
  if (a < 56.5) return 'High Proof'
  if (a <= 57.5) return 'Navy Strength'
  if (a < 75) return 'Overproof'
  if (a < 76) return '151'
  return 'Ultra High Proof'
}

function parseSize(q) {
  if (!q) return null
  const m = q.toLowerCase().replace(',', '.').match(/([\d.]+)\s*(ml|cl|l)\b/)
  if (!m) return null
  const v = parseFloat(m[1])
  return Math.round(m[2] === 'ml' ? v : m[2] === 'cl' ? v * 10 : v * 1000)
}

async function lookupBarcode(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,quantity`)
    const j = await r.json()
    if (j.status !== 1 || !j.product) return {}
    const p = j.product
    return {
      brand: (p.brands || '').split(',')[0].trim(),
      name: p.product_name || '',
      size_ml: parseSize(p.quantity),
    }
  } catch {
    return {}
  }
}

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
  return <Main onLogout={() => supabase.auth.signOut()} />
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

function Main({ onLogout }) {
  const [tab, setTab] = useState('bottles')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bottles, setBottles] = useState([])
  const [rooms, setRooms] = useState([])
  const [locations, setLocations] = useState([])
  const [cats, setCats] = useState([])
  const [prefill, setPrefill] = useState({ key: 0, data: null })

  async function loadAll() {
    const [b, r, l, c] = await Promise.all([
      supabase.from('bottles').select('*').order('brand').order('name'),
      supabase.from('rooms').select('*').order('sort_order').order('name'),
      supabase.from('locations').select('*').order('name'),
      supabase.from('categories').select('*').order('sort_order'),
    ])
    const err = b.error || r.error || l.error || c.error
    if (err) {
      setError('Daten konnten nicht geladen werden: ' + err.message)
    } else {
      setError('')
      setBottles(b.data)
      setRooms(r.data)
      setLocations(l.data)
      setCats(c.data)
    }
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  function onScanned(data) {
    setPrefill(p => ({ key: p.key + 1, data }))
    setTab('add')
  }

  const tabs = [
    ['bottles', 'Flaschen'],
    ['rooms', 'Lagerorte'],
    ['scanner', 'Scanner'],
    ['add', '+ Neu'],
  ]

  return (
    <Shell onLogout={onLogout}>
      <nav>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={tab === id ? 'active' : ''}>{label}</button>
        ))}
      </nav>
      <main>
        {error && <div className="msg error">{error}</div>}
        {loading && <div className="empty">Lädt…</div>}
        {!loading && tab === 'bottles' && (
          <BottleList bottles={bottles} cats={cats} rooms={rooms} locations={locations} reload={loadAll} />
        )}
        {!loading && tab === 'rooms' && (
          <Rooms bottles={bottles} rooms={rooms} locations={locations} reload={loadAll} />
        )}
        {tab === 'scanner' && <Scanner onDetected={onScanned} />}
        {!loading && tab === 'add' && (
          <AddForm key={prefill.key} prefill={prefill.data} cats={cats} rooms={rooms} locations={locations} reload={loadAll} />
        )}
      </main>
    </Shell>
  )
}

/* ---------- Flaschenliste mit Suche und Filtern ---------- */

function BottleList({ bottles, cats, rooms, locations, reload }) {
  const [q, setQ] = useState('')
  const [catId, setCatId] = useState('')
  const [status, setStatus] = useState('')
  const [roomId, setRoomId] = useState('')
  const [locId, setLocId] = useState('')
  const [msg, setMsg] = useState('')

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

  async function fail(error) {
    setMsg('Fehler: ' + error.message)
  }

  async function openOne(b) {
    setMsg('')
    if (b.quantity > 1) {
      const { error: e1 } = await supabase.from('bottles').update({ quantity: b.quantity - 1 }).eq('id', b.id)
      if (e1) return fail(e1)
      const { id, created_at, updated_at, user_id, captured_at, ...copy } = b
      const { error: e2 } = await supabase.from('bottles').insert({ ...copy, status: 'open', quantity: 1, fill_percent: 100 })
      if (e2) return fail(e2)
    } else {
      const { error: e1 } = await supabase.from('bottles').update({ status: 'open', fill_percent: 100 }).eq('id', b.id)
      if (e1) return fail(e1)
    }
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'opened', quantity: -1 })
    reload()
  }

  async function markEmpty(b) {
    setMsg('')
    const { error } = await supabase.from('bottles').update({ status: 'empty', fill_percent: 0 }).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'empty', quantity: -1 })
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
        return (
          <div key={b.id} className={'card' + (b.status === 'empty' ? ' dim' : '')}>
            <div className="card-icon"><BottleIcon /></div>
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
                    {[100, 90, 75, 50, 25, 10].map(v => <option key={v} value={v}>{v} %</option>)}
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
              <div className="actions">
                {b.status === 'closed' && <button onClick={() => openOne(b)}>Öffnen</button>}
                {b.status === 'open' && <button onClick={() => markEmpty(b)}>Leer</button>}
              </div>
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

function Scanner({ onDetected }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const activeRef = useRef(false)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [info, setInfo] = useState('')

  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window

  function stop() {
    activeRef.current = false
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    setScanning(false)
  }

  useEffect(() => stop, [])

  async function handleCode(code) {
    setInfo(`Code ${code} erkannt – suche Produktdaten…`)
    const data = await lookupBarcode(code)
    onDetected({ barcode: code, ...data })
  }

  async function start() {
    setInfo('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      activeRef.current = true
      setScanning(true)
      await new Promise(r => setTimeout(r, 50))
      const video = videoRef.current
      video.srcObject = stream
      await video.play()
      const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] })
      const tick = async () => {
        if (!activeRef.current) return
        try {
          const found = await detector.detect(video)
          if (found.length > 0) {
            const code = found[0].rawValue
            stop()
            handleCode(code)
            return
          }
        } catch { /* weiter versuchen */ }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } catch {
      stop()
      setInfo('Kamera konnte nicht gestartet werden. Bitte Zugriff erlauben oder den Code unten eintippen.')
    }
  }

  return (
    <div className="scanner-box">
      <h3>Barcode Scanner</h3>
      <p>Kamera auf den Barcode der Flasche richten</p>
      {supported
        ? (!scanning && <button className="scan-btn" onClick={start}>Kamera starten</button>)
        : <p className="muted">Dieser Browser kann keine Barcodes lesen. Bitte Chrome auf Android nutzen oder den Code eintippen.</p>}
      {scanning && (
        <>
          <video ref={videoRef} playsInline muted />
          <button className="scan-btn secondary" onClick={stop}>Abbrechen</button>
        </>
      )}
      <div className="inline-add manual">
        <input inputMode="numeric" placeholder="Code manuell eingeben" value={manual} onChange={e => setManual(e.target.value)} />
        <button onClick={() => manual.trim() && handleCode(manual.trim())}>Suchen</button>
      </div>
      {info && <div className="msg">{info}</div>}
    </div>
  )
}

/* ---------- Formular: neue Flasche ---------- */

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

function AddForm({ prefill, cats, rooms, locations, reload }) {
  const mains = cats.filter(c => !c.parent_id)
  const [f, setF] = useState({
    brand: prefill?.brand || '',
    name: prefill?.name || '',
    mainId: '',
    subId: '',
    abv: '',
    size: prefill?.size_ml && SIZES.includes(prefill.size_ml) ? String(prefill.size_ml) : (prefill?.size_ml ? 'other' : '700'),
    customSize: prefill?.size_ml && !SIZES.includes(prefill.size_ml) ? String(prefill.size_ml) : '',
    vintage: '', country: '', region: '',
    status: 'closed', quantity: 1,
    roomId: lsGet('by_room') || '',
    locId: lsGet('by_loc') || '',
    newRoom: '', newLoc: '',
    is_collection: false, is_sample: false, is_purchase: false,
    min_stock: '', barcode: prefill?.barcode || '', notes: '',
  })
  const [msg, setMsg] = useState(prefill?.barcode ? (prefill.brand || prefill.name ? 'Produktdaten übernommen – bitte prüfen und ergänzen.' : 'Barcode übernommen – keine Produktdaten gefunden, bitte manuell ausfüllen.') : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))
  const main = mains.find(c => c.id === f.mainId)
  const subs = cats.filter(c => c.parent_id === f.mainId)
  const roomLocs = locations.filter(l => l.room_id === f.roomId)

  const roomsValid = rooms.some(r => r.id === f.roomId)
  const locValid = locations.some(l => l.id === f.locId && l.room_id === f.roomId)

  async function save() {
    setError('')
    setMsg('')
    if (!f.brand.trim() || !f.name.trim()) return setError('Marke und Name sind Pflichtfelder.')
    if (!f.mainId) return setError('Bitte eine Kategorie wählen.')
    if (subs.length > 0 && !f.subId) return setError('Bitte eine Subkategorie wählen.')
    if (main?.abv_required && f.abv === '') return setError('Bei dieser Kategorie ist der Alkoholgehalt Pflicht.')
    const sizeMl = f.size === 'other' ? parseInt(f.customSize, 10) : parseInt(f.size, 10)
    if (!sizeMl || sizeMl <= 0) return setError('Bitte eine Flaschengröße angeben.')
    if (!f.roomId || (f.roomId === '__new' && !f.newRoom.trim())) return setError('Bitte einen Raum wählen.')
    if (f.locId === '__new' && !f.newLoc.trim()) return setError('Bitte einen Namen für den neuen Ort eingeben.')

    setBusy(true)
    try {
      const roomId = f.roomId === '__new' ? await ensureRoom(rooms, f.newRoom.trim()) : f.roomId
      let locationId = null
      if (f.locId === '__new') locationId = await ensureLocation(locations, roomId, f.newLoc.trim())
      else if (f.locId && locValid) locationId = f.locId

      const qty = Math.max(1, parseInt(f.quantity, 10) || 1)
      const { data, error: e1 } = await supabase.from('bottles').insert({
        category_id: f.subId || f.mainId,
        room_id: roomId,
        location_id: locationId,
        brand: f.brand.trim(),
        name: f.name.trim(),
        vintage: f.vintage.trim() || null,
        abv: f.abv === '' ? null : parseFloat(String(f.abv).replace(',', '.')),
        size_ml: sizeMl,
        country: f.country.trim() || null,
        region: f.region.trim() || null,
        status: f.status,
        quantity: qty,
        fill_percent: f.status === 'open' ? 100 : (f.status === 'empty' ? 0 : 100),
        is_collection: f.is_collection,
        is_sample: f.is_sample,
        barcode: f.barcode.trim() || null,
        notes: f.notes.trim() || null,
        min_stock: f.min_stock === '' ? null : parseInt(f.min_stock, 10),
      }).select('id').single()
      if (e1) throw e1

      await supabase.from('movements').insert({
        bottle_id: data.id,
        type: f.is_purchase ? 'purchase' : 'adjustment',
        quantity: qty,
        notes: f.is_purchase ? null : 'Erfassung',
      })

      lsSet('by_room', roomId)
      lsSet('by_loc', locationId || '')
      setMsg(`Gespeichert: ${f.brand.trim()} ${f.name.trim()}`)
      setF(prev => ({
        ...prev,
        brand: '', name: '', vintage: '', abv: '', barcode: '', notes: '', quantity: 1,
        roomId, locId: locationId || '', newRoom: '', newLoc: '',
      }))
      reload()
    } catch (e) {
      setError('Fehler beim Speichern: ' + e.message)
    }
    setBusy(false)
  }

  return (
    <div className="form">
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

      <div className="two">
        <input placeholder="Herkunftsland" value={f.country} onChange={e => set('country', e.target.value)} />
        <input placeholder="Region / Stil" value={f.region} onChange={e => set('region', e.target.value)} />
      </div>
      <input placeholder="Jahrgang (optional)" value={f.vintage} onChange={e => set('vintage', e.target.value)} />

      <div className="two">
        <select value={f.status} onChange={e => set('status', e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="number" min="1" placeholder="Anzahl" value={f.quantity} onChange={e => set('quantity', e.target.value)} />
      </div>

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

      <input placeholder="Barcode (optional)" inputMode="numeric" value={f.barcode} onChange={e => set('barcode', e.target.value)} />
      <input placeholder="Mindestbestand (optional)" type="number" min="0" value={f.min_stock} onChange={e => set('min_stock', e.target.value)} />
      <input placeholder="Notizen (optional)" value={f.notes} onChange={e => set('notes', e.target.value)} />

      <label className="check"><input type="checkbox" checked={f.is_collection} onChange={e => set('is_collection', e.target.checked)} /> Gehört zur Sammlung</label>
      <label className="check"><input type="checkbox" checked={f.is_sample} onChange={e => set('is_sample', e.target.checked)} /> Gratis-Muster (Sample)</label>
      <label className="check"><input type="checkbox" checked={f.is_purchase} onChange={e => set('is_purchase', e.target.checked)} /> Neu gekauft (Wareneingang)</label>

      <button className="save-btn" onClick={save} disabled={busy}>{busy ? 'Speichert…' : 'Speichern'}</button>
    </div>
  )
}
