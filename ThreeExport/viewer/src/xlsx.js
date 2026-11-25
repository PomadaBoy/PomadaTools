// A minimal .xlsx writer, no library: one sheet of Office Open XML in a zip (files stored,
// not compressed). Numbers are written as numbers with a number format, so Excel adds them
// up whatever the reader's region and decimal separator.

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of [{ name, data: Uint8Array }], stored. */
export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);        // version needed to extract
    local.setUint16(6, 0x0800, true);    // UTF-8 names
    local.setUint16(8, 0, true);         // stored
    local.setUint16(12, 0x21, true);     // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// characters XML 1.0 does not allow, then the five escapes
const xml = (s) => String(s)
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const MAX_PLACES = 6;
// cellXfs indexes (styles.xml below)
const XF = { title: 1, muted: 2, head: 3, headRight: 4, bold: 5 };
const numberXf = (places, bold) => 6 + (bold ? MAX_PLACES + 1 : 0) + Math.max(0, Math.min(MAX_PLACES, places));

function stylesXml() {
  const fmts = Array.from({ length: MAX_PLACES + 1 }, (_, p) =>
    `<numFmt numFmtId="${164 + p}" formatCode="${p ? `#,##0.${'0'.repeat(p)}` : '#,##0'}"/>`).join('');
  const num = (bold) => Array.from({ length: MAX_PLACES + 1 }, (_, p) =>
    `<xf numFmtId="${164 + p}" fontId="${bold ? 1 : 0}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"${bold ? ' applyFont="1"' : ''}/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<numFmts count="${MAX_PLACES + 1}">${fmts}</numFmts>` +
    '<fonts count="4">' +
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="11"/><color rgb="FF5A6473"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE6EFFD"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FF8A94A3"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${6 + 2 * (MAX_PLACES + 1)}">` +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    num(false) + num(true) +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/**
 * The bytes of an .xlsx with one sheet.
 *   name    sheet name (cut to Excel's 31 characters)
 *   rows    [[cell]], a cell: null | string | number | { v, style: 'title'|'muted'|'head'|'bold', places, align }
 *   widths  column widths in characters
 *   freeze  rows to keep in view at the top
 */
export function xlsx({ name = 'Sheet1', rows, widths = [], freeze = 0 }) {
  const body = [];
  rows.forEach((row, r) => {
    const cells = [];
    row.forEach((cell, c) => {
      if (cell == null || cell === '') return;
      const o = typeof cell === 'object' ? cell : { v: cell };
      if (o.v == null || o.v === '') {
        if (o.style) cells.push(`<c r="${columnName(c)}${r + 1}" s="${XF[o.style] ?? 0}"/>`);
        return;
      }
      const ref = `${columnName(c)}${r + 1}`;
      if (typeof o.v === 'number' && Number.isFinite(o.v)) {
        cells.push(`<c r="${ref}" s="${numberXf(o.places ?? 2, o.style === 'bold')}"><v>${o.v}</v></c>`);
      } else {
        const s = o.style === 'head' && o.align === 'right' ? XF.headRight : XF[o.style] ?? 0;
        const t = xml(o.v);
        const space = /^\s|\s$/.test(t) ? ' xml:space="preserve"' : '';
        cells.push(`<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t${space}>${t}</t></is></c>`);
      }
    });
    if (cells.length) body.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const pane = freeze > 0
    ? `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
    : '';
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `${cols}<sheetData>${body.join('')}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>';
  const sheetName = xml(String(name).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet1');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/styles.xml': stylesXml(),
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zip(Object.entries(files).map(([n, text]) => ({ name: n, data: enc.encode(text) })));
}
