import { useState, useEffect, useMemo, useRef, createContext, useContext } from 'react'
import { supabase } from './supabase'
import {
  SIZES, STATUS, BUCKET, APP_VERSION, fetchAll, lsGet, lsSet, abvLabel,
  digitsOnly, codeVariants, codeWarning, lookupBarcode,
  productKey, stockGroups, pathsInUse,
} from './utils'
import { parsePlaceCode } from './qr'
import { createDetector, pickCode, decodeFromFile, runAnalyze, ensureLookup, aiToPrefill, ensureRoom, ensureLocation, clearReorderFor, resizeCached, warmImage } from './shared'
import Schnell from './Schnell'
import Tasting from './Tasting'
import Chat from './Chat'
import Einkauf from './Einkauf'
import Lieferung from './Lieferung'
import Verwaltung from './Verwaltung'
import WakeToggle from './WakeLock'
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

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" />
  </svg>
)

// Großansicht: Bilder im Vollbild, bei mehreren seitlich wischen, Tippen schließt
function Lightbox({ images, start = 0, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.clientWidth * start
  }, [start])
  return (
    <div className="lightbox" onClick={onClose}>
      <button type="button" className="lb-close" aria-label="Schließen" onClick={onClose}>×</button>
      <div className="lb-track" ref={ref}>
        {images.map((im, i) => (
          <figure key={i} className="lb-item">
            <img src={im.url} alt={im.label} />
            <figcaption>{im.label}{images.length > 1 ? ` · ${i + 1}/${images.length}` : ''}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

function Shell({ children, onLogout }) {
  return (
    <div className="app">
      <header>
        <div className="logo">
          <div className="logo-icon"><BackbarLogo /></div>
          <div className="logo-text">
            <h1>BoozeYard</h1>
            <p>Spirits Inventory · {APP_VERSION}</p>
          </div>
        </div>
        {onLogout && <WakeToggle />}
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

// Ist der Reiter gerade sichtbar? (Erfassen und Tasting bleiben im Hintergrund erhalten, die Kamera darf dann nicht weiterlaufen)
const TabActive = createContext(true)

/* ---------- Hauptansicht ---------- */

// Barcode auflösen: erst im eigenen Bestand suchen, dann in Open Food Facts
async function resolveCode(raw, bottles, cats) {
  const code = digitsOnly(raw)
  if (!code) return null
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
      _dupId: (own.find(x => x.status === 'closed') || {}).id || null,
    }
  } else {
    const mains = cats.filter(c => !c.parent_id)
    const found = await lookupBarcode(variants, mains)
    if (found && found.got.length > 0) {
      data = { barcode: code, ...found, note: `Aus ${found.source || 'Open Food Facts'} übernommen: ${found.got.join(', ')}. Bitte prüfen und ergänzen.` }
    } else {
      data = { barcode: code, note: 'Barcode übernommen – in Open Food Facts und Open Products Facts steht dazu nichts. Unten beim Barcode-Feld kannst du „Barcode im Web suchen (KI)“ nutzen, das Etikett fotografieren oder von Hand ausfüllen.' }
    }
  }
  if (warn) data.note = `${data.note} ${warn}`
  return data
}

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
  const [lastIn, setLastIn] = useState({})   // Flaschen-ID -> Zeitpunkt der letzten Zugangsbuchung
  const [prefill, setPrefill] = useState({ key: 0, data: null })
  const [editId, setEditId] = useState(null)
  const [series, setSeries] = useState({ roomId: '', locId: '' })
  const [wishlist, setWishlist] = useState([])
  const [capView, setCapView] = useState(null)   // null = Startseite der Erfassung | 'form' | 'deliv'
  const [adminKey, setAdminKey] = useState(0)
  const [dup, setDup] = useState(null)       // { data, id } – gescannte Flasche ist schon geschlossen im Bestand
  const [dupMsg, setDupMsg] = useState('')
  const [pendingPlace, setPendingPlace] = useState(() => parsePlaceCode(window.location.search ? window.location.href : ''))   // Orts-Link aus dem QR-Code
  const [placeReq, setPlaceReq] = useState({ key: 0, roomId: '', locId: '' })   // Orts-Ansicht in der Bestandsliste
  const [notice, setNotice] = useState('')

  async function loadThumbs(rows) {
    const paths = rows.map(b => b.image_thumb).filter(Boolean)
    if (paths.length === 0) { setThumbs({}); return }
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    const map = {}
    ;(data || []).forEach(x => { if (x.signedUrl) map[x.path] = x.signedUrl })
    setThumbs(map)
  }

  async function loadAll() {
    const [b, r, l, c, lv, wl] = await Promise.all([
      fetchAll(() => supabase.from('bottles').select('*').order('brand').order('name').order('id')),
      supabase.from('rooms').select('*').order('sort_order').order('name'),
      fetchAll(() => supabase.from('locations').select('*').order('name').order('id')),
      supabase.from('categories').select('*').order('sort_order'),
      fetchAll(() => supabase.from('lookup_values').select('*').order('name').order('id')),
      fetchAll(() => supabase.from('wishlist').select('*').order('created_at').order('id')),
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
      setWishlist(wl.error ? [] : (wl.data || []))
      loadThumbs(b.data)
      loadLastIn()
    }
    setLoading(false)
  }

  // Letzte Zugangsbuchung je Flasche (für die Sortierung "Zuletzt erfasst"); lädt im Hintergrund nach
  async function loadLastIn() {
    const res = await fetchAll(() => supabase.from('movements').select('bottle_id,moved_at,notes').gt('quantity', 0).order('moved_at', { ascending: false }).order('id'))
    if (res.error) return
    const map = {}
    for (const m of res.data || []) {
      if (m.notes === 'Öffnen rückgängig' || m.notes === 'Leer rückgängig') continue
      if (!map[m.bottle_id] || m.moved_at > map[m.bottle_id]) map[m.bottle_id] = m.moved_at
    }
    setLastIn(map)
  }

  useEffect(() => { loadAll() }, [])

  // Orts-QR (Link oder Scan): Bestandsliste auf diesen Ort filtern
  function openPlace(p) {
    let roomId = ''
    let locId = ''
    if (p.kind === 'location') {
      const l = locations.find(x => x.id === p.id)
      if (l) { roomId = l.room_id; locId = l.id }
    } else {
      const r = rooms.find(x => x.id === p.id)
      if (r) roomId = r.id
    }
    if (!roomId) {
      setNotice('Zu diesem QR-Code gibt es keinen Ort mehr. Das Etikett ist veraltet, der Ort wurde gelöscht.')
      setTab('bottles'); setEditId(null); setCapView(null); setDup(null)
      return
    }
    setNotice('')
    setTab('bottles'); setEditId(null); setCapView(null); setDup(null)
    setPlaceReq(r => ({ key: r.key + 1, roomId, locId }))
  }

  // Link aus dem QR-Code beim Start: nach dem Laden der Daten den Ort öffnen
  useEffect(() => {
    if (loading || !pendingPlace) return
    openPlace(pendingPlace)
    setPendingPlace(null)
    try { window.history.replaceState(null, '', window.location.pathname) } catch { /* ignorieren */ }
  }, [loading, pendingPlace])

  // Barcode erkannt (Scanner-Tab): Daten suchen, dann Formular vorbefüllen
  async function handleCode(raw) {
    const place = parsePlaceCode(raw)
    if (place) { openPlace(place); return }
    const data = await resolveCode(raw, bottles, cats)
    if (!data) return
    setDupMsg('')
    if (data._dupId) { setDup({ data, id: data._dupId }); return }
    setPrefill(p => ({ key: p.key + 1, data }))
    setEditId(null)
    setCapView('form')
  }

  // Schon geschlossen im Bestand: Anzahl um 1 erhöhen
  async function addOne() {
    const b = bottles.find(x => x.id === dup.id)
    if (!b) { setDup(null); return }
    const { error: e1 } = await supabase.from('bottles').update({ quantity: b.quantity + 1 }).eq('id', b.id)
    if (e1) { setDup(null); return setError('Fehler: ' + e1.message) }
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'adjustment', quantity: 1, notes: 'Per Scan hinzugefügt' })
    await clearReorderFor(bottles, b)
    setDupMsg(`${b.brand} ${b.name}: jetzt ${b.quantity + 1}× geschlossen.`)
    setDup(null)
    loadAll()
  }
  function newFromDup() {
    const { _dupId, ...data } = dup.data
    setDup(null)
    setPrefill(p => ({ key: p.key + 1, data }))
    setEditId(null)
    setCapView('form')
  }

  function manualEntry() {
    setDupMsg('')
    setPrefill(p => ({ key: p.key + 1, data: null }))
    setEditId(null)
    setCapView('form')
  }

  // Etikett-Foto aus der Erfassung: direkt KI, dann Formular vorbefüllt
  async function handleLabel({ front, back }) {
    try {
      const r = await runAnalyze([front, back].filter(Boolean), cats, lookups)
      const { data, filled } = aiToPrefill(r, cats, lookups)
      data.frontFile = front
      data.backFile = back || null
      data.note = filled.length > 0
        ? `Aus dem Etikett-${back ? 'Fotos' : 'Foto'} übernommen: ${filled.join(', ')}. Bitte alles prüfen und Anzahl und Ort ergänzen.`
        : 'Auf dem Foto konnte nichts sicher erkannt werden. Bitte von Hand ausfüllen.'
      setPrefill(p => ({ key: p.key + 1, data }))
      setEditId(null)
      setCapView('form')
      return ''
    } catch (e) {
      return 'Auswertung fehlgeschlagen: ' + e.message
    }
  }

  const tabs = [
    ['bottles', 'Bestand'],
    ['capture', 'Erfassen'],
    ['buy', 'Einkauf'],
    ['tasting', 'Tasting'],
    ['admin', 'Verwaltung'],
  ]
  // Erfassen und Tasting einmal geöffnet im Hintergrund behalten, damit beim Reiterwechsel nichts verloren geht
  const seen = useRef(new Set())
  seen.current.add(tab)
  const seriesPlace = series.roomId
    ? [rooms.find(r => r.id === series.roomId)?.name, locations.find(l => l.id === series.locId)?.name].filter(Boolean).join(' › ')
    : ''
  const editing = editId ? bottles.find(b => b.id === editId) : null

  return (
    <Shell onLogout={onLogout}>
      <nav>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => {
            const same = id === tab
            setTab(id); setNotice(''); setPlaceReq({ key: 0, roomId: '', locId: '' })
            // Erneut auf den offenen Reiter tippen: zurück zur Startansicht. Beim Wechsel bleibt der Stand erhalten.
            if (same) {
              setEditId(null); setCapView(null); setDup(null); setDupMsg('')
              if (id === 'admin') setAdminKey(k => k + 1)
              if (id === 'bottles' || id === 'admin') setSeries({ roomId: '', locId: '' })
            }
          }} className={tab === id ? 'active' : ''}>{label}</button>
        ))}
      </nav>
      <main>
        {error && <div className="msg error">{error}</div>}
        {notice && <div className="msg error">{notice}</div>}
        {loading && <div className="empty">Lädt…</div>}
        {!loading && tab === 'bottles' && !editing && (
          <BottleList bottles={bottles} cats={cats} rooms={rooms} locations={locations} thumbs={thumbs} lastIn={lastIn}
            placeReq={placeReq} reload={loadAll} onEdit={id => setEditId(id)} />
        )}
        {!loading && tab === 'bottles' && editing && (
          <BottleForm key={editing.id} userId={userId} bottle={editing} cats={cats} rooms={rooms}
            locations={locations} lookups={lookups} bottles={bottles} reload={loadAll} onDone={() => setEditId(null)} />
        )}
        {(tab === 'capture' || seen.current.has('capture')) && (
          <TabActive.Provider value={tab === 'capture'}>
            <div style={{ display: tab === 'capture' ? 'block' : 'none' }}>
        {capView === null && (
          <>
            {dupMsg && <div className="msg">{dupMsg}</div>}
            {dup && (() => {
              const b = bottles.find(x => x.id === dup.id)
              if (!b) return null
              const place = [rooms.find(r => r.id === b.room_id)?.name, locations.find(l => l.id === b.location_id)?.name].filter(Boolean).join(' › ')
              return (
                <div className="card column dup-box">
                  <h3>Schon im Bestand</h3>
                  <p>{b.brand} {b.name} · {b.quantity}× geschlossen{place ? ` · ${place}` : ''}</p>
                  <div className="row-btns">
                    <button className="scan-btn" onClick={addOne}>+1 zu diesem Eintrag</button>
                    <button className="scan-btn secondary" onClick={newFromDup}>Als neuen Eintrag anlegen</button>
                  </div>
                  <button className="ghost-btn" onClick={() => setDup(null)}>Abbrechen</button>
                </div>
              )
            })()}
            {seriesPlace && (
              <div className="series-box">
                <span>Neue Flaschen kommen nach <b>{seriesPlace}</b></span>
                <button type="button" onClick={() => setSeries({ roomId: '', locId: '' })}>Zurücksetzen</button>
              </div>
            )}
            <Scanner onCode={handleCode} onLabel={handleLabel} onManual={manualEntry} />
            <div className="card column deliv-entry">
              <h3>Foto-Schnellerfassung</h3>
              <p>Raum, Ort und Status einmal vorgeben, dann pro Flasche Front und Rück fotografieren.</p>
              <button className="scan-btn secondary" style={{ marginTop: 0 }} onClick={() => setCapView('quick')}>Schnellerfassung starten</button>
            </div>
            <div className="card column deliv-entry">
              <h3>Lieferschein oder Rechnung</h3>
              <p>Beleg als Foto oder PDF einlesen, die KI erfasst alle Positionen auf einmal.</p>
              <button className="scan-btn secondary" style={{ marginTop: 0 }} onClick={() => setCapView('deliv')}>Beleg erfassen</button>
            </div>
          </>
        )}
        {!loading && capView === 'deliv' && (
          <>
            <button className="link-back" onClick={() => setCapView(null)}>← Zurück zur Erfassung</button>
            <Lieferung bottles={bottles} cats={cats} rooms={rooms} locations={locations} lookups={lookups}
              reload={loadAll} onDone={() => { setCapView(null); setTab('bottles') }} />
          </>
        )}
        {!loading && capView === 'quick' && (
          <>
            <button className="link-back" onClick={() => setCapView(null)}>← Zurück zur Erfassung</button>
            <Schnell userId={userId} bottles={bottles} cats={cats} rooms={rooms} locations={locations} lookups={lookups}
              reload={loadAll} onDone={() => { setCapView(null); setTab('bottles') }} />
          </>
        )}
        {!loading && capView === 'form' && (
          <BottleForm key={prefill.key} userId={userId} prefill={prefill.data} cats={cats} rooms={rooms}
            locations={locations} lookups={lookups} bottles={bottles} reload={loadAll}
            series={series} onSeries={(roomId, locId, extra) => setSeries({ roomId, locId, ...(extra || {}) })}
            onBack={() => setCapView(null)} onNext={() => setCapView(null)}
            onFinish={() => { setSeries({ roomId: '', locId: '' }); setCapView(null); setTab('bottles') }} />
        )}
            </div>
          </TabActive.Provider>
        )}
        {!loading && (tab === 'tasting' || seen.current.has('tasting')) && (
          <TabActive.Provider value={tab === 'tasting'}>
            <div style={{ display: tab === 'tasting' ? 'block' : 'none' }}>
              <Tasting userId={userId} cats={cats} lookups={lookups} wishlist={wishlist} reload={loadAll} />
            </div>
          </TabActive.Provider>
        )}
        {!loading && tab === 'buy' && <Einkauf bottles={bottles} wishlist={wishlist} reload={loadAll} />}
        {!loading && tab === 'admin' && (
          <Verwaltung key={adminKey} bottles={bottles} cats={cats} rooms={rooms} locations={locations} reload={loadAll} />
        )}
      </main>
      <Chat hidden={(tab === 'capture' && capView === 'form') || (tab === 'bottles' && !!editId)}
        onOpenBottle={id => { setTab('bottles'); setEditId(id) }} reload={loadAll} />
    </Shell>
  )
}

