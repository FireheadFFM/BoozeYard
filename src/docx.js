import { fmtDate, starsText, fmtAvg, fmtStar, titleOf, metaOf } from './tastingUtils'

// Whisky-Journal als Word-Datei (.docx), komplett im Browser erzeugt (ohne Bibliothek, ZIP ohne Kompression)

const enc = new TextEncoder()
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

// files: [[Name, Text | Uint8Array]]
export function zipFiles(files, type) {
  const chunks = []
  const central = []
  let offset = 0
  const u16 = n => [n & 255, (n >>> 8) & 255]
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
  for (const [name, content] of files) {
    const nameB = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
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
  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdStart), ...u32(cdStart), ...u16(0),
  ]))
  return new Blob(chunks, { type })
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const clean = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

const run = (text, o = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz || 20}"/></w:rPr><w:t xml:space="preserve">${esc(clean(text))}</w:t></w:r>`
const para = (runs, o = {}) => `<w:p><w:pPr>${o.keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="${o.before || 0}" w:after="${o.after || 0}"/></w:pPr>${runs}</w:p>`
const cell = (w, paras, fill) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${paras || para('')}</w:tc>`

const EMU = 360000   // 1 cm
const COLS = [1500, 2900, 2500, 3306]   // Bild, Whisky, Bewertung, Beschreibung (zusammen 10206 Twips = A4 abzüglich Ränder)

function drawing(rid, n, wEmu, hEmu) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${wEmu}" cy="${hEmu}"/><wp:docPr id="${n}" name="Etikett ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="etikett${n}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

// journal: Ergebnis von buildJournal; imgs: Map Whisky-ID -> { bytes: Uint8Array, w, h }
export function makeDocx(journal, imgs, { title = 'Whisky-Journal' } = {}) {
  const rels = []
  const media = []
  let n = 0
  const total = journal.reduce((s, g) => s + g.rows.length, 0)
  const dates = journal.map(g => g.event.event_date).filter(Boolean).sort()
  const range = dates.length ? (dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : ''

  let body = para(run(title, { b: true, sz: 40 }), { after: 60 })
  body += para(run(`${[range, `${total} ${total === 1 ? 'Whisky' : 'Whiskys'}`].filter(Boolean).join(' · ')}`, { color: '666666', sz: 20 }), { after: 200 })

  for (const g of journal) {
    body += para(run(`${g.event.name} · ${fmtDate(g.event.event_date)}`, { b: true, sz: 28 }), { before: 240, after: 100, keepNext: true })
    const head = ['', 'Whisky', 'Bewertung', 'Beschreibung']
    let rows = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${head.map((h, i) => cell(COLS[i], para(run(h, { b: true, sz: 18 })), 'E7E0D2')).join('')}</w:tr>`
    for (const { t, ratings, avg } of g.rows) {
      // Bild
      let imgPara = ''
      const im = imgs && imgs.get ? imgs.get(t.id) : null
      if (im && im.bytes) {
        n++
        const rid = `rId${n}`
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/etikett${n}.jpg"/>`)
        media.push([`word/media/etikett${n}.jpg`, im.bytes])
        const ratio = im.w && im.h ? im.h / im.w : 4 / 3
        let w = 2.2 * EMU
        let h = w * ratio
        if (h > 3.4 * EMU) { h = 3.4 * EMU; w = h / ratio }
        imgPara = para(drawing(rid, n, Math.round(w), Math.round(h)))
      }
      // Whisky
      const meta = metaOf(t)
      let whisky = para(run(titleOf(t) || 'Unbenannt', { b: true, sz: 20 }), { after: 40 })
      if (meta) whisky += para(run(meta, { color: '666666', sz: 18 }))
      // Bewertung
      let rate = ''
      for (const r of ratings) {
        const label = `${r.rater}: `
        const stars = r.stars ? `${starsText(r.stars)} ${fmtStar(r.stars)}` : '–'
        rate += para(run(label, { b: true, sz: 18 }) + run(stars, { color: 'B07A10', sz: 20 }) + (r.special ? run('  ✦ außergewöhnlich', { b: true, color: 'B07A10', sz: 18 }) : ''), { after: 40 })
      }
      if (ratings.filter(r => r.stars).length > 1) rate += para(run(`Ø ${fmtAvg(avg)}`, { color: '666666', sz: 18 }))
      // Beschreibung
      let desc = ''
      for (const r of ratings) {
        if (!String(r.note || '').trim()) continue
        desc += para((ratings.length > 1 ? run(`${r.rater}: `, { b: true, sz: 18 }) : '') + run(String(r.note).trim(), { sz: 18 }), { after: 60 })
      }
      rows += `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(COLS[0], imgPara)}${cell(COLS[1], whisky)}${cell(COLS[2], rate)}${cell(COLS[3], desc)}</w:tr>`
    }
    const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('')
    body += `<w:tbl><w:tblPr><w:tblW w:w="${COLS.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${COLS.map(c => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`
    body += para('')
  }

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`],
    ...media,
  ]
  return zipFiles(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}
