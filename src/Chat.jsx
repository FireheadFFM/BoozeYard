import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { lsGet, lsSet } from './utils'

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
const HINTS = ['Wie viele trockenen Wermut habe ich noch?', 'Welchen Rye über 45 % habe ich da?', 'Habe ich noch Cynar offen?', 'Der Cynar ist leer.', 'Setz Rittenhouse Rye auf die Einkaufsliste.', 'Was kann ich aus meinen Videos mixen?']

const speakable = t => String(t || '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()

async function callFn(body) {
  const { data, error } = await supabase.functions.invoke('ask-bar', { body })
  if (error) {
    let detail = error.message
    try { const j = await error.context.json(); if (j?.error) detail = j.error } catch { /* ignorieren */ }
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export default function Chat({ hidden, onOpenBottle, reload }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [tts, setTts] = useState(lsGet('chat_tts') !== '0')
  const [conv, setConv] = useState(lsGet('chat_conv') === '1')
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState([])
  const [newNote, setNewNote] = useState('')
  const [noteErr, setNoteErr] = useState('')
  const ttsRef = useRef(tts)
  const convRef = useRef(conv)
  const recRef = useRef(null)
  const finalRef = useRef('')
  const msgsRef = useRef([])
  const endRef = useRef(null)
  const openRef = useRef(false)

  useEffect(() => { ttsRef.current = tts; lsSet('chat_tts', tts ? '1' : '0'); if (!tts) stopSpeak() }, [tts])
  useEffect(() => { convRef.current = conv; lsSet('chat_conv', conv ? '1' : '0') }, [conv])
  useEffect(() => { msgsRef.current = msgs; endRef.current?.scrollIntoView({ block: 'end' }) }, [msgs])
  useEffect(() => { openRef.current = open; if (!open) { stopSpeak(); stopListen() } }, [open])
  useEffect(() => () => { stopSpeak(); stopListen() }, [])

  function stopSpeak() {
    try { window.speechSynthesis?.cancel() } catch { /* ignorieren */ }
    setSpeaking(false)
  }

  function speak(text) {
    if (!ttsRef.current || !('speechSynthesis' in window) || !text) return
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(speakable(text))
      u.lang = 'de-DE'
      const v = window.speechSynthesis.getVoices().find(x => x.lang && x.lang.toLowerCase().startsWith('de'))
      if (v) u.voice = v
      u.onstart = () => setSpeaking(true)
      u.onend = () => { setSpeaking(false); if (convRef.current && openRef.current) listen() }
      u.onerror = () => setSpeaking(false)
      window.speechSynthesis.speak(u)
    } catch { /* ignorieren */ }
  }

  function stopListen() {
    try { recRef.current?.stop() } catch { /* ignorieren */ }
    recRef.current = null
    setListening(false)
  }

  function listen() {
    if (!SR) return
    stopSpeak()
    stopListen()
    finalRef.current = ''
    const r = new SR()
    r.lang = 'de-DE'
    r.interimResults = true
    r.continuous = false
    r.onresult = e => {
      let t = ''
      for (const res of e.results) t += res[0].transcript
      setInput(t)
      if (e.results[e.results.length - 1].isFinal) finalRef.current = t
    }
    r.onerror = () => { setListening(false) }
    r.onend = () => {
      setListening(false)
      recRef.current = null
      const t = finalRef.current.trim()
      finalRef.current = ''
      if (t) send(t)
    }
    recRef.current = r
    setListening(true)
    try { r.start() } catch { setListening(false) }
  }

  const history = list => list.filter(m => m.text).map(m => ({ role: m.role, content: m.text }))

  async function send(text, display) {
    const q = String(text || '').trim()
    if (!q || busy) return
    stopSpeak()
    const next = [...msgsRef.current, { id: Date.now() + 'u', role: 'user', text: q, display: display || q }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    try {
      const d = await callFn({ messages: history(next) })
      const reply = { id: Date.now() + 'a', role: 'assistant', text: d.reply || '', shown: d.shown || [], recipes: d.recipes || [], choices: d.choices || [], proposal: d.proposal || null }
      setMsgs(m => [...m, reply])
      speak(d.reply)
    } catch (e) {
      setMsgs(m => [...m, { id: Date.now() + 'e', role: 'assistant', text: '', error: e.message }])
    }
    setBusy(false)
  }

  async function confirm(msg) {
    setBusy(true)
    setMsgs(m => m.map(x => (x.id === msg.id ? { ...x, proposal: { ...x.proposal, state: 'running' } } : x)))
    try {
      const actions = msg.proposal.items.map(({ label, ...a }) => a)
      const d = await callFn({ execute: { actions } })
      const text = d.done.length ? `Erledigt. ${d.done.join('. ')}.` : 'Es wurde nichts geändert.'
      setMsgs(m => [
        ...m.map(x => (x.id === msg.id ? { ...x, proposal: { ...x.proposal, state: 'done' } } : x)),
        { id: Date.now() + 'd', role: 'assistant', text, errors: d.errors, undo: d.undo?.length ? d.undo : null },
      ])
      speak(d.done.length ? 'Erledigt.' : 'Es wurde nichts geändert.')
      await reload()
    } catch (e) {
      setMsgs(m => [...m.map(x => (x.id === msg.id ? { ...x, proposal: { ...x.proposal, state: 'open' } } : x)), { id: Date.now() + 'e', role: 'assistant', text: '', error: e.message }])
    }
    setBusy(false)
  }

  function reject(msg) {
    setMsgs(m => [
      ...m.map(x => (x.id === msg.id ? { ...x, proposal: { ...x.proposal, state: 'rejected' } } : x)),
      { id: Date.now() + 'r', role: 'assistant', text: 'Okay, nichts geändert.' },
    ])
  }

  async function undo(msg) {
    setBusy(true)
    try {
      const d = await callFn({ undo: { steps: msg.undo } })
      setMsgs(m => [
        ...m.map(x => (x.id === msg.id ? { ...x, undo: null } : x)),
        { id: Date.now() + 'z', role: 'assistant', text: d.ok ? 'Rückgängig gemacht.' : 'Rückgängig teilweise fehlgeschlagen: ' + d.errors.join(', ') },
      ])
      speak('Rückgängig gemacht.')
      await reload()
    } catch (e) {
      setMsgs(m => [...m, { id: Date.now() + 'e', role: 'assistant', text: '', error: e.message }])
    }
    setBusy(false)
  }

  async function loadNotes() {
    const { data, error } = await supabase.from('chat_notes').select('id,text').order('created_at')
    if (error) setNoteErr('Merkliste nicht verfügbar: ' + error.message + ' (Update-10-SQL ausgeführt?)')
    else { setNoteErr(''); setNotes(data || []) }
  }
  async function addNote() {
    const t = newNote.trim()
    if (!t) return
    const { error } = await supabase.from('chat_notes').insert({ text: t.slice(0, 300) })
    if (error) return setNoteErr('Fehler: ' + error.message)
    setNewNote('')
    loadNotes()
  }
  async function delNote(n) {
    const { error } = await supabase.from('chat_notes').delete().eq('id', n.id)
    if (error) return setNoteErr('Fehler: ' + error.message)
    loadNotes()
  }
  function toggleNotes() {
    stopSpeak(); stopListen()
    if (!notesOpen) loadNotes()
    setNotesOpen(v => !v)
  }

  if (hidden && !open) return null

  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)} aria-label="Bar-Assistent öffnen">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
      </button>
    )
  }

  return (
    <div className="chat-sheet" role="dialog" aria-label="Bar-Assistent">
      <div className="chat-head">
        <strong>Bar-Assistent</strong>
        <span className="chat-tools">
          <button className={tts ? 'on' : ''} onClick={() => setTts(v => !v)}>{tts ? 'Ton an' : 'Stumm'}</button>
          {SR && <button className={conv ? 'on' : ''} onClick={() => setConv(v => !v)} title="Nach jeder Antwort automatisch wieder zuhören">Gespräch</button>}
          <button className={notesOpen ? 'on' : ''} onClick={toggleNotes}>Merkliste</button>
          {speaking && <button className="stop" onClick={stopSpeak}>Stopp</button>}
          <button onClick={() => setOpen(false)}>Schließen</button>
        </span>
      </div>

      {notesOpen && (
        <div className="chat-body notes">
          <p className="hint">Feste Absprachen, die der Assistent bei jeder Frage beachtet, z. B. „Mein Standard-Bourbon ist der Buffalo Trace“ oder „Der Gelbe ist der Chartreuse“. Du kannst auch im Chat sagen: „Merk dir …“.</p>
          {noteErr && <div className="msg error">{noteErr}</div>}
          {notes.length === 0 && !noteErr && <div className="hint">Noch nichts gemerkt.</div>}
          {notes.map(n => (
            <div key={n.id} className="note-row">
              <span>{n.text}</span>
              <button className="ghost" onClick={() => delNote(n)}>Entfernen</button>
            </div>
          ))}
          <div className="note-add">
            <input value={newNote} placeholder="Neue Absprache" maxLength={300} onChange={e => setNewNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} />
            <button disabled={!newNote.trim()} onClick={addNote}>Hinzufügen</button>
          </div>
        </div>
      )}
      <div className="chat-body" style={notesOpen ? { display: 'none' } : undefined}>
        {msgs.length === 0 && (
          <div className="chat-empty">
            <p>Frag mich zum Bestand oder sag, was sich geändert hat. Zum Beispiel:</p>
            {HINTS.map(h => <button key={h} className="hint-chip" onClick={() => send(h)}>{h}</button>)}
          </div>
        )}
        {msgs.map(m => (
          <div key={m.id} className={'bubble ' + m.role + (m.error ? ' err' : '')}>
            {m.role === 'user' && m.display}
            {m.role === 'assistant' && (m.error ? `Fehler: ${m.error}` : m.text)}
            {m.errors?.length > 0 && <div className="sub err">{m.errors.join(' · ')}</div>}

            {m.shown?.length > 0 && (
              <div className="shown">
                {m.shown.map(b => (
                  <button key={b.id} className="shown-item" onClick={() => { setOpen(false); onOpenBottle(b.id) }}>
                    <b>{b.produkt}</b>
                    <small>{[b.ml && `${b.ml} ml`, b.abv && `${b.abv} %`, b.status + (b.anzahl > 1 ? ` ×${b.anzahl}` : '') + (b.fuellstand !== undefined ? ` ${b.fuellstand} %` : ''), b.ort].filter(Boolean).join(' · ')}</small>
                  </button>
                ))}
              </div>
            )}

            {m.recipes?.length > 0 && (
              <div className="shown">
                {m.recipes.map(r => (
                  <a key={r.id} className="shown-item recipe-card" href={r.url} target="_blank" rel="noopener noreferrer">
                    <b>{r.name}</b>
                    <small>Rezept im Video öffnen</small>
                  </a>
                ))}
              </div>
            )}

            {m.choices?.length > 0 && (
              <div className="choices">
                {m.choices.map(c => (
                  <button key={c.bottle_id} disabled={busy} onClick={() => send(`Gemeint ist: ${c.label} (ID ${c.bottle_id})`, c.label)}>{c.label}</button>
                ))}
              </div>
            )}

            {m.proposal && (
              <div className="proposal">
                {m.proposal.items.map((it, i) => <div key={i} className="prop-item">{it.label}</div>)}
                {(m.proposal.state === undefined || m.proposal.state === 'open') && (
                  <div className="prop-btns">
                    <button className="yes" disabled={busy} onClick={() => confirm(m)}>Ja, ausführen</button>
                    <button disabled={busy} onClick={() => reject(m)}>Nein</button>
                  </div>
                )}
                {m.proposal.state === 'running' && <div className="sub">Führt aus…</div>}
                {m.proposal.state === 'done' && <div className="sub">Ausgeführt</div>}
                {m.proposal.state === 'rejected' && <div className="sub">Abgelehnt</div>}
              </div>
            )}

            {m.undo && <button className="undo" disabled={busy} onClick={() => undo(m)}>Rückgängig</button>}
          </div>
        ))}
        {busy && <div className="bubble assistant typing">…</div>}
        <div ref={endRef} />
      </div>

      <div className="chat-input">
        {SR && (
          <button className={'mic' + (listening ? ' live' : '')} onClick={() => (listening ? stopListen() : listen())} aria-label="Sprechen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <input value={input} placeholder={listening ? 'Ich höre zu…' : 'Frage eintippen'} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send(input)} />
        <button className="send" disabled={busy || !input.trim()} onClick={() => send(input)}>Senden</button>
      </div>
      {!SR && <div className="sub pad">Spracheingabe gibt es in diesem Browser nicht. Bitte Chrome nutzen.</div>}
    </div>
  )
}
