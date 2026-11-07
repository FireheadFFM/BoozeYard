import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import './App.css'

const BottleIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
    <rect x="8" y="2" width="6" height="2" rx="1" fill="#c8891a"/>
    <rect x="9" y="4" width="4" height="2" rx="0.5" fill="#c8891a" opacity="0.6"/>
    <path d="M7 6C7 6 5 9 5 14a6 6 0 0012 0c0-5-2-8-2-8H7z" fill="#c8891a" opacity="0.2" stroke="#c8891a" stroke-width="1.2"/>
    <line x1="5.5" y1="12" x2="16.5" y2="12" stroke="#c8891a" stroke-width="0.8" opacity="0.5"/>
  </svg>
)

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

export default function App() {
  const [bottles, setBottles] = useState([])
  const [rooms, setRooms] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('bottles')

  useEffect(() => { fetchBottles(); fetchRooms() }, [])

  async function fetchBottles() {
    const { data, error } = await supabase.from('bottles').select('*, rooms(name)')
    if (!error) setBottles(data)
    setLoading(false)
  }

  async function fetchRooms() {
    const { data, error } = await supabase.from('rooms').select('*')
    if (!error) setRooms(data)
  }

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
      </header>

      <nav>
        <button onClick={() => setActiveTab('bottles')} className={activeTab === 'bottles' ? 'active' : ''}>Flaschen</button>
        <button onClick={() => setActiveTab('rooms')} className={activeTab === 'rooms' ? 'active' : ''}>Lagerorte</button>
        <button onClick={() => setActiveTab('scanner')} className={activeTab === 'scanner' ? 'active' : ''}>Scanner</button>
        <button onClick={() => setActiveTab('add')} className={activeTab === 'add' ? 'active' : ''}>+ Neu</button>
      </nav>

      <main>
        {loading && <div className="empty">Lädt...</div>}

        {!loading && activeTab === 'bottles' && (
          <>
            {bottles.length === 0
              ? <div className="empty">Noch keine Flaschen eingetragen.</div>
              : bottles.map(b => (
                <div key={b.id} className="card">
                  <div className="card-icon"><BottleIcon /></div>
                  <div className="card-info">
                    <h3>{b.name}</h3>
                    <p>{b.brand}{b.category ? ` · ${b.category}` : ''}</p>
                    <div className="fill-bar">
                      <div className="fill-bar-inner" style={{width: `${b.current_fill_percent}%`}} />
                    </div>
                    <span className="badge">{b.current_fill_percent}% · {b.rooms?.name || 'Kein Lagerort'}</span>
                  </div>
                </div>
              ))
            }
          </>
        )}

        {!loading && activeTab === 'rooms' && (
          <>
            {rooms.length === 0
              ? <div className="empty">Noch keine Lagerorte angelegt.</div>
              : rooms.map(r => (
                <div key={r.id} className="card">
                  <div className="card-info">
                    <h3>{r.name}</h3>
                    <p>{r.description || 'Kein Beschreibung'}</p>
                  </div>
                </div>
              ))
            }
          </>
        )}

        {activeTab === 'scanner' && (
          <Scanner onFound={(barcode) => { setActiveTab('add') }} />
        )}

        {activeTab === 'add' && (
          <AddForm rooms={rooms} onSave={() => { fetchBottles(); fetchRooms(); setActiveTab('bottles') }} />
        )}
      </main>
    </div>
  )
}

