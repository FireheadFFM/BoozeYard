// Minimaler XLSX-Schreiber und -Leser ohne externe Bibliothek.

const enc = new TextEncoder()
const dec = new TextDecoder()

/* ---------- ZIP (ohne Kompression) schreiben ---------- */

let crcTable = null
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0
  const u16 = n => [n & 255, (n >>> 8) & 255]
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
  for (const [name, text] of files) {
    const nameB = enc.encode(name)
    const data = enc.encode(text)
    const crc = crc32(data)
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0),
    ])
    chunks.push(local, nameB, data)
    central.push({ nameB, crc, size: data.length, offset })
    offset += local.length + nameB.length + data.length
  }
  const cdStart = offset
  for (const c of central) {
    const head = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.nameB.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset),
    ])
    chunks.push(head, c.nameB)
    offset += head.length + c.nameB.length
  }
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdStart), ...u32(cdStart), ...u16(0),
  ])
  chunks.push(end)
  return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Steuerzeichen, die in XML nicht erlaubt sind, entfernen
const clean = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function colName(i) {
  let s = ''
  i += 1
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) }
  return s
}

// rows: Array von Arrays, erste Zeile = Kopfzeile. widths: optionale Spaltenbreiten.
export function buildXlsx(rows, { sheetName = 'Bestand', widths = [] } = {}) {
  const nCols = rows[0]?.length || 1
  const lastCell = `${colName(nCols - 1)}${rows.length}`
  let sheetData = ''
  rows.forEach((row, r) => {
    let cells = ''
    row.forEach((v, c) => {
      const ref = `${colName(c)}${r + 1}`
      const style = r === 0 ? ' s="1"' : ''
      if (v === null || v === undefined || v === '') {
        if (r === 0) cells += `<c r="${ref}"${style}/>`
      } else if (typeof v === 'number' && isFinite(v)) {
        cells += `<c r="${ref}"${style}><v>${v}</v></c>`
      } else {
        cells += `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(clean(v))}</t></is></c>`
      }
    })
    sheetData += `<row r="${r + 1}">${cells}</row>`
  })
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCell}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${sheetData}</sheetData><autoFilter ref="A1:${lastCell}"/></worksheet>`
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5A3A12"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ]
  return zipStore(files)
}

/* ---------- ZIP lesen und XLSX auswerten ---------- */

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unzip(buffer) {
  const v = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let eocd = -1
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 70000); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Keine gültige Excel-Datei (.xlsx).')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = {}
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nlen = v.getUint16(p + 28, true)
    const elen = v.getUint16(p + 30, true)
    const clen = v.getUint16(p + 32, true)
    const lho = v.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + elen + clen
    if (!/^xl\/(worksheets\/sheet\d+|sharedStrings|workbook)\.xml$/.test(name) && !/^xl\/_rels\/workbook\.xml\.rels$/.test(name)) continue
    const lnlen = v.getUint16(lho + 26, true)
    const lelen = v.getUint16(lho + 28, true)
    const start = lho + 30 + lnlen + lelen
    const raw = bytes.subarray(start, start + csize)
    out[name] = dec.decode(method === 0 ? raw : await inflateRaw(raw))
  }
  return out
}

function colIndex(ref) {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export async function readXlsx(buffer) {
  const files = await unzip(buffer)
  const parser = new DOMParser()
  const shared = []
  if (files['xl/sharedStrings.xml']) {
    const d = parser.parseFromString(files['xl/sharedStrings.xml'], 'application/xml')
    for (const si of Array.from(d.getElementsByTagName('si'))) {
      shared.push(Array.from(si.getElementsByTagName('t')).map(t => t.textContent).join(''))
    }
  }
  const sheetName = Object.keys(files).filter(k => /worksheets\/sheet\d+\.xml$/.test(k)).sort()[0]
  if (!sheetName) throw new Error('Kein Tabellenblatt gefunden.')
  const d = parser.parseFromString(files[sheetName], 'application/xml')
  const rows = []
  for (const row of Array.from(d.getElementsByTagName('row'))) {
    const r = []
    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const idx = colIndex(c.getAttribute('r') || 'A1')
      const t = c.getAttribute('t')
      let val = null
      if (t === 'inlineStr') val = Array.from(c.getElementsByTagName('t')).map(x => x.textContent).join('')
      else {
        const vEl = c.getElementsByTagName('v')[0]
        if (vEl) {
          if (t === 's') val = shared[parseInt(vEl.textContent, 10)] ?? ''
          else if (t === 'str' || t === 'e') val = vEl.textContent
          else if (t === 'b') val = vEl.textContent === '1' ? 'Ja' : 'Nein'
          else { const n = Number(vEl.textContent); val = isFinite(n) ? n : vEl.textContent }
        }
      }
      r[idx] = val
    }
    rows.push(r)
  }
  return rows
}

/* ---------- CSV ---------- */

export function parseCsv(text) {
  text = text.replace(/^﻿/, '')
  const first = text.split(/\r?\n/, 1)[0] || ''
  const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ','
  const rows = []
  let row = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === delim) { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''
    } else cur += ch
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows.filter(r => r.some(x => x !== ''))
}

export function csvFromRows(rows) {
  const cell = v => {
    if (v === null || v === undefined) return ''
    const s = String(typeof v === 'number' ? String(v).replace('.', ',') : v).replace(/\r?\n/g, ' ')
    return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n')
}
