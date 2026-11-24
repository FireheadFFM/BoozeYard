import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { qrPath, placeLink, fmtLocCode } from './qr'

// QR-Etiketten für Räume und Orte: Auswahl, Vorschau, Druck auf A4 (4 Etiketten A6 = 105 × 148 mm pro Bogen)

const PER_SHEET = 4

// Schriftgröße (pt) so wählen, dass auch lange Namen in die Etikettenbreite passen
function nameSize(name) {
  return Math.max(14, Math.min(30, Math.floor(250 / (Math.max(1, name.length) * 0.62))))
}

function QrLabel({ item, frame }) {
  const { n, d } = useMemo(() => qrPath(item.link), [item.link])
  return (
    <div className={'qr-label' + (frame ? ' framed' : '')}>
      <div className="ql-brand">BOOZEYARD</div>
      <svg className="ql-code" viewBox={`-4 -4 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" role="img" aria-label={`QR-Code ${item.path}`}>
        <rect x="-4" y="-4" width={n + 8} height={n + 8} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
      <div className="ql-name" style={{ fontSize: `${nameSize(item.name)}pt` }}>{item.name}</div>
      <div className="ql-path">{item.path}</div>
      <div className="ql-foot">
        {item.code != null && <div className="ql-nr">{fmtLocCode(item.code)}</div>}
        <div className="ql-hint">Scannen: zeigt den Inhalt</div>
      </div>
    </div>
  )
}

function Sheet({ slots, frame }) {
  return (
    <div className="qr-sheet">
      {Array.from({ length: PER_SHEET }, (_, i) => slots[i]
        ? <QrLabel key={slots[i].key} item={slots[i]} frame={frame} />
        : <div key={'x' + i} className={'qr-label empty' + (frame ? ' framed' : '')} />)}
    </div>
  )
}

export default function QrPrint({ rooms, locations }) {
  const [sel, setSel] = useState({})      // 'r:<id>' / 'l:<id>' -> true
  const [start, setStart] = useState(1)   // erstes freie Etikett auf dem ersten Bogen
  const [frame, setFrame] = useState(false)

  const groups = useMemo(() => rooms.map(r => ({
    room: r,
    locs: locations.filter(l => l.room_id === r.id),
  })), [rooms, locations])

  // Alle auswählbaren Etiketten in Anzeige-Reihenfolge
  const all = useMemo(() => {
    const list = []
    for (const { room, locs } of groups) {
      list.push({ key: 'r:' + room.id, name: room.name, path: 'Raum', link: placeLink('room', room.id) })
      for (const l of locs) list.push({ key: 'l:' + l.id, name: l.name, code: l.code ?? null, path: `${room.name} → ${l.name}`, link: placeLink('location', l.id) })
    }
    return list
  }, [groups])

  const chosen = all.filter(it => sel[it.key])
  const slots = useMemo(() => [...Array(start - 1).fill(null), ...chosen], [chosen, start])
  const sheets = useMemo(() => {
    const out = []
    for (let i = 0; i < slots.length; i += PER_SHEET) out.push(slots.slice(i, i + PER_SHEET))
    return out
  }, [slots])

  // Während die Seite offen ist, blendet der Druck-Stil alles außer den Bögen aus
  useEffect(() => {
    document.body.classList.add('qr-printing')
    return () => document.body.classList.remove('qr-printing')
  }, [])

  const toggle = key => setSel(s => ({ ...s, [key]: !s[key] }))
  const setMany = (keys, on) => setSel(s => { const n = { ...s }; keys.forEach(k => { n[k] = on }); return n })
  const allLocKeys = all.filter(it => it.key.startsWith('l:')).map(it => it.key)

  if (rooms.length === 0) return <div className="empty">Noch keine Lagerorte angelegt.</div>

  return (
    <>
      <div className="card column qr-panel">
        <p className="hint">
          Wähle die Orte, für die du Etiketten brauchst. Auf jedem Etikett steht ein QR-Code mit dem Namen und bei Orten die Nummer (Nr.) zum Ablesen. Scannst du ihn mit der Handykamera oder in der App, siehst du sofort, was dort liegt.
          Gedruckt wird auf A4 mit vier Etiketten à 105 × 148 mm (A6).
        </p>
        <div className="qr-quick">
          <button type="button" className="mini" onClick={() => setMany(allLocKeys, true)}>Alle Orte</button>
          <button type="button" className="mini" onClick={() => setMany(all.map(it => it.key), true)}>Alles</button>
          <button type="button" className="mini" onClick={() => setSel({})}>Keine</button>
        </div>
        {groups.map(({ room, locs }) => (
          <div key={room.id} className="qr-group">
            <label className="qr-row room">
              <input type="checkbox" checked={!!sel['r:' + room.id]} onChange={() => toggle('r:' + room.id)} />
              <span><b>{room.name}</b> <em>ganzer Raum</em></span>
            </label>
            {locs.map(l => (
              <label key={l.id} className="qr-row">
                <input type="checkbox" checked={!!sel['l:' + l.id]} onChange={() => toggle('l:' + l.id)} />
                <span>{l.name}{l.code != null && <em> {fmtLocCode(l.code)}</em>}</span>
              </label>
            ))}
            {locs.length === 0 && <div className="hint qr-none">Keine Unterorte</div>}
          </div>
        ))}
      </div>

      <div className="card column qr-panel">
        <div className="fld"><span>Erstes Etikett auf dem Bogen</span>
          <select value={start} onChange={e => setStart(Number(e.target.value))}>
            <option value={1}>1 (neuer Bogen)</option>
            <option value={2}>2 (Etikett 1 schon verbraucht)</option>
            <option value={3}>3 (Etikett 1–2 verbraucht)</option>
            <option value={4}>4 (Etikett 1–3 verbraucht)</option>
          </select>
        </div>
        <label className="qr-row">
          <input type="checkbox" checked={frame} onChange={e => setFrame(e.target.checked)} />
          <span>Rahmenlinien mitdrucken (nur für den Probedruck auf Papier)</span>
        </label>
        <div className="count">{chosen.length} {chosen.length === 1 ? 'Etikett' : 'Etiketten'} auf {sheets.length} {sheets.length === 1 ? 'Bogen' : 'Bögen'}</div>
        <button type="button" className="save-btn" disabled={chosen.length === 0} onClick={() => window.print()}>Drucken</button>
        <p className="hint">
          Im Druckdialog „Tatsächliche Größe“ bzw. 100 % wählen, Ränder „Keine“ und kein „Seite anpassen“.
          Erst einmal auf normalem Papier testen und gegen das Licht an den Etikettenbogen halten.
        </p>
      </div>

      {sheets.length > 0 && (
        <div className="qr-preview" aria-label="Vorschau erster Bogen">
          <Sheet slots={sheets[0]} frame />
          {sheets.length > 1 && <div className="hint">Vorschau: erster von {sheets.length} Bögen</div>}
        </div>
      )}

      {createPortal(
        <div className="qr-print-root">
          {sheets.map((s, i) => <Sheet key={i} slots={s} frame={frame} />)}
        </div>,
        document.body,
      )}
    </>
  )
}