function Scanner({ onFound }) {
  const videoRef = useRef(null)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState(null)

  async function startScanner() {
    setScanning(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      videoRef.current.srcObject = stream
      videoRef.current.play()

      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] })

      const scan = async () => {
        if (!videoRef.current) return
        try {
          const barcodes = await detector.detect(videoRef.current)
          if (barcodes.length > 0) {
            const code = barcodes[0].rawValue
            setResult(code)
            stream.getTracks().forEach(t => t.stop())
            setScanning(false)
            onFound(code)
          } else {
            requestAnimationFrame(scan)
          }
        } catch { requestAnimationFrame(scan) }
      }
      requestAnimationFrame(scan)
    } catch (e) {
      setScanning(false)
      alert('Kamera konnte nicht gestartet werden.')
    }
  }

  return (
    <div className="scanner-box">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect x="6" y="6" width="8" height="8" rx="2" fill="#c8891a" opacity="0.3"/>
        <rect x="6" y="6" width="8" height="2" fill="#c8891a"/>
        <rect x="6" y="6" width="2" height="8" fill="#c8891a"/>
        <rect x="34" y="6" width="8" height="8" rx="2" fill="#c8891a" opacity="0.3"/>
        <rect x="40" y="6" width="2" height="8" fill="#c8891a"/>
        <rect x="34" y="6" width="8" height="2" fill="#c8891a"/>
        <rect x="6" y="34" width="8" height="8" rx="2" fill="#c8891a" opacity="0.3"/>
        <rect x="6" y="40" width="8" height="2" fill="#c8891a"/>
        <rect x="6" y="34" width="2" height="8" fill="#c8891a"/>
        <rect x="14" y="10" width="2" height="28" rx="1" fill="#c8891a" opacity="0.5"/>
        <rect x="18" y="10" width="1.5" height="28" rx="0.5" fill="#c8891a" opacity="0.7"/>
        <rect x="22" y="10" width="3" height="28" rx="1" fill="#c8891a"/>
        <rect x="28" y="10" width="1.5" height="28" rx="0.5" fill="#c8891a" opacity="0.6"/>
        <rect x="32" y="10" width="2" height="28" rx="1" fill="#c8891a" opacity="0.5"/>
      </svg>
      <h3>Barcode Scanner</h3>
      <p>Kamera auf Flaschenetikett richten</p>
      {!scanning && <button className="scan-btn" onClick={startScanner}>Kamera starten</button>}
      {scanning && <video ref={videoRef} playsInline muted />}
      {result && <div className="scan-result">Barcode erkannt: {result}</div>}
    </div>
  )
}

function AddForm({ rooms, onSave }) {
  const [type, setType] = useState('bottle')
  const [form, setForm] = useState({ current_fill_percent: 100 })

  async function handleSubmit() {
    if (!form.name) return alert('Name ist Pflichtfeld')
    if (type === 'bottle') {
      await supabase.from('bottles').insert([form])
    } else {
      await supabase.from('rooms').insert([{ name: form.name, description: form.description }])
    }
    onSave()
  }

  return (
    <div className="form">
      <div className="type-toggle">
        <button onClick={() => setType('bottle')} className={type === 'bottle' ? 'active' : ''}>Flasche</button>
        <button onClick={() => setType('room')} className={type === 'room' ? 'active' : ''}>Lagerort</button>
      </div>

      {type === 'bottle' && <>
        <input placeholder="Name *" onChange={e => setForm({...form, name: e.target.value})} />
        <input placeholder="Marke" onChange={e => setForm({...form, brand: e.target.value})} />
        <input placeholder="Kategorie (z.B. Whisky, Gin...)" onChange={e => setForm({...form, category: e.target.value})} />
        <input placeholder="Volumen in ml" type="number" onChange={e => setForm({...form, volume_ml: parseInt(e.target.value)})} />
        <input placeholder="Alkohol %" type="number" step="0.1" onChange={e => setForm({...form, alcohol_percent: parseFloat(e.target.value)})} />
        <select onChange={e => setForm({...form, room_id: e.target.value || null})}>
          <option value="">Lagerort wählen</option>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input placeholder="Füllstand %" type="number" min="0" max="100" defaultValue="100" onChange={e => setForm({...form, current_fill_percent: parseInt(e.target.value)})} />
      </>}

      {type === 'room' && <>
        <input placeholder="Name *" onChange={e => setForm({...form, name: e.target.value})} />
        <input placeholder="Beschreibung" onChange={e => setForm({...form, description: e.target.value})} />
      </>}

      <button className="save-btn" onClick={handleSubmit}>Speichern</button>
    </div>
  )
}