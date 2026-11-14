import { useEffect, useRef, useState } from 'react'
import { lsGet, lsSet } from './utils'

// Schalter "Display an": hält den Bildschirm wach, solange die App sichtbar ist
export default function WakeToggle() {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const [on, setOn] = useState(lsGet('wake') === '1')
  const [failed, setFailed] = useState(false)
  const lockRef = useRef(null)

  useEffect(() => {
    if (!supported) return undefined
    let alive = true

    async function acquire() {
      if (lockRef.current || document.visibilityState !== 'visible') return
      try {
        const l = await navigator.wakeLock.request('screen')
        if (!alive) { l.release().catch(() => {}); return }
        lockRef.current = l
        setFailed(false)
        l.addEventListener('release', () => { if (lockRef.current === l) lockRef.current = null })
      } catch {
        setFailed(true)
      }
    }
    function release() {
      const l = lockRef.current
      lockRef.current = null
      if (l) l.release().catch(() => {})
    }
    function onVis() {
      if (document.visibilityState === 'visible') acquire()
    }

    if (on) {
      acquire()
      document.addEventListener('visibilitychange', onVis)
    }
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      release()
    }
  }, [on, supported])

  if (!supported) return null

  function toggle() {
    const next = !on
    setOn(next)
    setFailed(false)
    lsSet('wake', next ? '1' : '0')
  }

  return (
    <button className={'link-btn wake' + (on && !failed ? ' on' : '')} onClick={toggle}
      title="Verhindert, dass sich der Bildschirm abschaltet, solange die App geöffnet ist">
      {on ? (failed ? 'Display: Fehler' : 'Display an ✓') : 'Display normal'}
    </button>
  )
}
