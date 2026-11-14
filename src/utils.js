/* Reine Hilfsfunktionen (ohne React), damit sie testbar sind */

export const SIZES = [20, 30, 50, 100, 200, 350, 500, 700, 750, 1000, 1500, 1750]
export const STATUS = { closed: 'Geschlossen', open: 'Offen', empty: 'Leer' }
export const BUCKET = 'bottle-images'
export const APP_VERSION = 'U12'

// Holt alle Zeilen seitenweise (Supabase liefert pro Abfrage höchstens 1000).
// make() muss bei jedem Aufruf eine frische Abfrage mit fester Sortierung liefern.
export async function fetchAll(make, page = 1000) {
  const out = []
  for (let from = 0; ; from += page) {
    const { data, error } = await make().range(from, from + page - 1)
    if (error) return { data: null, error }
    out.push(...data)
    if (data.length < page) break
  }
  return { data: out, error: null }
}

export function lsGet(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, value) } catch { /* ignorieren */ }
}

export function abvLabel(abv) {
  if (abv === null || abv === undefined || abv === '') return null
  const a = Number(abv)
  if (a <= 0.5) return 'Alkoholfrei'
  if (a < 46) return 'Standard'
  if (a < 56.5) return 'High Proof'
  if (a <= 57.5) return 'Navy Strength'
  if (a < 75) return 'Overproof'
  if (a < 76) return '151'
  return 'Ultra High Proof'
}

export function parseSize(q) {
  if (!q) return null
  const m = String(q).toLowerCase().replace(',', '.').match(/([\d.]+)\s*(ml|cl|l)\b/)
  if (!m) return null
  const v = parseFloat(m[1])
  return Math.round(m[2] === 'ml' ? v : m[2] === 'cl' ? v * 10 : v * 1000)
}

/* ---------- Barcodes ---------- */

export function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '')
}

// Prüfziffer für EAN-8, UPC-A (12), EAN-13 (gleiches Verfahren)
export function checkDigitOk(code) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(code)) return false
  const d = code.split('').map(Number)
  const check = d.pop()
  let sum = 0
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w
  return (10 - (sum % 10)) % 10 === check
}

// UPC-A (12 Ziffern) und EAN-13 mit führender Null sind derselbe Code
export function codeVariants(code) {
  const c = digitsOnly(code)
  const out = [c]
  if (c.length === 12) out.push('0' + c)
  if (c.length === 13 && c[0] === '0') out.push(c.slice(1))
  return out
}

export function codeWarning(code) {
  const c = digitsOnly(code)
  if (![8, 12, 13].includes(c.length)) {
    return `Der Code hat ${c.length} Ziffern – gültige Barcodes haben 8, 12 oder 13. Bitte prüfen.`
  }
  if ((c.length === 12 || c.length === 13) && !checkDigitOk(c)) {
    return 'Die Prüfziffer des Codes stimmt nicht – möglicherweise falsch gelesen. Bitte prüfen.'
  }
  return ''
}

/* ---------- Open Food Facts ---------- */

const CATEGORY_RULES = [
  [/(^|-)(rums?|rhums?)$/, 'Rum'],
  [/whisk(e)?y|whiskies|whiskeys/, 'Whisky/Whiskey'],
  [/^gins?$|-gins?$/, 'Gin'],
  [/vodka/, 'Wodka'],
  [/tequila|mezcal/, 'Tequila/Mezcal'],
  [/cognac|brandy|brandies|armagnac|calvados|pisco|grappa/, 'Cognac/Brandy/Armagnac'],
  [/vermouth|vermut/, 'Wermut/Vermouth'],
  [/bitter|aperitif|amaro/, 'Aperitif/Bitter'],
  [/liqueur/, 'Likör'],
]

export function mainCategoryFromTags(tags, mains) {
  for (const raw of tags || []) {
    const t = String(raw).replace(/^[a-z]{2}:/, '')
    for (const [re, name] of CATEGORY_RULES) {
      if (re.test(t)) {
        const hit = mains.find(m => m.name === name)
        if (hit) return hit.id
      }
    }
  }
  return ''
}

export async function lookupBarcode(variants, mains) {
  for (const v of variants) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(v)}.json?fields=product_name,brands,quantity,categories_tags,nutriments`
      const r = await fetch(url)
      const j = await r.json()
      if (j.status !== 1 || !j.product) continue
      const p = j.product
      const n = p.nutriments || {}
      const abvRaw = [n.alcohol, n.alcohol_100g, n.alcohol_value].find(x => typeof x === 'number' && x > 0)
      const out = {
        brand: (p.brands || '').split(',')[0].trim(),
        name: p.product_name || '',
        size_ml: parseSize(p.quantity),
        abv: abvRaw ?? null,
        mainId: mainCategoryFromTags(p.categories_tags, mains),
      }
      const got = []
      if (out.brand) got.push('Marke')
      if (out.name) got.push('Name')
      if (out.size_ml) got.push('Größe')
      if (out.abv !== null) got.push('Alkoholgehalt')
      if (out.mainId) got.push('Kategorie')
      return { ...out, got }
    } catch { /* nächste Variante */ }
  }
  return null
}

/* ---------- Bilder verkleinern ---------- */

export function resizeImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Bild konnte nicht umgewandelt werden'))), 'image/jpeg', quality)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Bild konnte nicht gelesen werden'))
    }
    img.src = url
  })
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'))
    r.readAsDataURL(blob)
  })
}
