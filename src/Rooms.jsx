import { useMemo, useState } from 'react'
import { supabase } from './supabase'

// Nächster freier Name im Zielraum: "Kiste 2" -> "Kiste 7", wenn Kiste 2..6 schon belegt sind
function freeName(name, taken) {
  const norm = s => s.trim().toLowerCase()
  const set = new Set([...taken].map(norm))
  if (!set.has(norm(name))) return name.trim()
  const m = name.trim().match(/^(.*?)(\d+)\s*$/)
  const base = m ? m[1] : name.trim() + ' '
  let max = m ? parseInt(m[2], 10) : 1
  const rx = new RegExp('^' + base.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\d+)\\s*$', 'i')
  for (const t of taken) { const mm = String(t).trim().match(rx); if (mm) max = Math.max(max, parseInt(mm[1], 10)) }
  let n = max + 1
  let cand = `${base.trim()} ${n}`.trim()
  while (set.has(norm(cand))) { n++; cand = `${base.trim()} ${n}` }
  return cand
}

export default function Rooms({ bottles, rooms, locations, reload }) {
  const [newRoom, setNewRoom] = useState('')
  const [newLoc, setNewLoc] = useState({})
  const [msg, setMsg] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [roomEdit, setRoomEdit] = useState(null)   // { id, name, del, moveTo }
  const [locEdit, setLocEdit] = useState(null)     // { id, name, roomId, del, moveTo }
  const [batch, setBatch] = useState(false)
  const [sel, setSel] = useState({})
  const [target, setTarget] = useState('')

  const roomById = useMemo(() => Object.fromEntries(rooms.map(r => [r.id, r])), [rooms])
  const count = fn => bottles.filter(b => b.status !== 'empty' && fn(b)).reduce((s, b) => s + b.quantity, 0)
  const entries = fn => bottles.filter(fn).length

  async function run(fn) {
    setBusy(true); setMsg(''); setInfo('')
    try { await fn(); await reload() } catch (e) { setMsg('Fehler: ' + e.message) }
    setBusy(false)
  }
  const must = r => { if (r.error) throw r.error }

  async function addRoom() {
    const name = newRoom.trim()
    if (!name) return
    await run(async () => { must(await supabase.from('rooms').insert({ name })); setNewRoom('') })
  }
  async function addLocation(roomId) {
    const name = (newLoc[roomId] || '').trim()
    if (!name) return
    await run(async () => { must(await supabase.from('locations').insert({ room_id: roomId, name })); setNewLoc(s => ({ ...s, [roomId]: '' })) })
  }

  /* ----- Raum ----- */
  async function renameRoom() {
    const name = roomEdit.name.trim()
    if (!name) return
    await run(async () => { must(await supabase.from('rooms').update({ name }).eq('id', roomEdit.id)); setRoomEdit(null) })
  }
  async function deleteRoom() {
    const id = roomEdit.id
    const n = entries(b => b.room_id === id)
    if (n > 0 && !roomEdit.moveTo) return setMsg('Bitte einen Raum wählen, in den die Flaschen ziehen.')
    await run(async () => {
      if (n > 0) must(await supabase.from('bottles').update({ room_id: roomEdit.moveTo, location_id: null }).eq('room_id', id))
      must(await supabase.from('rooms').delete().eq('id', id))
      setRoomEdit(null)
    })
  }

  /* ----- Ort ----- */
  function openLoc(l) {
    setLocEdit(cur => (cur?.id === l.id ? null : { id: l.id, name: l.name, roomId: l.room_id, del: false, moveTo: '' }))
  }
  function onTargetRoom(roomId) {
    const l = locations.find(x => x.id === locEdit.id)
    const taken = locations.filter(x => x.room_id === roomId && x.id !== l.id).map(x => x.name)
    setLocEdit(e => ({ ...e, roomId, name: roomId === l.room_id ? l.name : freeName(l.name, taken) }))
  }
  async function saveLoc() {
    const l = locations.find(x => x.id === locEdit.id)
    const name = locEdit.name.trim()
    if (!name) return
    const clash = locations.some(x => x.room_id === locEdit.roomId && x.id !== l.id && x.name.trim().toLowerCase() === name.toLowerCase())
    if (clash) return setMsg(`„${name}“ gibt es in diesem Raum schon. Bitte einen anderen Namen wählen.`)
    await run(async () => {
      must(await supabase.from('locations').update({ name, room_id: locEdit.roomId }).eq('id', l.id))
      if (locEdit.roomId !== l.room_id) must(await supabase.from('bottles').update({ room_id: locEdit.roomId }).eq('location_id', l.id))
      setLocEdit(null)
      if (locEdit.roomId !== l.room_id) setInfo(`„${l.name}“ ist jetzt „${name}“ im Raum ${roomById[locEdit.roomId]?.name}. Die Flaschen sind mitgezogen.`)
    })
  }
  async function deleteLoc() {
    const l = locations.find(x => x.id === locEdit.id)
    const n = entries(b => b.location_id === l.id)
    await run(async () => {
      if (n > 0) {
        const upd = locEdit.moveTo ? { location_id: locEdit.moveTo } : { location_id: null }
        must(await supabase.from('bottles').update(upd).eq('location_id', l.id))
      }
      must(await supabase.from('locations').delete().eq('id', l.id))
      setLocEdit(null)
    })
  }

  /* ----- Batch ----- */
  const picked = locations.filter(l => sel[l.id])
  const preview = useMemo(() => {
    if (!target) return []
    const taken = locations.filter(l => l.room_id === target && !sel[l.id]).map(l => l.name)
    return picked
      .filter(l => l.room_id !== target)
      .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))
      .map(l => { const nn = freeName(l.name, taken); taken.push(nn); return { loc: l, newName: nn } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, target, locations])
  async function applyBatch() {
    await run(async () => {
      for (const { loc, newName } of preview) {
        must(await supabase.from('locations').update({ room_id: target, name: newName }).eq('id', loc.id))
        must(await supabase.from('bottles').update({ room_id: target }).eq('location_id', loc.id))
      }
      setInfo(`${preview.length} Orte nach ${roomById[target]?.name} verschoben.`)
      setSel({}); setBatch(false); setTarget('')
    })
  }

  return (
    <>
      {msg && <div className="msg error">{msg}</div>}
      {info && <div className="msg">{info}</div>}
      <div className="list-head">
        <div className="count">{rooms.length} Räume · {locations.length} Orte</div>
        {locations.length > 1 && rooms.length > 1 && (
          <button className="mini" onClick={() => { setBatch(b => !b); setSel({}); setTarget(''); setLocEdit(null) }}>{batch ? 'Fertig' : 'Mehrere verschieben'}</button>
        )}
      </div>

      {batch && (
        <div className="card column batch-box">
          <p className="hint">Orte antippen, die umziehen sollen, dann den Zielraum wählen. Doppelte Namen bekommen automatisch die nächste freie Nummer.</p>
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">– Zielraum wählen –</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {preview.length > 0 && (
            <div className="plan-card">
              {preview.map(({ loc, newName }) => (
                <div key={loc.id} className="chg"><span>{roomById[loc.room_id]?.name}</span> {loc.name} → <b>{newName}</b></div>
              ))}
            </div>
          )}
          <button className="save-btn" disabled={busy || preview.length === 0} onClick={applyBatch}>
            {busy ? 'Verschiebt…' : `${preview.length} Orte nach ${roomById[target]?.name || '…'} verschieben`}
          </button>
        </div>
      )}

      {rooms.length === 0 && <div className="empty">Noch keine Lagerorte angelegt.</div>}
      {rooms.map(r => {
        const locs = locations.filter(l => l.room_id === r.id)
        const editing = roomEdit?.id === r.id
        const nRoom = entries(b => b.room_id === r.id)
        return (
          <div key={r.id} className="card column">
            <div className="room-head">
              <h3>{r.name}</h3>
              <span>
                <span className="badge">{count(b => b.room_id === r.id)} Flaschen</span>
                {!batch && <button className="mini inl" onClick={() => setRoomEdit(editing ? null : { id: r.id, name: r.name, del: false, moveTo: '' })}>{editing ? 'Schließen' : 'Bearbeiten'}</button>}
              </span>
            </div>

            {editing && (
              <div className="edit-box">
                <div className="inline-add">
                  <input value={roomEdit.name} onChange={e => setRoomEdit({ ...roomEdit, name: e.target.value })} />
                  <button disabled={busy} onClick={renameRoom}>Umbenennen</button>
                </div>
                {!roomEdit.del && <button className="danger-btn slim" onClick={() => setRoomEdit({ ...roomEdit, del: true })}>Raum löschen</button>}
                {roomEdit.del && (
                  <div className="confirm-box">
                    <p>
                      Der Raum und seine {locs.length} Orte werden gelöscht.
                      {nRoom > 0 ? ` ${nRoom} Einträge liegen noch dort, wohin sollen sie?` : ' Es liegen keine Flaschen dort.'}
                    </p>
                    {nRoom > 0 && (
                      <select value={roomEdit.moveTo} onChange={e => setRoomEdit({ ...roomEdit, moveTo: e.target.value })}>
                        <option value="">– Raum wählen (ohne Ort) –</option>
                        {rooms.filter(x => x.id !== r.id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    )}
                    <button className="scan-btn" disabled={busy} onClick={deleteRoom}>Endgültig löschen</button>
                    <button className="ghost-btn" onClick={() => setRoomEdit({ ...roomEdit, del: false })}>Abbrechen</button>
                  </div>
                )}
              </div>
            )}

            <div className="chips">
              {locs.length === 0 && <span className="muted">Keine Unterorte</span>}
              {locs.map(l => (
                <button key={l.id} type="button"
                  className={'chip chip-btn' + (sel[l.id] ? ' picked' : '') + (locEdit?.id === l.id ? ' open' : '')}
                  onClick={() => (batch ? setSel(s => ({ ...s, [l.id]: !s[l.id] })) : openLoc(l))}>
                  {batch && <span className="box">{sel[l.id] ? '✓' : ''}</span>}{l.name} · {count(b => b.location_id === l.id)}
                </button>
              ))}
            </div>

            {locEdit && locEdit.roomId !== undefined && locs.some(l => l.id === locEdit.id) && !batch && (() => {
              const l = locations.find(x => x.id === locEdit.id)
              const nLoc = entries(b => b.location_id === l.id)
              const sameRoomLocs = locations.filter(x => x.room_id === l.room_id && x.id !== l.id)
              const moving = locEdit.roomId !== l.room_id
              return (
                <div className="edit-box">
                  <div className="fld"><span>Name</span>
                    <input value={locEdit.name} onChange={e => setLocEdit({ ...locEdit, name: e.target.value })} />
                  </div>
                  <div className="fld"><span>Raum</span>
                    <select value={locEdit.roomId} onChange={e => onTargetRoom(e.target.value)}>
                      {rooms.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </div>
                  {moving && <p className="hint">Alle {nLoc} Einträge dieses Ortes ziehen mit um. Bei doppeltem Namen wurde die nächste freie Nummer vorgeschlagen, du kannst sie ändern.</p>}
                  <button className="save-btn" disabled={busy} onClick={saveLoc}>{moving ? 'Verschieben und speichern' : 'Speichern'}</button>
                  {!locEdit.del && <button className="danger-btn slim" onClick={() => setLocEdit({ ...locEdit, del: true })}>Ort löschen</button>}
                  {locEdit.del && (
                    <div className="confirm-box">
                      <p>{nLoc > 0 ? `${nLoc} Einträge liegen noch in „${l.name}“. Wohin damit?` : `„${l.name}“ wird gelöscht.`}</p>
                      {nLoc > 0 && (
                        <select value={locEdit.moveTo} onChange={e => setLocEdit({ ...locEdit, moveTo: e.target.value })}>
                          <option value="">Im Raum bleiben, ohne Ort</option>
                          {sameRoomLocs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      )}
                      <button className="scan-btn" disabled={busy} onClick={deleteLoc}>Endgültig löschen</button>
                      <button className="ghost-btn" onClick={() => setLocEdit({ ...locEdit, del: false })}>Abbrechen</button>
                    </div>
                  )}
                </div>
              )
            })()}

            {!batch && (
              <div className="inline-add">
                <input placeholder="Neuer Ort, z. B. Kiste 4" value={newLoc[r.id] || ''} onChange={e => setNewLoc({ ...newLoc, [r.id]: e.target.value })} />
                <button onClick={() => addLocation(r.id)}>Hinzufügen</button>
              </div>
            )}
          </div>
        )
      })}
      {!batch && (
        <div className="card column">
          <div className="inline-add">
            <input placeholder="Neuer Raum" value={newRoom} onChange={e => setNewRoom(e.target.value)} />
            <button onClick={addRoom}>Anlegen</button>
          </div>
        </div>
      )}
    </>
  )
}