/* ---------- Info-Kachel zu einer Flasche (nur lesen) ---------- */

const eurFmt = n => Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })

function BottleInfo({ b, thumb, place, cat, group, lastIn, onClose, onEdit, onGallery }) {
  const label = abvLabel(b.abv)
  const rows = [
    ['Kategorie', cat],
    ['Alkohol', b.abv !== null && b.abv !== undefined ? `${String(b.abv).replace('.', ',')} %${label && label !== 'Standard' ? ` · ${label}` : ''}` : ''],
    ['Größe', b.size_ml ? `${b.size_ml} ml` : ''],
    ['Jahrgang', b.vintage],
    ['Land', b.country],
    ['Region / Stil', b.region],
    ['Status', `${STATUS[b.status]}${b.quantity > 1 ? ` · ×${b.quantity}` : ''}`],
    ['Ort', place],
    ['Letzter Preis', b.last_price !== null && b.last_price !== undefined ? eurFmt(b.last_price) : ''],
    ['Mindestbestand', b.min_stock ? String(b.min_stock) : ''],
    ['Barcode', b.barcode],
    ['Erfasst', b.created_at ? new Date(b.created_at).toLocaleDateString('de-DE') : ''],
    ['Zuletzt hinzugekommen', lastIn ? new Date(lastIn).toLocaleDateString('de-DE') : ''],
  ].filter(r => r[1])
  return (
    <div className="info-back" onClick={onClose}>
      <div className="info-card" role="dialog" aria-label="Flaschen-Info" onClick={e => e.stopPropagation()}>
        <div className="info-head">
          <div className={'card-icon' + (thumb ? ' has-thumb zoomable' : '')} onClick={thumb ? onGallery : undefined}>
            {thumb ? <img className="thumb" src={thumb} alt="" /> : <BottleIcon />}
          </div>
          <div className="info-title">
            <h3>{b.brand} {b.name}</h3>
            <div className="tags">
              {b.is_collection && <span className="tag">Sammlung</span>}
              {b.is_sample && <span className="tag">Sample</span>}
              {b.reorder && <span className="tag warn">Vorgemerkt</span>}
            </div>
          </div>
          <button type="button" className="info-x" aria-label="Schließen" onClick={onClose}>×</button>
        </div>
        {b.status === 'open' && (
          <div className="fill-row info-fill">
            <div className="fill-bar"><div className="fill-bar-inner" style={{ width: `${b.fill_percent}%` }} /></div>
            <span>{b.fill_percent} %</span>
          </div>
        )}
        <div className="info-grid">
          {rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
          {group && group.entries.length > 1 && (
            <div className="wide"><span>Dieses Produkt insgesamt</span><b>{group.closed} geschlossen{group.open > 0 ? `, ${group.open} offen` : ''}</b></div>
          )}
          {b.notes && <div className="wide"><span>Notiz</span><b>{b.notes}</b></div>}
        </div>
        <div className="info-btns">
          <button type="button" className="scan-btn" onClick={onEdit}>Bearbeiten</button>
          <button type="button" className="scan-btn secondary" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Bestandsliste mit Suche und Filtern ---------- */

function BottleList({ bottles, cats, rooms, locations, thumbs, lastIn = {}, placeReq, reload, onEdit }) {
  const [q, setQ] = useState('')
  const [catId, setCatId] = useState('')
  const [status, setStatus] = useState('')
  const [roomId, setRoomId] = useState('')
  const [locId, setLocId] = useState('')
  const [msg, setMsg] = useState('')
  const [delId, setDelId] = useState(null)
  const [gallery, setGallery] = useState(null)
  const [selMode, setSelMode] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const [mvOpen, setMvOpen] = useState(false)
  const [mvRoom, setMvRoom] = useState('')
  const [mvLoc, setMvLoc] = useState('')
  const [mvBusy, setMvBusy] = useState(false)
  const [moved, setMoved] = useState('')
  const [limit, setLimit] = useState(60)
  const [infoId, setInfoId] = useState(null)
  const [sortBy, setSortBy] = useState(() => (lsGet('sort') === 'recent' ? 'recent' : 'name'))
  const [emptyAsk, setEmptyAsk] = useState(null)
  const [openAsk, setOpenAsk] = useState(null)     // { b, roomId, locId }: Ziel der geöffneten Flasche wählen
  const [undoAsk, setUndoAsk] = useState(null)     // { b, cands }: zu welchem Stapel zurück
  const [mergeAsk, setMergeAsk] = useState(null)     // { keepId }: Einträge zusammenführen
  const [mergeBusy, setMergeBusy] = useState(false)
  const [placeMode, setPlaceMode] = useState(false) // Orts-Ansicht (aus QR-Code): leere Flaschen ausgeblendet
  useEffect(() => { setLimit(60) }, [q, catId, status, roomId, locId, sortBy])
  useEffect(() => {
    if (!placeReq || !placeReq.key) return
    setQ(''); setCatId(''); setStatus(''); setRoomId(placeReq.roomId); setLocId(placeReq.locId); setPlaceMode(true)
  }, [placeReq?.key])

  const catById = useMemo(() => Object.fromEntries(cats.map(c => [c.id, c])), [cats])
  const roomById = useMemo(() => Object.fromEntries(rooms.map(r => [r.id, r])), [rooms])
  const locById = useMemo(() => Object.fromEntries(locations.map(l => [l.id, l])), [locations])
  const groups = useMemo(() => stockGroups(bottles), [bottles])
  const mains = cats.filter(c => !c.parent_id)

  function toggleSel(id) {
    setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function endSelect() {
    setSelMode(false); setSel(new Set()); setMvOpen(false); setMvRoom(''); setMvLoc('')
  }
  async function moveSelected() {
    if (!mvRoom || sel.size === 0) return
    setMvBusy(true); setMsg('')
    const ids = [...sel]
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await supabase.from('bottles').update({ room_id: mvRoom, location_id: mvLoc || null }).in('id', ids.slice(i, i + 100))
      if (error) { setMvBusy(false); return fail(error) }
    }
    const target = [roomById[mvRoom]?.name, mvLoc ? locById[mvLoc]?.name : null].filter(Boolean).join(' › ')
    setMvBusy(false)
    endSelect()
    setMsg('')
    await reload()
    setMoved(`${ids.length} ${ids.length === 1 ? 'Eintrag' : 'Einträge'} verschoben nach ${target}.`)
  }

  // ----- Einträge zusammenführen (z. B. Duplikate) -----
  const selected = () => bottles.filter(b => sel.has(b.id))
  function startMerge() {
    const list = selected()
    if (list.length < 2) return
    const rank = { closed: 0, open: 1, empty: 2 }
    const best = [...list].sort((a, b) => rank[a.status] - rank[b.status] || (b.image_front ? 1 : 0) - (a.image_front ? 1 : 0) || b.quantity - a.quantity)[0]
    setMergeAsk({ keepId: best.id })
  }
  function mergePlan(keep, others) {
    if (others.some(o => o.status === 'open')) return { error: 'Offene Flaschen haben jeweils einen eigenen Füllstand und lassen sich nicht zusammenführen. Bitte nur geschlossene und leere Einträge wählen.' }
    const closedOthers = others.filter(o => o.status === 'closed')
    if (closedOthers.length > 0 && keep.status !== 'closed') return { error: 'Geschlossene Flaschen lassen sich nur in einen geschlossenen Eintrag zusammenführen. Bitte einen geschlossenen Eintrag als den bleibenden wählen.' }
    const addQty = closedOthers.reduce((sum, o) => sum + o.quantity, 0)
    return { addQty, closedOthers, emptyOthers: others.filter(o => o.status === 'empty') }
  }
  async function doMerge() {
    const list = selected()
    const keep = list.find(b => b.id === mergeAsk.keepId)
    const others = list.filter(b => b.id !== mergeAsk.keepId)
    if (!keep || others.length === 0) return setMergeAsk(null)
    const plan = mergePlan(keep, others)
    if (plan.error) return setMsg('Fehler: ' + plan.error)
    setMergeBusy(true)
    const newQty = keep.quantity + plan.addQty
    const keepName = `${keep.brand} ${keep.name}`
    try {
      const patch = {}
      if (plan.addQty > 0) { patch.quantity = newQty; patch.reorder = false }
      // Fehlende Angaben aus den anderen Einträgen übernehmen
      const blank = v => v === null || v === undefined || v === ''
      for (const k of ['country', 'region', 'abv', 'vintage', 'barcode', 'min_stock', 'notes', 'last_price', 'supplier_sku']) {
        if (blank(keep[k])) { const src = others.find(o => !blank(o[k])); if (src) patch[k] = src[k] }
      }
      // Fotos: nur Lücken füllen, die Vorschau gehört zum Vorderfoto
      const adopted = new Set([keep.image_front, keep.image_back, keep.image_side, keep.image_thumb].filter(Boolean))
      if (!keep.image_front) {
        const src = others.find(o => o.image_front)
        if (src) { patch.image_front = src.image_front; adopted.add(src.image_front); if (src.image_thumb) { patch.image_thumb = src.image_thumb; adopted.add(src.image_thumb) } }
      }
      for (const k of ['image_back', 'image_side']) {
        if (!keep[k]) { const src = others.find(o => o[k]); if (src) { patch[k] = src[k]; adopted.add(src[k]) } }
      }
      const ids = others.map(o => o.id)
      let r = await supabase.from('movements').update({ bottle_id: keep.id }).in('bottle_id', ids)
      if (r.error) throw r.error
      if (Object.keys(patch).length > 0) {
        r = await supabase.from('bottles').update(patch).eq('id', keep.id)
        if (r.error) throw r.error
      }
      r = await supabase.from('bottles').delete().in('id', ids)
      if (r.error) throw r.error
      const usedByOthers = pathsInUse(bottles, ids)
      const orphans = others.flatMap(o => [o.image_front, o.image_back, o.image_side, o.image_thumb]).filter(x => x && !adopted.has(x) && !usedByOthers.has(x))
      if (orphans.length > 0) { try { await supabase.storage.from(BUCKET).remove(orphans) } catch { /* ignorieren */ } }
      setMergeAsk(null)
      endSelect()
      await reload()
      setMoved(`${others.length + 1} Einträge zu „${keepName}“ zusammengeführt${plan.addQty > 0 ? `, jetzt ${newQty}× geschlossen` : ''}.`)
    } catch (e) {
      setMsg('Fehler: ' + e.message)
    }
    setMergeBusy(false)
  }

  function mainOf(b) {
    const c = catById[b.category_id]
    if (!c) return null
    return c.parent_id ? catById[c.parent_id] : c
  }

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const list = bottles.filter(b => {
      const sub = catById[b.category_id]
      const main = mainOf(b)
      if (catId && main?.id !== catId) return false
      if (status && b.status !== status) return false
      if (placeMode && !status && b.status === 'empty') return false
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
    // Zuletzt erfasst: neueste Zugangsbuchung zuerst, Flaschen ohne Buchung ans Ende (stabil nach Name)
    if (sortBy === 'recent') list.sort((x, y) => (lastIn[y.id] || '').localeCompare(lastIn[x.id] || ''))
    return list
  }, [bottles, q, catId, status, roomId, locId, catById, roomById, locById, sortBy, lastIn, placeMode])

  const total = filtered.reduce((s, b) => s + (b.status === 'empty' ? 0 : b.quantity), 0)
  const roomLocs = locations.filter(l => l.room_id === roomId)

  function fail(error) {
    setMsg('Fehler: ' + error.message)
  }

  async function toggleReorder(b) {
    setMsg('')
    const { error } = await supabase.from('bottles').update({ reorder: !b.reorder }).eq('id', b.id)
    if (error) return setMsg('Fehler: ' + error.message)
    await reload()
  }

  // Öffnen: erst fragen, wohin die geöffnete Flasche kommt (offene Flaschen stehen meist woanders als der Stapel)
  function askOpen(b) {
    const roomOk = id => rooms.some(r => r.id === id)
    const locOk = (rid, lid) => locations.some(l => l.id === lid && l.room_id === rid)
    let roomId = lsGet('open_room') || ''
    let locId = lsGet('open_loc') || ''
    if (!roomOk(roomId) || (locId && !locOk(roomId, locId))) {
      const def = locations.find(l => l.default_status === 'open' && roomOk(l.room_id))
      roomId = def ? def.room_id : (b.room_id || '')
      locId = def ? def.id : (b.location_id || '')
    }
    setOpenAsk({ b, roomId, locId })
  }

  async function openOne(b, place) {
    setMsg('')
    setOpenAsk(null)
    const where = place ? { room_id: place.roomId || null, location_id: place.locId || null } : {}
    if (b.quantity > 1) {
      const { error: e1 } = await supabase.from('bottles').update({ quantity: b.quantity - 1 }).eq('id', b.id)
      if (e1) return fail(e1)
      const { id, created_at, updated_at, user_id, captured_at, ...copy } = b // Fotopfade werden mitkopiert (gleiche Dateien)
      const { error: e2 } = await supabase.from('bottles').insert({ ...copy, ...where, status: 'open', quantity: 1, fill_percent: 100 })
      if (e2) return fail(e2)
    } else {
      const { error: e1 } = await supabase.from('bottles').update({ status: 'open', fill_percent: 100, ...where }).eq('id', b.id)
      if (e1) return fail(e1)
    }
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'opened', quantity: -1 })
    reload()
  }

  // Öffnen rückgängig: zurück in einen geschlossenen Stapel desselben Produkts (egal an welchem Ort).
  // Gibt es mehrere Stapel, wird gefragt; gibt es keinen, bleibt die Flasche als geschlossene am jetzigen Ort.
  function undoOpen(b) {
    setMsg('')
    const key = productKey(b)
    const cands = b.quantity === 1 ? bottles.filter(x => x.id !== b.id && x.status === 'closed' && productKey(x) === key) : []
    if (cands.length > 1) { setUndoAsk({ b, cands }); return }
    doUndoOpen(b, cands[0] || null)
  }

  async function doUndoOpen(b, sib) {
    setUndoAsk(null)
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

  // Leer-Knopf: steht das Produkt nicht ohnehin auf der Einkaufsliste, kommt erst die Nachkauf-Frage
  function askEmpty(b) {
    const g = groups.get(productKey(b))
    if (g && (g.low || g.reorder)) {
      markEmpty(b, false)
      setMsg('Als leer markiert. Das Produkt steht schon auf der Einkaufsliste.')
      return
    }
    setEmptyAsk(b)
  }

  async function markEmpty(b, reorder) {
    setMsg('')
    setEmptyAsk(null)
    // Leere Flasche kommt in den Müll: Ort leeren, alten Ort in der Buchung merken (für „Zurück“)
    const oldRoom = b.room_id, oldLoc = b.location_id
    const upd = { status: 'empty', fill_percent: 0, room_id: null, location_id: null }
    if (reorder) upd.reorder = true
    const { error } = await supabase.from('bottles').update(upd).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'empty', quantity: -1, ...(oldRoom ? { notes: `Ort:${oldRoom}|${oldLoc || ''}` } : {}) })
    if (reorder) setMsg('Als leer markiert und auf die Einkaufsliste gesetzt.')
    reload()
  }

  // Leer rückgängig: Flasche war fast leer, daher zurück auf "offen" mit 10 %
  async function undoEmpty(b) {
    setMsg('')
    const upd = { status: 'open', fill_percent: 10, reorder: false }
    // alten Ort aus der letzten Leer-Buchung wiederherstellen (falls es ihn noch gibt)
    if (!b.room_id) {
      const { data: mv } = await supabase.from('movements').select('notes').eq('bottle_id', b.id).eq('type', 'empty').order('moved_at', { ascending: false }).limit(1)
      const m = /^Ort:([0-9a-f-]+)\|([0-9a-f-]*)$/i.exec(mv?.[0]?.notes || '')
      if (m && rooms.some(r => r.id === m[1])) {
        upd.room_id = m[1]
        upd.location_id = m[2] && locations.some(l => l.id === m[2] && l.room_id === m[1]) ? m[2] : null
      }
    }
    const { error } = await supabase.from('bottles').update(upd).eq('id', b.id)
    if (error) return fail(error)
    await supabase.from('movements').insert({ bottle_id: b.id, type: 'adjustment', quantity: 1, notes: 'Leer rückgängig' })
    reload()
  }

  // Alle Fotos einer Flasche groß anzeigen
  async function openGallery(b) {
    const slots = [[b.image_front, 'Vorderseite'], [b.image_back, 'Rückseite'], [b.image_side, 'Seite']].filter(x => x[0])
    if (slots.length === 0) return
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(slots.map(x => x[0]), 3600)
    if (error) return fail(error)
    const map = {}
    ;(data || []).forEach(x => { if (x.signedUrl) map[x.path] = x.signedUrl })
    const images = slots.filter(x => map[x[0]]).map(x => ({ url: map[x[0]], label: x[1] }))
    if (images.length > 0) setGallery({ images })
  }

  // Ganzen Eintrag löschen (mit Bildern)
  async function deleteEntry(b) {
    setMsg('')
    const used = pathsInUse(bottles, [b.id])
    const paths = [b.image_front, b.image_back, b.image_side, b.image_thumb].filter(x => x && !used.has(x))
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

  const placeName = [roomById[roomId]?.name, locId ? locById[locId]?.name : null].filter(Boolean).join(' › ')
  function clearPlace() { setPlaceMode(false); setRoomId(''); setLocId('') }

  return (
    <>
      {placeMode && roomId && (
        <div className="place-banner">
          <div>
            <span>Inhalt von</span>
            <b>{placeName}</b>
            <small>Leere Flaschen sind ausgeblendet.</small>
          </div>
          <button type="button" onClick={clearPlace}>Alle anzeigen</button>
        </div>
      )}
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
        <div className="filter-row">
          <select value={sortBy} onChange={e => { setSortBy(e.target.value); lsSet('sort', e.target.value) }} aria-label="Sortierung">
            <option value="name">Sortierung: Name (A–Z)</option>
            <option value="recent">Sortierung: Zuletzt erfasst</option>
          </select>
        </div>
        <div className="count">{filtered.length} Einträge · {total} Flaschen</div>
        <div className="sel-toggle">
          {!selMode && <button type="button" className="ghost" onClick={() => { setSelMode(true); setMoved('') }}>Mehrere auswählen</button>}
          {selMode && <button type="button" className="ghost" onClick={endSelect}>Auswahl beenden</button>}
        </div>
      </div>

      {msg && <div className={'msg' + (msg.startsWith('Fehler') ? ' error' : '')}>{msg}</div>}
      {moved && !selMode && <div className="msg">{moved}</div>}
      {selMode && (
        <div className="sel-bar">
          <div className="sel-count">{sel.size} ausgewählt</div>
          <div className="sel-btns">
            <button type="button" onClick={() => setSel(new Set(filtered.map(b => b.id)))}>Alle {filtered.length} gefilterten</button>
            <button type="button" disabled={sel.size === 0} onClick={() => setSel(new Set())}>Keine</button>
            <button type="button" className="primary" disabled={sel.size === 0} onClick={() => setMvOpen(v => !v)}>Verschieben…</button>
            <button type="button" className="primary" disabled={sel.size < 2} onClick={startMerge}>Zusammenführen…</button>
          </div>
          {mvOpen && sel.size > 0 && (
            <div className="sel-move">
              <select value={mvRoom} onChange={e => { setMvRoom(e.target.value); setMvLoc('') }}>
                <option value="">Neuer Raum *</option>
                {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {mvRoom && (
                <select value={mvLoc} onChange={e => setMvLoc(e.target.value)}>
                  <option value="">– kein Ort –</option>
                  {locations.filter(l => l.room_id === mvRoom).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              <button type="button" className="primary" disabled={!mvRoom || mvBusy} onClick={moveSelected}>
                {mvBusy ? 'Verschiebt…' : `${sel.size} ${sel.size === 1 ? 'Eintrag' : 'Einträge'} verschieben`}
              </button>
              <div className="hint">Neue Räume und Orte legst du unter Verwaltung → Lagerorte an.</div>
            </div>
          )}
        </div>
      )}
      {openAsk && (() => {
        const ob = openAsk.b
        const ols = locations.filter(l => l.room_id === openAsk.roomId)
        const here = [roomById[ob.room_id]?.name, locById[ob.location_id]?.name].filter(Boolean).join(' › ') || 'ohne Ort'
        const confirmOpen = () => {
          if (openAsk.roomId) lsSet('open_room', openAsk.roomId)
          lsSet('open_loc', openAsk.locId || '')
          openOne(ob, { roomId: openAsk.roomId, locId: openAsk.locId })
        }
        return (
          <div className="ask-back" onClick={() => setOpenAsk(null)}>
            <div className="ask-card" onClick={e => e.stopPropagation()}>
              <h3>Wohin kommt die Flasche?</h3>
              <p><b>{ob.brand} {ob.name}</b> wird geöffnet. Bisher: {here}{ob.quantity > 1 ? `, ${ob.quantity}× geschlossen` : ''}.</p>
              <label className="fld"><span>Raum</span>
                <select value={openAsk.roomId} onChange={e => setOpenAsk({ ...openAsk, roomId: e.target.value, locId: '' })}>
                  <option value="">– kein Raum –</option>
                  {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label className="fld"><span>Ort</span>
                <select value={openAsk.locId} onChange={e => setOpenAsk({ ...openAsk, locId: e.target.value })} disabled={!openAsk.roomId || ols.length === 0}>
                  <option value="">{ols.length === 0 ? '–' : '– kein Ort –'}</option>
                  {ols.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <button className="save-btn" onClick={confirmOpen}>Öffnen und dorthin stellen</button>
              <button className="ghost-btn" style={{ marginTop: 0 }} onClick={() => openOne(ob, null)}>Öffnen, am alten Ort lassen</button>
              <button className="link-back" onClick={() => setOpenAsk(null)}>Abbrechen</button>
            </div>
          </div>
        )
      })()}
      {undoAsk && (() => {
        const ub = undoAsk.b
        const placeOf = x => [roomById[x.room_id]?.name, locById[x.location_id]?.name].filter(Boolean).join(' › ') || 'ohne Ort'
        return (
          <div className="ask-back" onClick={() => setUndoAsk(null)}>
            <div className="ask-card" onClick={e => e.stopPropagation()}>
              <h3>Zu welchem Stapel zurück?</h3>
              <p><b>{ub.brand} {ub.name}</b> gibt es geschlossen an mehreren Orten.</p>
              <div className="ask-reserve">
                {undoAsk.cands.map(x => <button type="button" key={x.id} onClick={() => doUndoOpen(ub, x)}>{x.quantity}× geschlossen · {placeOf(x)}</button>)}
              </div>
              <button className="ghost-btn" style={{ marginTop: 0 }} onClick={() => doUndoOpen(ub, null)}>Geschlossen hier lassen ({placeOf(ub)})</button>
              <button className="link-back" onClick={() => setUndoAsk(null)}>Abbrechen</button>
            </div>
          </div>
        )
      })()}
      {mergeAsk && (() => {
        const list = selected()
        const keep = list.find(b => b.id === mergeAsk.keepId) || list[0]
        const others = list.filter(b => b.id !== keep.id)
        const plan = mergePlan(keep, others)
        const placeOf = x => [roomById[x.room_id]?.name, locById[x.location_id]?.name].filter(Boolean).join(' › ') || 'ohne Ort'
        const keys = new Set(list.map(productKey))
        const farAway = plan.closedOthers ? plan.closedOthers.filter(o => placeOf(o) !== placeOf(keep)) : []
        return (
          <div className="ask-back" onClick={() => !mergeBusy && setMergeAsk(null)}>
            <div className="ask-card" onClick={e => e.stopPropagation()}>
              <h3>Einträge zusammenführen</h3>
              <p>Welcher Eintrag soll bleiben?</p>
              <div className="ask-reserve">
                {list.map(x => (
                  <label key={x.id} className="qr-row">
                    <input type="radio" name="keep" checked={x.id === keep.id} onChange={() => setMergeAsk({ keepId: x.id })} />
                    <span><b>{x.brand} {x.name}</b> · {STATUS[x.status]} ×{x.quantity} · {placeOf(x)}{x.image_front ? ' · mit Foto' : ''}</span>
                  </label>
                ))}
              </div>
              {plan.error
                ? <div className="msg error">{plan.error}</div>
                : (
                  <div className="hint need-t">
                    {plan.addQty > 0 ? `${plan.addQty} geschlossene ${plan.addQty === 1 ? 'Flasche kommt' : 'Flaschen kommen'} dazu (danach ${keep.quantity + plan.addQty}×). ` : ''}
                    {others.length} {others.length === 1 ? 'anderer Eintrag entfällt' : 'andere Einträge entfallen'}. Buchungen, fehlende Angaben und Fotos werden übernommen.
                    {farAway.length > 0 ? ` Hinweis: Flaschen von anderem Ort kommen nach ${placeOf(keep)}.` : ''}
                    {keys.size > 1 ? ' Achtung: Name oder Größe unterscheiden sich, es bleiben die Angaben des gewählten Eintrags.' : ''}
                  </div>
                )}
              <button className="save-btn" disabled={!!plan.error || mergeBusy} onClick={doMerge}>{mergeBusy ? 'Führt zusammen…' : 'Zusammenführen'}</button>
              <button className="link-back" disabled={mergeBusy} onClick={() => setMergeAsk(null)}>Abbrechen</button>
            </div>
          </div>
        )
      })()}
      {emptyAsk && (() => {
        const eb = emptyAsk
        const g = groups.get(productKey(eb))
        const reserve = (g ? g.entries : []).filter(x => x.id !== eb.id && x.status !== 'empty')
          .sort((x, y) => (x.status === 'closed' ? 0 : 1) - (y.status === 'closed' ? 0 : 1))
        const placeOf = x => [roomById[x.room_id]?.name, locById[x.location_id]?.name].filter(Boolean).join(' › ') || 'ohne Ort'
        return (
          <div className="ask-back" onClick={() => setEmptyAsk(null)}>
            <div className="ask-card" onClick={e => e.stopPropagation()}>
              <h3>Nachkaufen?</h3>
              <p><b>{eb.brand} {eb.name}</b> wird als leer markiert. Soll es auf die Einkaufsliste?</p>
              {reserve.length > 0
                ? (
                  <div className="ask-reserve">
                    <div className="count">Noch vorhanden – antippen zeigt Details</div>
                    {reserve.map(x => (
                      <button type="button" key={x.id} onClick={() => setInfoId(x.id)}>
                        {x.quantity}× {x.status === 'closed' ? 'geschlossen' : `offen (${x.fill_percent} %)`} · {placeOf(x)}
                      </button>
                    ))}
                  </div>
                )
                : <div className="hint need-t">Keine weitere Flasche dieses Produkts im Bestand.</div>}
              <button className="save-btn" onClick={() => markEmpty(eb, true)}>Ja, auf die Einkaufsliste</button>
              <button className="ghost-btn" style={{ marginTop: 0 }} onClick={() => markEmpty(eb, false)}>Nein, nur leer markieren</button>
              <button className="link-back" onClick={() => setEmptyAsk(null)}>Abbrechen</button>
            </div>
          </div>
        )
      })()}
      {gallery && <Lightbox images={gallery.images} onClose={() => setGallery(null)} />}
      {(() => {
        const ib = infoId ? bottles.find(x => x.id === infoId) : null
        if (!ib) return null
        const sub = catById[ib.category_id]
        const main = mainOf(ib)
        return (
          <BottleInfo b={ib} thumb={ib.image_thumb ? thumbs[ib.image_thumb] : null}
            place={[roomById[ib.room_id]?.name, locById[ib.location_id]?.name].filter(Boolean).join(' › ')}
            cat={[main?.name, sub && sub.id !== main?.id ? sub.name : null].filter(Boolean).join(' · ')}
            group={groups.get(productKey(ib))} lastIn={lastIn[ib.id]}
            onClose={() => setInfoId(null)} onEdit={() => { setInfoId(null); onEdit(ib.id) }}
            onGallery={() => openGallery(ib)} />
        )
      })()}

      {filtered.length === 0 && (
        <div className="empty">{bottles.length === 0 ? 'Noch keine Flaschen eingetragen.' : 'Keine Treffer für diese Filter.'}</div>
      )}

      {filtered.slice(0, limit).map(b => {
        const sub = catById[b.category_id]
        const main = mainOf(b)
        const label = abvLabel(b.abv)
        const place = [roomById[b.room_id]?.name, locById[b.location_id]?.name].filter(Boolean).join(' › ')
        const thumb = b.image_thumb ? thumbs[b.image_thumb] : null
        const g = groups.get(productKey(b))
        // Mindestbestand gilt je Produkt: Tag nur an nicht leeren Einträgen (oder am Hauptstück, wenn alles leer ist)
        const showLow = !!g && g.low && !g.reorder && (b.status !== 'empty' || (g.live === 0 && g.rep.id === b.id))
        return (
          <div key={b.id} className={'card' + (b.status === 'empty' ? ' dim' : '') + (selMode && sel.has(b.id) ? ' picked' : '')}>
            {selMode && (
              <label className="sel-check" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={sel.has(b.id)} onChange={() => toggleSel(b.id)} />
              </label>
            )}
            <div className={'card-icon' + (thumb ? ' has-thumb zoomable' : '')} onClick={thumb ? () => openGallery(b) : undefined}>
              {thumb ? <img className="thumb" src={thumb} alt="" loading="lazy" /> : <BottleIcon />}
            </div>
            <div className="card-info">
              <h3 className="name-link" role="button" tabIndex={0} title="Details anzeigen"
                onClick={() => { if (!selMode) setInfoId(b.id) }}
                onKeyDown={e => { if (e.key === 'Enter' && !selMode) setInfoId(b.id) }}>{b.brand} {b.name}{b.vintage ? ` (${b.vintage})` : ''}</h3>
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
                {showLow && <span className="tag warn">Unter Mindestbestand ({g.closed}/{g.min})</span>}
                <button type="button" className={'tag tag-btn' + (b.reorder ? ' on' : '')} onClick={() => toggleReorder(b)}>{b.reorder ? 'Vorgemerkt ✓' : '+ Nachkaufen'}</button>
              </div>
            </div>
            {delId !== b.id && !selMode && (
              <div className="actions full">
                {b.status === 'closed' && <button onClick={() => askOpen(b)}>Öffnen</button>}
                {b.status === 'open' && <button onClick={() => askEmpty(b)}>Leer</button>}
                {b.status === 'open' && <button className="ghost" onClick={() => undoOpen(b)}>Zurück</button>}
                {b.status === 'empty' && <button className="ghost" onClick={() => undoEmpty(b)}>Zurück</button>}
                <button className="ghost" onClick={() => onEdit(b.id)}>Bearbeiten</button>
                <button className="ghost del icon" aria-label="Löschen" title="Löschen" onClick={() => setDelId(b.id)}><TrashIcon /></button>
              </div>
            )}
            {delId === b.id && (
              <div className="del-confirm full">
                <p>{b.quantity > 1 ? `Dieser Eintrag hat ${b.quantity} Flaschen. Was soll gelöscht werden?` : 'Wirklich löschen? Die Flasche und ihre Bilder werden endgültig entfernt.'}</p>
                <div className="actions">
                  {b.quantity > 1 && <button className="danger" onClick={() => deleteOne(b)}>1 Flasche</button>}
                  <button className="danger" onClick={() => deleteEntry(b)}>{b.quantity > 1 ? `Alle ${b.quantity}` : 'Ja, löschen'}</button>
                  <button className="ghost" onClick={() => setDelId(null)}>Abbrechen</button>
                </div>
              </div>
            )}
          </div>
        )
      })}
      {filtered.length > limit && (
        <button type="button" className="scan-btn secondary more-btn" onClick={() => setLimit(l => l + 60)}>
          Mehr anzeigen ({filtered.length - limit} weitere)
        </button>
      )}
    </>
  )
}

/* ---------- Lagerorte ---------- */

/* ---------- Scanner ---------- */

const camIsFront = d => /front|user|selfie|vorn/i.test(d.label || '')

function Scanner({ onCode, onLabel, onManual, compact = false, autoStart = false, onClose }) {
  const videoRef = useRef(null)
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
  const [zoomCaps, setZoomCaps] = useState(null)
  const [zoom, setZoom] = useState(1)
  const photoRef = useRef(null)
  const [labelOpen, setLabelOpen] = useState(false)
  const [lf, setLf] = useState({ front: null, back: null })
  const [lp, setLp] = useState({ front: null, back: null })

  function stop() {
    activeRef.current = false
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    trackRef.current = null
    setScanning(false)
    setTorchOn(false)
    setZoomCaps(null)
  }

  useEffect(() => { if (autoStart) start(); return () => stop() }, [])
  const tabActive = useContext(TabActive)
  useEffect(() => { if (!tabActive) stop() }, [tabActive])

  async function handle(code) {
    setBusy(true)
    setInfo(parsePlaceCode(code) ? 'Orts-Code erkannt…' : `Code ${code} erkannt – suche Produktdaten…`)
    await onCode(code)
    setInfo('')
    setBusy(false)
  }

  // Etikett fotografieren: Vorder- und Rückseite, beide zusammen an die KI, danach Formular
  function pickLabel(slot, file) {
    setLf(prev => ({ ...prev, [slot]: file }))
    setLp(prev => ({ ...prev, [slot]: URL.createObjectURL(file) }))
  }
  function clearLabel(slot) {
    setLf(prev => ({ ...prev, [slot]: null }))
    setLp(prev => ({ ...prev, [slot]: null }))
  }
  function closeLabel() {
    setLabelOpen(false)
    setLf({ front: null, back: null })
    setLp({ front: null, back: null })
    setInfo('')
  }
  async function evaluateLabel() {
    if (!lf.front) return setInfo('Bitte zuerst die Vorderseite fotografieren.')
    setBusy(true)
    setInfo('Etikett wird ausgewertet… das dauert einige Sekunden.')
    const err = await onLabel({ front: lf.front, back: lf.back })
    if (err) setInfo(err)
    setBusy(false)
  }

  async function barcodePhoto(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    stop()
    setBusy(true)
    setInfo('Foto wird gelesen…')
    try {
      const code = await decodeFromFile(file)
      if (code) { setBusy(false); await handle(code); return }
      setInfo('Auf dem Foto wurde kein Barcode erkannt. Bitte den Strichcode näher, gerade und scharf fotografieren oder den Code unten eintippen.')
    } catch {
      setInfo('Das Foto konnte nicht gelesen werden. Bitte den Code unten eintippen.')
    }
    setBusy(false)
  }

  async function start(deviceId, forceWasm) {
    setInfo('')
    stop()
    try {
      const wanted = deviceId || lsGet('cam_id') || ''
      const base = { width: { ideal: 1920 }, height: { ideal: 1080 } }
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...base, ...(wanted ? { deviceId: { exact: wanted } } : { facingMode: { ideal: 'environment' } }) },
        })
      } catch (err) {
        if (!wanted) throw err
        lsSet('cam_id', '')
        stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: 'environment' } } })
      }
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
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 })
        setZoom(caps.zoom.min)
      }

      try {
        const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
        const sorted = [...all.filter(d => !camIsFront(d)), ...all.filter(camIsFront)]
        setDevices(sorted)
        const cur = track.getSettings ? track.getSettings().deviceId : null
        const idx = sorted.findIndex(d => d.deviceId === cur)
        setDevIdx(idx >= 0 ? idx : 0)
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
          const code = pickCode(found)
          if (code) {
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

  async function changeZoom(v) {
    setZoom(v)
    const t = trackRef.current
    if (!t) return
    try { await t.applyConstraints({ advanced: [{ zoom: v }] }) } catch { /* nicht unterstützt */ }
  }

  function nextCamera() {
    if (devices.length < 2) return
    const idx = (devIdx + 1) % devices.length
    setDevIdx(idx)
    lsSet('cam_id', devices[idx].deviceId)
    start(devices[idx].deviceId)
  }

  function toggleCompat() {
    const next = !compat
    setCompat(next)
    if (scanning) start(devices[devIdx]?.deviceId, next)
  }

  if (labelOpen) {
    return (
      <div className="scanner-box">
        <h3>Etikett fotografieren</h3>
        <p>Die Vorderseite ist Pflicht. Die Rückseite hilft, weil dort oft Alkoholgehalt und Füllmenge stehen.</p>
        <div className="img-grid two-up">
          <ImageSlot label="Vorderseite" url={lp.front} onPick={f => pickLabel('front', f)} onRemove={() => clearLabel('front')} />
          <ImageSlot label="Rückseite" url={lp.back} onPick={f => pickLabel('back', f)} onRemove={() => clearLabel('back')} />
        </div>
        <button className="scan-btn label-btn" onClick={evaluateLabel} disabled={busy}>{busy ? 'Wertet aus…' : 'Auswerten (KI)'}</button>
        <button className="scan-btn secondary label-btn" onClick={closeLabel} disabled={busy}>Abbrechen</button>
        {info && <div className="msg">{info}</div>}
      </div>
    )
  }

  const camName = devices.length > 1 ? `Kamera ${devIdx + 1} von ${devices.length}${devices[devIdx] && camIsFront(devices[devIdx]) ? ' (vorne)' : ' (hinten)'}` : ''
  const zoomBox = scanning && zoomCaps && (
    <label className="zoom-row">Zoom
      <input type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step} value={zoom} onChange={e => changeZoom(Number(e.target.value))} />
    </label>
  )
  const photoInput = <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden onChange={barcodePhoto} />

  const manualBox = (
    <div className="inline-add manual">
      <input inputMode="numeric" placeholder="Code manuell eingeben (8, 12 oder 13 Ziffern)" value={manual} onChange={e => setManual(e.target.value)} />
      <button disabled={busy} onClick={() => manual.trim() && handle(manual.trim())}>Suchen</button>
    </div>
  )

  if (compact) {
    return (
      <div className="scanner-box compact">
        <video ref={videoRef} playsInline muted onClick={tapFocus} style={{ display: scanning ? 'block' : 'none' }} />
        {!scanning && <button className="scan-btn label-btn" onClick={() => photoRef.current?.click()} disabled={busy}>Barcode fotografieren</button>}
        {!scanning && <button className="scan-btn secondary label-btn" onClick={() => start()} disabled={busy}>Barcode Scanner starten</button>}
        {photoInput}
        {scanning && camName && <div className="cam-name">{camName}</div>}
        {zoomBox}
        <div className="scan-tools">
          {scanning && torchOk && <button onClick={toggleTorch}>{torchOn ? 'Licht aus' : 'Licht an'}</button>}
          {scanning && devices.length > 1 && <button onClick={nextCamera}>Kamera wechseln</button>}
          {scanning && <button onClick={toggleCompat}>{compat ? 'Standard-Scanner' : 'Kompatibler Scanner'}</button>}
          <button onClick={() => { stop(); onClose && onClose() }}>{scanning ? 'Abbrechen' : 'Schließen'}</button>
        </div>
        {manualBox}
        {info && <div className="msg">{info}</div>}
      </div>
    )
  }

  return (
    <div className="scanner-box">
      <h3>Flasche erfassen</h3>
      <p>Am zuverlässigsten: den Strichcode fotografieren, die App liest ihn aus dem Foto. Alternativ den Barcode Scanner mit laufender Kamera starten. Ohne Barcode: das Etikett fotografieren, die KI liest die Daten ab. Oder alles von Hand eintragen.</p>
      {!scanning && <button className="scan-btn" onClick={() => photoRef.current?.click()} disabled={busy}>Barcode fotografieren</button>}
      {!scanning && <button className="scan-btn secondary label-btn" onClick={() => start()} disabled={busy}>Barcode Scanner starten</button>}
      {!scanning && <button className="scan-btn secondary label-btn" onClick={() => setLabelOpen(true)} disabled={busy}>Etikett fotografieren (KI)</button>}
      {!scanning && onManual && <button className="scan-btn secondary label-btn" onClick={onManual} disabled={busy}>Von Hand eintragen</button>}
      {photoInput}
      <video ref={videoRef} playsInline muted onClick={tapFocus} style={{ display: scanning ? 'block' : 'none' }} />
      {scanning && camName && <div className="cam-name">{camName}</div>}
      {zoomBox}
      {scanning && (
        <div className="scan-tools">
          {torchOk && <button onClick={toggleTorch}>{torchOn ? 'Licht aus' : 'Licht an'}</button>}
          {devices.length > 1 && <button onClick={nextCamera}>Kamera wechseln</button>}
          <button onClick={toggleCompat}>{compat ? 'Standard-Scanner' : 'Kompatibler Scanner'}</button>
          <button onClick={stop}>Abbrechen</button>
        </div>
      )}
      {manualBox}
      {info && <div className="msg">{info}</div>}
    </div>
  )
}

