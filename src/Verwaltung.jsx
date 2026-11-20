import { useState } from 'react'
import { APP_VERSION } from './utils'
import Rooms from './Rooms'
import QrPrint from './QrPrint'
import Export, { YoutubeRezepte } from './Export'

// Verwaltung: Lagerorte, Export/Import und YouTube-Rezepte unter einem Tab
export default function Verwaltung({ bottles, cats, rooms, locations, reload }) {
  const [view, setView] = useState(null)

  if (view) {
    const titles = { rooms: 'Lagerorte', qr: 'QR-Etiketten', export: 'Export & Import', youtube: 'YouTube-Rezepte' }
    return (
      <>
        <button className="link-back" onClick={() => setView(null)}>← Verwaltung</button>
        <h2 className="admin-title">{titles[view]}</h2>
        {view === 'rooms' && <Rooms bottles={bottles} rooms={rooms} locations={locations} reload={reload} />}
        {view === 'qr' && <QrPrint rooms={rooms} locations={locations} />}
        {view === 'export' && <Export bottles={bottles} cats={cats} rooms={rooms} locations={locations} reload={reload} />}
        {view === 'youtube' && <div className="panel"><YoutubeRezepte /></div>}
      </>
    )
  }

  const nLoc = locations.length
  return (
    <div className="admin-menu">
      <button type="button" className="card column admin-item" onClick={() => setView('rooms')}>
        <h3>Lagerorte</h3>
        <p>{rooms.length} {rooms.length === 1 ? 'Raum' : 'Räume'}, {nLoc} {nLoc === 1 ? 'Ort' : 'Orte'}. Anlegen, umbenennen, löschen und Standard-Status festlegen.</p>
      </button>
      <button type="button" className="card column admin-item" onClick={() => setView('qr')}>
        <h3>QR-Etiketten</h3>
        <p>QR-Codes für Räume und Orte ausdrucken. Wer den Code scannt, sieht sofort, was dort liegt.</p>
      </button>
      <button type="button" className="card column admin-item" onClick={() => setView('export')}>
        <h3>Export &amp; Import</h3>
        <p>Bestand als Excel- oder CSV-Datei sichern, Änderungen aus Excel einlesen, Live-Verbindung für Excel. Als Sicherung regelmäßig exportieren.</p>
      </button>
      <button type="button" className="card column admin-item" onClick={() => setView('youtube')}>
        <h3>YouTube-Rezepte</h3>
        <p>Rezepte aus deinen Videos für den Assistenten laden und aktualisieren.</p>
      </button>
      <div className="hint admin-version">BoozeYard {APP_VERSION}</div>
    </div>
  )
}
