import { useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { resizeImage, blobToBase64, digitsOnly, codeVariants, lsGet, lsSet } from './utils'

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const eur = n => (n === null || n === undefined || n === '' ? '–' : Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }))
const rank = { closed: 0, open: 1, empty: 2 }

function findMatch(it, bottles) {
  let cands = []
  if (it.ean) {
    const v = codeVariants(digitsOnly(it.ean))
    cands = bottles.filter(b => b.barcode && v.includes(digitsOnly(b.barcode)))
  }
  if (!cands.length && it.brand && it.name) {
    const key = norm(it.brand + it.name)
    cands = bottles.filter(b => norm(b.brand + b.name) === key && (!it.size_ml || !b.size_ml || b.size_ml === it.size_ml))
  }
  if (!cands.length && it.sku) cands = bottles.filter(b => b.supplier_sku && b.supplier_sku === it.sku)
  return cands.sort((a, b) => rank[a.status] - rank[b.status])[0] || null
}

function sameProduct(a, b) {
  return a.brand === b.brand && a.name === b.name && a.size_ml === b.size_ml
}

export default function Lieferung({ bottles, cats, rooms, locations, lookups, reload, onDone }) {
  const [stage, setStage] = useState('pick')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [head, setHead] = useState({ supplier: '', invoice_no: '', date: '', total: '' })
  const [items, setItems] = useState([])
  const [roomId, setRoomId] = useState(lsGet('deliv_room') || '')
  const [locId, setLocId] = useState(lsGet('deliv_loc') || '')
  const [result, setResult] = useState(null)
  const camRef = useRef(null)
  const fileRef = useRef(null)

  const mains = useMemo(() => cats.filter(c => !c.parent_id), [cats])
  const roomLocs = useMemo(() => locations.filter(l => l.room_id === roomId), [locations, roomId])
  const bottleById = useMemo(() => Object.fromEntries(bottles.map(b => [b.id, b])), [bottles])

  function addFiles(list) {
    const next = []
    for (const f of Array.from(list || [])) {
      const pdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
      if (pdf && f.size > 6_000_000) { setError(`„${f.name}“ ist größer als 6 MB. Bitte kleiner exportieren oder als Foto aufnehmen.`); continue }
      next.push({ file: f, pdf, url: pdf ? null : URL.createObjectURL(f) })
    }
    setFiles(cur => [...cur, ...next].slice(0, 5))
  }

  function catFor(main, sub) {
    const m = mains.find(c => sameText(c.name, main))
    if (!m) return ''
    const s = sub && cats.find(c => c.parent_id === m.id && sameText(c.name, sub))
    return (s || m).id
  }

  async function analyze() {
    setBusy(true); setError('')
    try {
      const payload = []
      for (const { file, pdf } of files) {
        if (pdf) payload.push({ media_type: 'application/pdf', data: await blobToBase64(file) })
        else payload.push({ media_type: 'image/jpeg', data: await blobToBase64(await resizeImage(file, 1800, 0.85)) })
      }
      const taxonomy = {
        categories: Object.fromEntries(mains.map(c => [c.name, cats.filter(x => x.parent_id === c.id).map(x => x.name)])),
        countries: lookups.filter(l => l.kind === 'country').map(l => l.name),
        regions: [...new Set(lookups.filter(l => l.kind === 'region').map(l => l.name))],
      }
      const { data, error: fnError } = await supabase.functions.invoke('analyze-invoice', { body: { files: payload, taxonomy } })
      if (fnError) {
        let detail = fnError.message
        try { const j = await fnError.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
        throw new Error(detail)
      }
      const r = data.result
      if (!r.items.length) throw new Error('Auf dem Beleg wurden keine Waren erkannt. Bitte schärfer oder vollständiger fotografieren.')
      const fallback = mains.find(c => sameText(c.name, 'Sonstiges'))?.id || ''
      setHead({ supplier: r.supplier || '', invoice_no: r.invoice_no || '', date: r.date || '', total: r.total ?? '' })
      setItems(r.items.map((i, n) => {
        const it = {
          key: n, include: true, desc: i.description, brand: i.brand || '', name: i.name || '', size_ml: i.size_ml ?? '',
          abv: i.abv ?? '', quantity: i.quantity, unit_price: i.unit_price ?? '', ean: i.ean || '', sku: i.sku || '',
          catId: catFor(i.main_category, i.sub_category) || fallback, country: i.country || '', region: i.region || '',
          vintage: i.vintage || '', enriched: i.enriched || [],
        }
        const m = findMatch(it, bottles)
        return { ...it, mode: m ? 'add' : 'new', matchId: m ? m.id : '' }
      }))
      setStage('review')
      if (r.truncated) setError('Der Beleg war sehr lang, die Liste ist eventuell unvollständig. Bitte prüfen.')
    } catch (e) {
      setError('Auswertung fehlgeschlagen: ' + e.message)
    }
    setBusy(false)
  }

  const setItem = (key, patch) => setItems(list => list.map(i => (i.key === key ? { ...i, ...patch } : i)))

  function willCreate(it) {
    if (it.mode === 'new') return true
    const m = bottleById[it.matchId]
    if (!m) return true
    return m.status !== 'closed' && !bottles.some(b => b.status === 'closed' && sameProduct(b, m))
  }

  const included = items.filter(i => i.include)
  const needsPlace = included.some(willCreate)

  async function save() {
    setError('')
    if (included.length === 0) return setError('Keine Position ausgewählt.')
    for (const it of included) {
      if (!String(it.brand).trim() || !String(it.name).trim()) return setError(`Bitte Marke und Name ergänzen: „${it.desc || 'Position'}“.`)
      if (!(Number(it.quantity) >= 1)) return setError(`Menge fehlt bei ${it.brand} ${it.name}.`)
      if (it.mode === 'new' && !it.catId) return setError(`Bitte eine Kategorie wählen: ${it.brand} ${it.name}.`)
    }
    if (needsPlace && !roomId) return setError('Bitte einen Raum für neue Flaschen wählen.')
    if (needsPlace && roomLocs.length > 0 && !locId) return setError('Bitte einen Ort für neue Flaschen wählen.')

    setBusy(true)
    let ok = 0, created = 0, added = 0
    const fails = []
    try {
      const price = v => (v === '' || v === null || v === undefined ? null : parseFloat(String(v).replace(',', '.')))
      const { data: del, error: de } = await supabase.from('deliveries').insert({
        supplier: head.supplier.trim() || null,
        invoice_no: head.invoice_no.trim() || null,
        delivered_at: head.date || new Date().toISOString().slice(0, 10),
        total: price(head.total),
      }).select('id').single()
      if (de) throw de

      for (const it of included) {
        const label = `${it.brand} ${it.name}`
        const qty = Math.round(Number(it.quantity))
        const p = price(it.unit_price)
        try {
          const m = it.mode === 'add' ? bottleById[it.matchId] : null
          let targetId = null
          if (m) {
            const closed = m.status === 'closed' ? m : bottles.find(b => b.status === 'closed' && sameProduct(b, m))
            if (closed) {
              const { error: e1 } = await supabase.from('bottles').update({
                quantity: closed.quantity + qty, reorder: false,
                ...(p !== null ? { last_price: p } : {}), ...(it.sku ? { supplier_sku: it.sku } : {}),
              }).eq('id', closed.id)
              if (e1) throw e1
              if (m.id !== closed.id && m.reorder) await supabase.from('bottles').update({ reorder: false }).eq('id', m.id)
              targetId = closed.id
              added++
            }
          }
          if (!targetId) {
            const src = m || {}
            const { data: row, error: e2 } = await supabase.from('bottles').insert({
              category_id: m ? m.category_id : it.catId,
              room_id: roomId, location_id: locId || null,
              brand: String(it.brand).trim(), name: String(it.name).trim(),
              vintage: (m ? m.vintage : it.vintage) || null,
              abv: m ? m.abv : (it.abv === '' ? null : parseFloat(String(it.abv).replace(',', '.'))),
              size_ml: m ? m.size_ml : (it.size_ml ? Math.round(Number(it.size_ml)) : 700),
              country: (m ? m.country : it.country) || null, region: (m ? m.region : it.region) || null,
              status: 'closed', quantity: qty, fill_percent: 100,
              barcode: src.barcode || it.ean || null, min_stock: m ? m.min_stock : null,
              last_price: p, supplier_sku: it.sku || null,
            }).select('id').single()
            if (e2) throw e2
            targetId = row.id
            if (m && m.reorder) await supabase.from('bottles').update({ reorder: false }).eq('id', m.id)
            created++
          }
          await supabase.from('movements').insert({ bottle_id: targetId, type: 'purchase', quantity: qty, delivery_id: del.id })
          ok++
        } catch (e) {
          fails.push(`${label}: ${e.message}`)
        }
      }
      if (needsPlace) { lsSet('deliv_room', roomId); lsSet('deliv_loc', locId) }
      await reload()
      setResult({ ok, created, added, fails })
      setStage('done')
    } catch (e) {
      setError('Fehler beim Speichern: ' + e.message)
    }
    setBusy(false)
  }

  function reset() {
    setStage('pick'); setFiles([]); setItems([]); setResult(null); setError('')
    setHead({ supplier: '', invoice_no: '', date: '', total: '' })
  }

  if (stage === 'done') {
    return (
      <div className="panel">
        <h3>Lieferung verbucht</h3>
        <div className="msg">{result.ok} Positionen: {result.created} neue Flaschen angelegt, {result.added} zum Bestand addiert.</div>
        {result.fails.length > 0 && <div className="msg error">Nicht verbucht:<br />{result.fails.join('\n')}</div>}
        <p className="hint">Neue Flaschen sind ohne Fotos angelegt. Foto und Feinschliff geht über Bestand → Bearbeiten.</p>
        <button className="save-btn" onClick={reset}>Nächste Lieferung</button>
        <button className="ghost-btn" onClick={onDone}>Zur Übersicht</button>
      </div>
    )
  }

  if (stage === 'review') {
    return (
      <div className="form">
        <h3 className="sec">Beleg prüfen</h3>
        <div className="two">
          <input placeholder="Lieferant" value={head.supplier} onChange={e => setHead({ ...head, supplier: e.target.value })} />
          <input placeholder="Beleg-Nr." value={head.invoice_no} onChange={e => setHead({ ...head, invoice_no: e.target.value })} />
        </div>
        <div className="two">
          <label className="fld"><span>Datum</span><input type="date" value={head.date} onChange={e => setHead({ ...head, date: e.target.value })} /></label>
          <label className="fld"><span>Summe laut Beleg (€)</span><input inputMode="decimal" value={head.total} onChange={e => setHead({ ...head, total: e.target.value })} /></label>
        </div>

        <div className="two">
          <label className="fld"><span>Raum für neue Flaschen</span>
            <select value={roomId} onChange={e => { setRoomId(e.target.value); setLocId('') }}>
              <option value="">– wählen –</option>
              {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="fld"><span>Ort</span>
            <select value={locId} onChange={e => setLocId(e.target.value)} disabled={!roomId || roomLocs.length === 0}>
              <option value="">{roomLocs.length === 0 ? '–' : '– wählen –'}</option>
              {roomLocs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>

        <div className="count">{included.length} von {items.length} Positionen ausgewählt</div>
        {items.map(it => {
          const m = it.mode === 'add' ? bottleById[it.matchId] : null
          const guess = f => it.enriched.includes(f)
          return (
            <div key={it.key} className={'deliv-item' + (it.include ? '' : ' off')}>
              <label className="check">
                <input type="checkbox" checked={it.include} onChange={e => setItem(it.key, { include: e.target.checked })} />
                <span className="orig">{it.desc || `${it.brand} ${it.name}`}</span>
              </label>
              {it.include && (
                <>
                  <div className="two">
                    <input placeholder="Marke" value={it.brand} onChange={e => setItem(it.key, { brand: e.target.value })} />
                    <input placeholder="Name" value={it.name} onChange={e => setItem(it.key, { name: e.target.value })} />
                  </div>
                  <div className="four">
                    <label className="fld"><span>Menge</span><input type="number" min="1" value={it.quantity} onChange={e => setItem(it.key, { quantity: e.target.value })} /></label>
                    <label className="fld"><span>Preis €</span><input inputMode="decimal" value={it.unit_price} onChange={e => setItem(it.key, { unit_price: e.target.value })} /></label>
                    <label className="fld"><span>ml</span><input inputMode="numeric" value={it.size_ml} onChange={e => setItem(it.key, { size_ml: e.target.value })} /></label>
                    <label className={'fld' + (guess('abv') ? ' guess' : '')}><span>% vol</span><input inputMode="decimal" value={it.abv} onChange={e => setItem(it.key, { abv: e.target.value })} /></label>
                  </div>
                  <select value={it.mode === 'add' && it.matchId ? it.matchId : 'new'}
                    onChange={e => {
                      const v = e.target.value
                      setItem(it.key, v === 'new' ? { mode: 'new', matchId: '' } : { mode: 'add', matchId: v })
                    }}>
                    {(() => {
                      const cands = bottles.filter(b => norm(b.brand) === norm(it.brand) || b.id === it.matchId)
                      return (
                        <>
                          <option value="new">Neue Flasche anlegen</option>
                          {cands.map(b => (
                            <option key={b.id} value={b.id}>Zu „{b.brand} {b.name}“ {b.size_ml} ml ({b.status === 'closed' ? 'geschlossen' : b.status === 'open' ? 'offen' : 'leer'}, ×{b.quantity}) addieren</option>
                          ))}
                        </>
                      )
                    })()}
                  </select>
                  {it.mode === 'new' && (
                    <>
                      <select className={guess('main_category') || guess('sub_category') ? 'guess' : ''} value={it.catId} onChange={e => setItem(it.key, { catId: e.target.value })}>
                        <option value="">– Kategorie wählen –</option>
                        {mains.map(mn => (
                          <optgroup key={mn.id} label={mn.name}>
                            <option value={mn.id}>{mn.name} (allgemein)</option>
                            {cats.filter(c => c.parent_id === mn.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      {(it.country || it.region) && <div className={'hint' + (guess('country') || guess('region') ? ' guess-t' : '')}>{[it.country, it.region].filter(Boolean).join(' · ')}</div>}
                    </>
                  )}
                  {m && <div className="hint">Aktuell im Bestand: ×{m.quantity}{m.last_price ? `, letzter Preis ${eur(m.last_price)}` : ''}</div>}
                  {it.enriched.length > 0 && <div className="hint guess-t">Gelb markierte Angaben sind KI-Vorschläge aus Fachwissen, nicht vom Beleg. Bitte kurz prüfen.</div>}
                </>
              )}
            </div>
          )
        })}

        {error && <div className="msg error">{error}</div>}
        <button className="save-btn" onClick={save} disabled={busy}>{busy ? 'Verbucht…' : `${included.length} Positionen verbuchen`}</button>
        <button className="ghost-btn" onClick={reset} disabled={busy}>Abbrechen</button>
      </div>
    )
  }

  return (
    <div className="panel">
      <h3>Lieferschein oder Rechnung</h3>
      <p className="hint">Foto(s) oder PDF des Belegs wählen. Die KI liest die Positionen, du prüfst sie und verbuchst alles auf einmal in den Bestand. Mehrere Seiten gehen als mehrere Fotos.</p>
      <div className="row-btns">
        <button className="scan-btn" onClick={() => camRef.current?.click()} disabled={busy}>Beleg fotografieren</button>
        <button className="scan-btn secondary" onClick={() => fileRef.current?.click()} disabled={busy}>Datei wählen (PDF/Foto)</button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />

      {files.length > 0 && (
        <div className="file-list">
          {files.map((f, i) => (
            <div key={i} className="file-item">
              {f.pdf ? <div className="pdf-ico">PDF</div> : <img src={f.url} alt="" />}
              <span>{f.file.name}</span>
              <button className="link-danger" onClick={() => setFiles(list => list.filter((_, j) => j !== i))}>Entfernen</button>
            </div>
          ))}
          <button className="ai-btn" onClick={analyze} disabled={busy}>{busy ? 'Liest den Beleg…' : `${files.length} Datei${files.length > 1 ? 'en' : ''} auswerten (KI)`}</button>
        </div>
      )}
      {error && <div className="msg error">{error}</div>}
    </div>
  )
}
