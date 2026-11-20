import { GIFEncoder, quantize, applyPalette } from './gifenc-lib'

const pause = () => new Promise(r => setTimeout(r, 0))

// Text auf Breite einpassen (Schrift verkleinern, sonst abschneiden)
function fitText(ctx, text, maxW, startPx, weight) {
  let px = startPx
  ctx.font = `${weight} ${px}px sans-serif`
  while (ctx.measureText(text).width > maxW && px > 10) { px -= 1; ctx.font = `${weight} ${px}px sans-serif` }
  let t = text
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -1)
  return t === text ? t : t.trimEnd() + '…'
}

// items: [{ blob, title, sub }]. Ergebnis: GIF-Blob (jedes Bild einmal, endlos wiederholt)
export async function makeGif(items, { size = 640, delayMs = 1200, captions = true, onProgress } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const gif = GIFEncoder()
  const bar = captions ? Math.round(size * 0.16) : 0
  const area = size - bar
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const bmp = await createImageBitmap(it.blob)
    ctx.fillStyle = '#0f0a06'
    ctx.fillRect(0, 0, size, size)
    const scale = Math.min(size / bmp.width, area / bmp.height)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    ctx.drawImage(bmp, Math.round((size - w) / 2), Math.round((area - h) / 2), w, h)
    if (bmp.close) bmp.close()
    if (captions) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#f0e6d3'
      const t1 = fitText(ctx, it.title || '', size * 0.92, Math.round(size * 0.05), 600)
      ctx.fillText(t1, size / 2, area + bar * (it.sub ? 0.36 : 0.5))
      if (it.sub) {
        ctx.fillStyle = '#f0c96a'
        const t2 = fitText(ctx, it.sub, size * 0.92, Math.round(size * 0.04), 400)
        ctx.fillText(t2, size / 2, area + bar * 0.72)
      }
    }
    const { data } = ctx.getImageData(0, 0, size, size)
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    gif.writeFrame(index, size, size, { palette, delay: delayMs, repeat: 0 })
    if (onProgress) onProgress(i + 1, items.length)
    await pause()
  }
  gif.finish()
  return new Blob([gif.bytes()], { type: 'image/gif' })
}
