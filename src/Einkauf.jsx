import { useMemo, useState } from 'react'
import { supabase } from './supabase'
import { SHOPS, shopLink, productQuery } from './shops'

const eur = n => (n === null || n === undefined ? '' : Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }))

export default function Einkauf({ bottles, wishlist = [], reload }) {
  const [prices, setPrices] = useState({})   // id -> {loading, offers, note, error}
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [newQty, setNewQty] = useState(1)

  const items = useMemo(() => {
    const list = []
    for (const b of bottles) {
      const low = b.min_stock !== null && b.min_stock !== undefined && b.status === 'closed' && b.quantity < b.min_stock
      if (!b.reorder && !low) continue
      list.push({ b, low, flagged: b.reorder, need: low ? Math.max(1, b.min_stock - b.quantity) : 1 })
    }
    return list.sort((x, y) => (x.b.brand + x.b.name).localeCompare(y.b.brand + y.b.name, 'de'))
  }, [bottles])

  async function clearFlag(b) {
    const { error } = await supabase.from('bottles').update({ reorder: false }).eq('id', b.id)
    if (error) setMsg('Fehler: ' + error.message)
    else reload()
  }

  async function dropLow(b) {
    const { error } = await supabase.from('bottles').update({ min_stock: 0, reorder: false }).eq('id', b.id)
    if (error) setMsg('Fehler: ' + error.message)
    else reload()
  }

  async function addItem() {
    const name = newItem.trim()
    if (!name) return
    const { error } = await supabase.from('wishlist').insert({ brand: '', name, quantity: Math.max(1, parseInt(newQty, 10) || 1) })
    if (error) return setMsg('Fehler: ' + error.message)
    setNewItem(''); setNewQty(1); setMsg('')
    reload()
  }

  async function removeItem(w) {
    const { error } = await supabase.from('wishlist').delete().eq('id', w.id)
    if (error) setMsg('Fehler: ' + error.message)
    else reload()
  }

  async function searchPrices(b, queryOverride) {
    setPrices(p => ({ ...p, [b.id]: { loading: true } }))
    const { data, error } = await supabase.functions.invoke('shop-prices', {
      body: { product: queryOverride || productQuery(b), abv: b.abv, shops: SHOPS.map(s => ({ name: s.name, domain: s.domain })) },
    })
    if (error) {
      let detail = error.message
      try { const j = await error.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
      setPrices(p => ({ ...p, [b.id]: { error: detail } }))
      return
    }
    setPrices(p => ({ ...p, [b.id]: { offers: data.offers || [], note: data.note, at: new Date() } }))
  }

  async function copyList() {
    const text = [
      ...items.map(({ b, need }) => `${need}× ${b.brand} ${b.name}${b.size_ml ? ` (${b.size_ml} ml)` : ''}`),
      ...wishlist.map(w => `${w.quantity || 1}× ${`${w.brand || ''} ${w.name}`.trim()}`),
    ].join('\n')
    try {
      if (navigator.share) await navigator.share({ title: 'Einkaufsliste', text })
      else { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    } catch { /* abgebrochen */ }
  }

  const top = SHOPS.filter(s => s.top)
  const more = SHOPS.filter(s => !s.top)

  return (
    <div>
      <div className="list-head">
        <div className="count">{items.length + wishlist.length} Artikel auf der Einkaufsliste</div>
        {items.length + wishlist.length > 0 && <button className="mini" onClick={copyList}>{copied ? 'Kopiert' : 'Liste teilen'}</button>}
      </div>
      {msg && <div className="msg error">{msg}</div>}
      <div className="inline-add add-free">
        <input placeholder="Neues Produkt, z. B. Rittenhouse Rye" value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => e.key === 'Enter' && addItem()} />
        <input className="qty" type="number" min="1" value={newQty} onChange={e => setNewQty(e.target.value)} aria-label="Menge" />
        <button onClick={addItem}>Hinzufügen</button>
      </div>
      {items.length + wishlist.length === 0 && (
        <div className="empty">Nichts zum Nachkaufen. Bei einer Flasche „Nachkaufen“ antippen, einen Mindestbestand setzen oder oben ein neues Produkt eintragen.</div>
      )}
      {wishlist.map(w => {
        const label = `${w.brand || ''} ${w.name}`.trim()
        const q = `${label}${w.size_ml ? ` ${w.size_ml} ml` : ''}`
        const pr = prices['w' + w.id]
        return (
          <div key={w.id} className="card buy">
            <div className="card-info full">
              <h3>{label}</h3>
              <p>{w.quantity || 1}× kaufen{w.notes ? ` · ${w.notes}` : ''}</p>
              <div className="tags"><span className="tag">Neues Produkt</span></div>
            </div>
            <div className="shop-row full">
              {top.map(s => <a key={s.id} className="shop top" href={shopLink(s, q)} target="_blank" rel="noopener noreferrer">{s.name}</a>)}
            </div>
            <details className="full more-shops">
              <summary>Weitere Shops</summary>
              <div className="shop-row">
                {more.map(s => <a key={s.id} className="shop" href={shopLink(s, q)} target="_blank" rel="noopener noreferrer">{s.name}</a>)}
              </div>
            </details>
            {pr?.offers && (
              <div className="offers full">
                {pr.offers.length === 0 && <div className="hint">{pr.note || 'Keine Preise gefunden.'}</div>}
                {pr.offers.map((o, i) => (
                  <div key={i} className="offer">
                    <span>{o.url ? <a href={o.url} target="_blank" rel="noopener noreferrer">{o.shop}</a> : o.shop}{o.note ? <small> · {o.note}</small> : null}</span>
                    <b>{eur(o.price_eur)}</b>
                  </div>
                ))}
              </div>
            )}
            {pr?.error && <div className="msg error full">{pr.error}</div>}
            <div className="actions full">
              <button onClick={() => searchPrices({ id: 'w' + w.id }, q)} disabled={pr?.loading}>{pr?.loading ? 'Sucht Preise…' : 'Preise suchen (KI)'}</button>
              <button className="ghost" onClick={() => removeItem(w)}>Entfernen</button>
            </div>
          </div>
        )
      })}
      {items.map(({ b, low, flagged, need }) => {
        const q = productQuery(b)
        const pr = prices[b.id]
        return (
          <div key={b.id} className="card buy">
            <div className="card-info full">
              <h3>{b.brand} {b.name}</h3>
              <p>
                {b.size_ml} ml{b.abv ? ` · ${b.abv} %` : ''} · {need}× kaufen
                {b.last_price !== null && b.last_price !== undefined ? ` · zuletzt ${eur(b.last_price)}` : ''}
              </p>
              <div className="tags">
                {flagged && <span className="tag warn">Vorgemerkt</span>}
                {low && <span className="tag warn">Mindestbestand {b.quantity}/{b.min_stock}</span>}
              </div>
            </div>

            <div className="shop-row full">
              {top.map(s => <a key={s.id} className="shop top" href={shopLink(s, q)} target="_blank" rel="noopener noreferrer">{s.name}</a>)}
            </div>
            <details className="full more-shops">
              <summary>Weitere Shops</summary>
              <div className="shop-row">
                {more.map(s => <a key={s.id} className="shop" href={shopLink(s, q)} target="_blank" rel="noopener noreferrer">{s.name}</a>)}
              </div>
            </details>

            {pr?.offers && (
              <div className="offers full">
                {pr.offers.length === 0 && <div className="hint">{pr.note || 'Keine Preise gefunden.'}</div>}
                {pr.offers.map((o, i) => (
                  <div key={i} className="offer">
                    <span>{o.url ? <a href={o.url} target="_blank" rel="noopener noreferrer">{o.shop}</a> : o.shop}{o.note ? <small> · {o.note}</small> : null}</span>
                    <b>{eur(o.price_eur)}</b>
                  </div>
                ))}
                {pr.offers.length > 0 && <div className="hint">Stand {pr.at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr, per KI-Websuche ermittelt. Bitte vor dem Kauf im Shop prüfen.</div>}
              </div>
            )}
            {pr?.error && <div className="msg error full">{pr.error}</div>}

            <div className="actions full">
              <button onClick={() => searchPrices(b)} disabled={pr?.loading}>{pr?.loading ? 'Sucht Preise…' : 'Preise suchen (KI)'}</button>
              {flagged && !low && <button className="ghost" onClick={() => clearFlag(b)}>Entfernen</button>}
              {low && <button className="ghost" onClick={() => dropLow(b)}>Nicht mehr nachkaufen</button>}
            </div>
            {low && <div className="hint full">Verschwindet, sobald der Bestand wieder reicht (Lieferung erfassen). „Nicht mehr nachkaufen“ setzt den Mindestbestand auf 0.</div>}
          </div>
        )
      })}
    </div>
  )
}