/* ---------- KI-Auswertung (gemeinsam für Formular und Erfassen-Tab) ---------- */


// KI-Ergebnis in Vorbelegungs-Daten für das Formular umwandeln
/* ---------- Formular: Flasche anlegen oder bearbeiten ---------- */

function initialForm(bottle, prefill, cats, series = { roomId: '', locId: '' }) {
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
    roomId: edit ? (bottle.room_id || '') : (series.roomId || ''),
    locId: edit ? (bottle.location_id || '') : (series.locId || ''),
    newRoom: '', newLoc: '',
    is_collection: !!src.is_collection,
    is_sample: edit ? bottle.is_sample : false,
    is_purchase: false,
    min_stock: src.min_stock === null || src.min_stock === undefined ? '' : String(src.min_stock),
    reorder: edit ? !!bottle.reorder : false,
    last_price: edit && bottle.last_price !== null && bottle.last_price !== undefined ? String(bottle.last_price) : '',
    barcode: src.barcode || '',
    notes: edit ? (bottle.notes || '') : (src.noteText || ''),
  }
}

const SLOTS = [['front', 'Vorderseite'], ['back', 'Rückseite'], ['side', 'Seite (Füllstand)']]

function ImageSlot({ label, url, onPick, onRemove, onZoom }) {
  const camRef = useRef(null)
  const galRef = useRef(null)
  const take = e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }
  return (
    <div className="img-slot">
      <div className={'img-box' + (url ? ' zoom' : '')} onClick={() => (url && onZoom ? onZoom() : camRef.current?.click())}>
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

function BottleForm({ userId, bottle, prefill, cats, rooms, locations, lookups, bottles = [], reload, onDone, series, onSeries, onFinish, onNext, onBack }) {
  const edit = !!bottle
  const mains = cats.filter(c => !c.parent_id)
  const touchedRef = useRef(!!series?.touched)
  const [f, setF] = useState(() => {
    const base = initialForm(bottle, prefill, cats, series)
    if (!bottle) {
      if (series?.touched) base.status = series.status || base.status   // Füllstand startet bei jeder neuen Flasche wieder bei 100 %
      else {
        const l = locations.find(x => x.id === base.locId)
        if (l?.default_status === 'open') base.status = 'open'
      }
    }
    return base
  })
  const [msg, setMsg] = useState(prefill?.note || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [zoomIdx, setZoomIdx] = useState(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [done, setDone] = useState(null)
  const [keepOld, setKeepOld] = useState(true)
  const fRef = useRef(null)

  // Bilder: pro Platz entweder vorhandener Pfad, neue Datei oder entfernt
  const [imgs, setImgs] = useState(() => ({
    front: { path: bottle?.image_front || null, file: prefill?.frontFile || null, preview: prefill?.frontFile ? URL.createObjectURL(prefill.frontFile) : null, removed: false },
    back: { path: bottle?.image_back || null, file: prefill?.backFile || null, preview: prefill?.backFile ? URL.createObjectURL(prefill.backFile) : null, removed: false },
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
    warmImage(file, slot === 'front')
    setImgs(prev => ({ ...prev, [slot]: { ...prev[slot], file, preview: URL.createObjectURL(file), removed: false } }))
  }
  function removeImage(slot) {
    setImgs(prev => ({ ...prev, [slot]: { path: prev[slot].path, file: null, preview: null, removed: true } }))
  }
  const zoomList = SLOTS.map(([slot, label]) => ({ slot, label, url: slotUrl(slot) })).filter(z => z.url)

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
    const stamp = Date.now()
    const upload = async (path, file, maxSide, quality) => {
      const blob = await resizeCached(file, maxSide, quality)
      const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
      if (up.error) throw up.error
    }
    // Alle Bilder (und das Vorschaubild) gleichzeitig hochladen statt nacheinander
    const jobs = []
    for (const [slot] of SLOTS) {
      const s = imgs[slot]
      if (s.file) {
        const path = `${userId}/${bottleId}/${slot}-${stamp}.jpg`
        jobs.push(upload(path, s.file, 1000, 0.8))
        update[`image_${slot}`] = path
        if (s.path) toDelete.push(s.path)
        if (slot === 'front') {
          const tpath = `${userId}/${bottleId}/thumb-${stamp}.jpg`
          jobs.push(upload(tpath, s.file, 240, 0.7))
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
    await Promise.all(jobs)
    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from('bottles').update(update).eq('id', bottleId)
      if (error) throw error
    }
    if (toDelete.length > 0) {
      const used = pathsInUse(bottles, [bottleId])
      const del = toDelete.filter(x => !used.has(x))
      if (del.length > 0) await supabase.storage.from(BUCKET).remove(del)
    }
  }

  // Foto-Auswertung mit Claude (über die Supabase-Funktion analyze-label)
  function applyAi(r, keep = false, src = 'dem Foto') {
    if (!r) throw new Error('Keine Antwort erhalten')
    const cur = fRef.current
    const next = { ...cur }
    const filled = []
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
    // keep = vorhandene Angaben behalten, nur leere Felder ergänzen
    const take = isSet => !(keep && isSet)

    if (r.brand && take(String(cur.brand).trim())) { next.brand = r.brand; filled.push('Marke') }
    if (r.name && take(String(cur.name).trim())) { next.name = r.name; filled.push('Name') }

    const m = r.main_category ? mains.find(c => same(c.name, r.main_category)) : null
    if (m && take(cur.mainId)) {
      next.mainId = m.id
      const s = r.sub_category ? cats.find(c => c.parent_id === m.id && same(c.name, r.sub_category)) : null
      next.subId = s ? s.id : ''
      filled.push(s ? 'Kategorie und Subkategorie' : 'Kategorie')
    }

    if (r.abv !== null && r.abv !== undefined && take(String(cur.abv) !== '')) { next.abv = String(r.abv); filled.push('Alkoholgehalt') }
    if (r.size_ml && take(edit || cur.size !== '700' || !!cur.customSize)) {
      if (SIZES.includes(r.size_ml)) { next.size = String(r.size_ml); next.customSize = '' }
      else { next.size = 'other'; next.customSize = String(r.size_ml) }
      filled.push('Größe')
    }
    if (r.vintage && take(String(cur.vintage).trim())) { next.vintage = r.vintage; filled.push('Jahrgang') }

    if (r.country && take(cur.country)) {
      const known = lookups.find(l => l.kind === 'country' && same(l.name, r.country))
      if (known) { next.country = known.name; next.newCountry = '' }
      else { next.country = '__new'; next.newCountry = r.country }
      filled.push('Herkunftsland')
    }
    if (r.region && take(cur.region)) {
      const country = next.country === '__new' ? next.newCountry : next.country
      const known = lookups.find(l => l.kind === 'region' && same(l.name, r.region) && (!l.country || !country || l.country === country))
      if (known) { next.region = known.name; next.newRegion = '' }
      else { next.region = '__new'; next.newRegion = r.region }
      filled.push('Region / Stil')
    }
    if (r.notes && !next.notes) { next.notes = r.notes; filled.push('Notiz') }

    setF(next)
    setMsg(filled.length > 0
      ? `Aus ${src} ${keep ? 'ergänzt' : 'übernommen'}: ${filled.join(', ')}. Bitte alles prüfen.`
      : (keep ? 'Es wurde nichts ergänzt, alle erkannten Felder sind schon befüllt.' : 'Auf dem Foto konnte nichts sicher erkannt werden.'))
  }

  async function analyze() {
    setError('')
    setMsg('')
    const hasAny = SLOTS.some(([slot]) => imgs[slot].file || (slot !== 'side' && !imgs[slot].removed && imgs[slot].path))
    if (!hasAny) return setError('Bitte zuerst mindestens ein Foto auswählen.')
    setAnalyzing(true)
    try {
      // neue Fotos nehmen, sonst die gespeicherten Fotos der Flasche laden
      const files = []
      for (const [slot] of SLOTS) {
        const s = imgs[slot]
        if (s.file) files.push(s.file)
        else if (!s.removed && s.path && slot !== 'side') {
          const dl = await supabase.storage.from(BUCKET).download(s.path)
          if (dl.error) throw new Error('Gespeichertes Foto konnte nicht geladen werden: ' + dl.error.message)
          files.push(dl.data)
        }
      }
      const result = await runAnalyze(files, cats, lookups)
      applyAi(result, edit && keepOld)
    } catch (e) {
      setError('Auswertung fehlgeschlagen: ' + e.message)
    }
    setAnalyzing(false)
  }

  // Barcode im Web suchen (KI mit Websuche, kostet ein paar Cent, nur auf Knopfdruck)
  async function searchBarcodeAi() {
    const ean = digitsOnly(f.barcode)
    if (!ean) return setError('Bitte zuerst einen Barcode eintragen.')
    setError(''); setMsg(''); setSearching(true)
    try {
      const mainsList = cats.filter(c => !c.parent_id)
      const taxonomy = {
        categories: Object.fromEntries(mainsList.map(c => [c.name, cats.filter(x => x.parent_id === c.id).map(x => x.name)])),
        countries: lookups.filter(l => l.kind === 'country').map(l => l.name),
        regions: [...new Set(lookups.filter(l => l.kind === 'region').map(l => l.name))],
      }
      const { data, error: fnError } = await supabase.functions.invoke('lookup-barcode', { body: { ean, taxonomy } })
      if (fnError) {
        let detail = fnError.message
        try { const j = await fnError.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
        throw new Error(detail)
      }
      if (data?.error) throw new Error(data.error)
      const r = data?.result
      if (!r || !r.found) {
        setMsg('Zu diesem Code wurde im Web kein eindeutiges Produkt gefunden. Bitte das Etikett fotografieren oder von Hand ausfüllen.')
      } else {
        applyAi(r, edit ? keepOld : true, 'der Web-Suche')
        if (r.source_url) {
          let host = r.source_url
          try { host = new URL(r.source_url).hostname.replace(/^www\./, '') } catch { /* ignorieren */ }
          setMsg(m => `${m} Quelle: ${host}`)
        }
      }
    } catch (e) {
      setError('Web-Suche fehlgeschlagen: ' + e.message)
    }
    setSearching(false)
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
    if (f.roomId !== '__new' && roomLocs.length > 0 && !f.locId) return 'Bitte einen Ort wählen (Truhe, Kiste …).'
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
        reorder: !!f.reorder,
        last_price: f.last_price === '' || Number.isNaN(parseFloat(String(f.last_price).replace(',', '.'))) ? null : parseFloat(String(f.last_price).replace(',', '.')),
      }

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
      // Buchung, Vormerkung und Bilder laufen gleichzeitig
      const bookP = Promise.all([
        row.status === 'closed' ? clearReorderFor(bottles, row) : null,
        supabase.from('movements').insert({
          bottle_id: data.id,
          type: f.is_purchase ? 'purchase' : 'adjustment',
          quantity: qty,
          notes: f.is_purchase ? null : 'Erfassung',
        }),
      ])
      let imageProblem = ''
      const imgP = syncImages(data.id).catch(e => { imageProblem = ' Die Bilder konnten nicht hochgeladen werden: ' + e.message })
      await Promise.all([bookP, imgP])

      onSeries && onSeries(roomId, locationId || '', { touched: touchedRef.current, status: f.status })
      setDone({ title: `${row.brand} ${row.name}`, roomId, locId: locationId || '', imageProblem })
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
      const used = pathsInUse(bottles, [bottle.id])
      const paths = [bottle.image_front, bottle.image_back, bottle.image_side, bottle.image_thumb].filter(x => x && !used.has(x))
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

  function newBottle() {
    const blank = { path: null, file: null, preview: null, removed: false }
    const fresh = initialForm(null, null, cats, { roomId: done.roomId, locId: done.locId })
    fresh.status = touchedRef.current ? f.status : (locations.find(x => x.id === done.locId)?.default_status === 'open' ? 'open' : 'closed')
    setF(fresh)
    setImgs({ front: { ...blank }, back: { ...blank }, side: { ...blank } })
    setMsg('')
    setError('')
    setDone(null)
    window.scrollTo({ top: 0 })
  }

  // Barcode im Formular: Treffer füllen nur leere Felder
  async function onScanCode(raw) {
    setScanOpen(false)
    if (parsePlaceCode(raw)) { setError(''); setMsg('Das ist ein Orts-QR-Code, kein Flaschen-Barcode. Den Ort wählst du weiter unten aus.'); return }
    const data = await resolveCode(raw, bottles, cats)
    if (!data) return
    const patch = initialForm(null, data, cats)
    setF(prev => {
      const next = { ...prev }
      for (const k of ['brand', 'name', 'abv', 'vintage', 'country', 'region', 'min_stock']) {
        if (!prev[k] && patch[k]) next[k] = patch[k]
      }
      if (!prev.mainId && patch.mainId) { next.mainId = patch.mainId; next.subId = patch.subId }
      else if (prev.mainId === patch.mainId && !prev.subId && patch.subId) next.subId = patch.subId
      if (data.size_ml && prev.size === '700' && !prev.customSize) { next.size = patch.size; next.customSize = patch.customSize }
      if (patch.is_collection && !prev.is_collection) next.is_collection = true
      if (patch.newCountry && !prev.country) { next.country = patch.country; next.newCountry = patch.newCountry }
      next.barcode = patch.barcode
      return next
    })
    setMsg(data.note || '')
    setError('')
  }

  if (!edit && done) {
    return (
      <div className="form">
        <div className="msg">Gespeichert: {done.title}.{done.imageProblem}</div>
        {onNext && <button type="button" className="save-btn" onClick={onNext}>Nächste Flasche erfassen</button>}
        <button type="button" className={onNext ? 'scan-btn secondary' : 'save-btn'} style={onNext ? { width: '100%', marginTop: 0 } : undefined} onClick={newBottle}>Noch eine von Hand</button>
        <button type="button" className="scan-btn secondary" style={{ width: '100%', marginTop: 0 }} onClick={onFinish}>Zur Übersicht</button>
      </div>
    )
  }

  return (
    <div className="form">
      {!edit && onBack && <button type="button" className="link-back" onClick={onBack}>← Zurück zur Erfassung</button>}
      {!edit && !scanOpen && (
        <button type="button" className="scan-btn secondary" style={{ width: '100%', marginTop: 0 }} onClick={() => setScanOpen(true)}>Barcode scannen</button>
      )}
      {!edit && scanOpen && (
        <Scanner compact onCode={onScanCode} onClose={() => setScanOpen(false)} />
      )}
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
        <select value={f.status} onChange={e => { touchedRef.current = true; const v = e.target.value; setF(prev => ({ ...prev, status: v, ...(edit && bottle.status === 'empty' && v !== 'empty' ? { reorder: false } : {}) })) }}>
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
        <select value={locValid || f.locId === '__new' ? f.locId : ''} onChange={e => {
          const v = e.target.value
          setF(prev => {
            const next = { ...prev, locId: v }
            if (!edit && !touchedRef.current) {
              const l = locations.find(x => x.id === v)
              if (l) next.status = l.default_status === 'open' ? 'open' : 'closed'
            }
            return next
          })
        }}>
          <option value="">{roomLocs.length > 0 ? 'Ort wählen *' : '– kein Ort –'}</option>
          {roomLocs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="__new">+ Neuer Ort…</option>
        </select>
      )}
      {f.locId === '__new' && <input placeholder="Name des neuen Ortes, z. B. Kiste 4" value={f.newLoc} onChange={e => set('newLoc', e.target.value)} />}

      {zoomIdx !== null && zoomList.length > 0 && (
        <Lightbox images={zoomList} start={Math.max(0, zoomIdx)} onClose={() => setZoomIdx(null)} />
      )}
      <div className="img-grid">
        {SLOTS.map(([slot, label]) => (
          <ImageSlot key={slot} label={label} url={slotUrl(slot)} onPick={file => pickImage(slot, file)} onRemove={() => removeImage(slot)}
            onZoom={() => setZoomIdx(zoomList.findIndex(z => z.slot === slot))} />
        ))}
      </div>

      <button type="button" className="ai-btn" onClick={analyze} disabled={analyzing}>
        {analyzing ? 'Wertet aus…' : 'Foto auswerten (KI)'}
      </button>
      {edit && (
        <label className="check"><input type="checkbox" checked={keepOld} onChange={e => setKeepOld(e.target.checked)} /> Vorhandene Angaben behalten, nur leere Felder ergänzen</label>
      )}
      <p className="hint">Liest Marke, Name, Kategorie, Alkoholgehalt, Größe und Herkunft von den Fotos ab und füllt die Felder vor. {edit ? 'Ohne neue Fotos werden die gespeicherten Fotos der Flasche verwendet. ' : ''}{edit && keepOld ? 'Bereits eingetragene Angaben bleiben unverändert.' : 'Bereits eingetragene Produktdaten werden dabei ersetzt.'}</p>

      <input placeholder="Barcode (optional)" inputMode="numeric" value={f.barcode} onChange={e => set('barcode', e.target.value)} />
      {digitsOnly(f.barcode).length >= 8 && (
        <>
          <button type="button" className="ai-btn" onClick={searchBarcodeAi} disabled={searching}>
            {searching ? 'Sucht im Web…' : 'Barcode im Web suchen (KI)'}
          </button>
          <p className="hint">Sucht den Code per KI-Websuche, wenn die Datenbanken nichts kennen. Kostet ein paar Cent, deshalb nur auf Knopfdruck. {edit && keepOld ? 'Bereits eingetragene Angaben bleiben unverändert.' : 'Nur leere Felder werden ergänzt.'}</p>
        </>
      )}
      <input placeholder="Mindestbestand (optional)" type="number" min="0" value={f.min_stock} onChange={e => set('min_stock', e.target.value)} />
      <input placeholder="Letzter Einkaufspreis in € (optional)" inputMode="decimal" value={f.last_price} onChange={e => set('last_price', e.target.value)} />
      <input placeholder="Notizen (optional)" value={f.notes} onChange={e => set('notes', e.target.value)} />

      <label className="check"><input type="checkbox" checked={f.reorder} onChange={e => set('reorder', e.target.checked)} /> Zum Nachkaufen vormerken</label>
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
