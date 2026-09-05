// ============================================================================
// xlsx.js — ส่งออกตารางเวรเป็นไฟล์ Excel (.xlsx) โดยไม่พึ่งไลบรารีภายนอก
//
// JS บริสุทธิ์ ห้ามแตะ DOM — คืน Uint8Array (UI เอาไปห่อ Blob เอง)
//
// .xlsx = ZIP (แบบ "stored" ไม่บีบอัด) ที่บรรจุไฟล์ XML ตามสเปก OOXML:
//   [Content_Types].xml, _rels/.rels, xl/workbook.xml,
//   xl/_rels/workbook.xml.rels, xl/styles.xml, xl/worksheets/sheet1.xml
// ============================================================================

import { SHIFT, WEEKDAY_SHORT } from './model.js';
import { cellToToken } from './io.js';

// ---------------------------------------------------------------------------
// CRC32 + ZIP (stored)
// ---------------------------------------------------------------------------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u8concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** files: [{ name, bytes:Uint8Array }] → Uint8Array ของ zip */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const put = (a) => { parts.push(a); offset += a.length; };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const localAt = offset;
    put(u8concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
    ]));
    put(nameBytes);
    put(f.bytes);
    central.push(u8concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(localAt), nameBytes,
    ]));
  }

  const cdAt = offset;
  let cdSize = 0;
  for (const c of central) { put(c); cdSize += c.length; }
  put(u8concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(central.length), u16(central.length),
    u32(cdSize), u32(cdAt), u16(0),
  ]));

  return u8concat(parts);
}

// ---------------------------------------------------------------------------
// XML helper
// ---------------------------------------------------------------------------
function xmlEsc(s) {
  return String(s)
    // ตัด control char ที่ XML 1.0 ไม่รับ (เหลือ \t \n \r) — กัน .xlsx เปิดไม่ได้
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}

/** เลขคอลัมน์ 1-based → ตัวอักษร (1→A, 27→AA) */
function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

// ดัชนี style ใน cellXfs (ดู styles.xml ด้านล่าง)
const ST = {
  DEFAULT: 0, HEAD: 1, CENTER: 2, NAME: 3, WKND: 4,
  ch: 5, b: 6, d: 7, DBL: 8, R: 9, O: 10, V: 11, T: 12,
  TITLE: 13, FOOT: 14, SUM: 15,
};

function tokenStyle(tok, weekend) {
  if (!tok) return weekend ? ST.WKND : ST.CENTER;
  if (tok.includes('+')) return ST.DBL;
  return ST[tok] != null ? ST[tok] : ST.CENTER;
}

function cStr(ref, style, text) {
  if (text === '' || text == null) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}
function cNum(ref, style, n) {
  return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
}

// ---------------------------------------------------------------------------
// styles.xml
// ---------------------------------------------------------------------------
const FILL_RGB = [
  null, null,          // 0 none, 1 gray125 (สงวนไว้)
  'FFF2F2F2',          // 2 header
  'FFFDEDED',          // 3 weekend
  'FFFEF3C7',          // 4 ช
  'FFFFE4D5',          // 5 บ
  'FFDBEAFE',          // 6 ด
  'FFFDE68A',          // 7 2 กะ/วัน
  'FFF1F5F9',          // 8 R
  'FFE2E8F0',          // 9 O
  'FFF3E8FF',          // 10 V
  'FFDCFCE7',          // 11 T
];

function stylesXml() {
  const fills = FILL_RGB.map((rgb, i) => {
    if (i === 0) return '<fill><patternFill patternType="none"/></fill>';
    if (i === 1) return '<fill><patternFill patternType="gray125"/></fill>';
    return `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  }).join('');

  const align = (h) => `<alignment horizontal="${h}" vertical="center"/>`;
  const XF = (font, fill, border, h) =>
    `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" `
    + `applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align(h)}</xf>`;

  const cellXfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', // 0 DEFAULT
    XF(1, 2, 1, 'center'),   // 1 HEAD
    XF(0, 0, 1, 'center'),   // 2 CENTER
    XF(1, 0, 1, 'left'),     // 3 NAME
    XF(0, 3, 1, 'center'),   // 4 WKND (ว่าง)
    XF(0, 4, 1, 'center'),   // 5 ช
    XF(0, 5, 1, 'center'),   // 6 บ
    XF(0, 6, 1, 'center'),   // 7 ด
    XF(1, 7, 1, 'center'),   // 8 2 กะ/วัน
    XF(0, 8, 1, 'center'),   // 9 R
    XF(0, 9, 1, 'center'),   // 10 O
    XF(0, 10, 1, 'center'),  // 11 V
    XF(0, 11, 1, 'center'),  // 12 T
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>', // 13 TITLE
    XF(1, 2, 1, 'left'),     // 14 FOOT label
    XF(1, 2, 1, 'center'),   // 15 SUM number
  ];

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="3">'
    + '<font><sz val="11"/><name val="Tahoma"/></font>'
    + '<font><b/><sz val="11"/><name val="Tahoma"/></font>'
    + '<font><b/><sz val="14"/><name val="Tahoma"/></font>'
    + '</fonts>'
    + `<fills count="${FILL_RGB.length}">${fills}</fills>`
    + '<borders count="2">'
    + '<border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border>'
    + '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>'
    + '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom>'
    + '<diagonal/></border>'
    + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>`
    + '</styleSheet>';
}

// ---------------------------------------------------------------------------
// worksheet
// ---------------------------------------------------------------------------
const XLSX_TH_MONTH = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

function sheetXml(roster, rules, report) {
  const D = roster.days;
  const N = roster.staff.length;
  const fwi = roster.firstWeekdayIndex;
  const isWknd = (d) => {
    const wd = (fwi + d) % 7;
    return wd === 0 || wd === 6;
  };
  const lastCol = D + 7;               // 1 ชื่อ + D วัน + 6 สรุป
  const SUM_C0 = D + 2;                // คอลัมน์แรกของบล็อกสรุป

  const cov = {};
  for (const c of report.coverage) cov[c.day + '|' + c.shift] = c.assigned;

  const rows = [];

  // แถว 1 — หัวเรื่อง
  const title = (roster.year && roster.month)
    ? `ตารางเวร ${XLSX_TH_MONTH[roster.month - 1]} ${roster.year}`
    : `ตารางเวร ${D} วัน`;
  rows.push(`<row r="1">${cStr('A1', ST.TITLE, title)}</row>`);

  // แถว 2 — หัวคอลัมน์ (ชื่อ | 1..D | รวมวันทำงาน | ช | บ | ด | ช+บ | O+R)
  {
    const cells = [cStr('A2', ST.HEAD, 'ชื่อ')];
    for (let d = 0; d < D; d++) cells.push(cNum(colName(d + 2) + '2', ST.HEAD, d + 1));
    const labels = ['รวมวันทำงาน', 'ช', 'บ', 'ด', 'ช+บ', 'วันหยุด O+R'];
    labels.forEach((lb, i) => cells.push(cStr(colName(SUM_C0 + i) + '2', ST.HEAD, lb)));
    rows.push(`<row r="2">${cells.join('')}</row>`);
  }

  // แถว 3 — ชื่อวัน
  {
    const cells = [cStr('A3', ST.HEAD, '')];
    for (let d = 0; d < D; d++) {
      cells.push(cStr(colName(d + 2) + '3', ST.HEAD, WEEKDAY_SHORT[(fwi + d) % 7]));
    }
    for (let i = 0; i < 6; i++) cells.push(cStr(colName(SUM_C0 + i) + '3', ST.HEAD, ''));
    rows.push(`<row r="3">${cells.join('')}</row>`);
  }

  // แถวพยาบาล
  roster.staff.forEach((staff, si) => {
    const rn = si + 4;
    const p = report.perPerson[si];
    const cells = [cStr('A' + rn, ST.NAME, staff.name)];
    for (let d = 0; d < D; d++) {
      const tok = cellToToken(roster.grid[si][d]) || '';
      cells.push(cStr(colName(d + 2) + rn, tokenStyle(tok, isWknd(d)), tok));
    }
    const sums = [p.work, p.byShift[SHIFT.MORNING], p.byShift[SHIFT.AFTERNOON], p.byShift[SHIFT.NIGHT], p.doubles, p.rest];
    sums.forEach((v, i) => cells.push(cNum(colName(SUM_C0 + i) + rn, ST.SUM, v)));
    rows.push(`<row r="${rn}">${cells.join('')}</row>`);
  });

  // แถวสรุปท้าย
  const footRow = (rn, label, valueFn) => {
    const cells = [cStr('A' + rn, ST.FOOT, label)];
    for (let d = 0; d < D; d++) cells.push(cNum(colName(d + 2) + rn, ST.CENTER, valueFn(d)));
    for (let i = 0; i < 6; i++) cells.push(cStr(colName(SUM_C0 + i) + rn, ST.FOOT, ''));
    return `<row r="${rn}">${cells.join('')}</row>`;
  };
  let rn = N + 4;
  for (const sh of [SHIFT.MORNING, SHIFT.AFTERNOON, SHIFT.NIGHT]) {
    rows.push(footRow(rn++, `รวม ${sh}`, (d) => cov[(d + 1) + '|' + sh] || 0));
  }
  rows.push(footRow(rn++, 'ขึ้นเวรวันนั้น (คน)', (d) => {
    let n = 0;
    for (let i = 0; i < N; i++) if (roster.grid[i][d].shifts.length > 0) n++;
    return n;
  }));
  rows.push(footRow(rn++, 'หยุด R+O', (d) => {
    let n = 0;
    for (let i = 0; i < N; i++) { const o = roster.grid[i][d].off; if (o === 'R' || o === 'O') n++; }
    return n;
  }));

  const dim = `A1:${colName(lastCol)}${rn - 1}`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dim}"/>`
    + '<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
    + '<pane xSplit="1" ySplit="3" topLeftCell="B4" activePane="bottomRight" state="frozen"/>'
    + '<selection pane="bottomRight" activeCell="B4" sqref="B4"/>'
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="16"/>'
    + '<cols>'
    + '<col min="1" max="1" width="16" customWidth="1"/>'
    + `<col min="2" max="${D + 1}" width="3.6" customWidth="1"/>`
    + `<col min="${SUM_C0}" max="${SUM_C0}" width="13" customWidth="1"/>`
    + `<col min="${SUM_C0 + 1}" max="${lastCol}" width="5.5" customWidth="1"/>`
    + '</cols>'
    + `<sheetData>${rows.join('')}</sheetData>`
    + `<mergeCells count="1"><mergeCell ref="A1:${colName(Math.min(lastCol, 8))}1"/></mergeCells>`
    + '</worksheet>';
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
/**
 * @param {object} roster
 * @param {object} rules
 * @param {object} report  ผลจาก analyze(roster, rules)
 * @returns {Uint8Array}
 */
export function rosterToXlsx(roster, rules, report) {
  const enc = new TextEncoder();
  const file = (name, str) => ({ name, bytes: enc.encode(str) });

  const files = [
    file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'),
    file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'),
    file('xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="ตารางเวร" sheetId="1" r:id="rId1"/></sheets>'
      + '</workbook>'),
    file('xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>'),
    file('xl/styles.xml', stylesXml()),
    file('xl/worksheets/sheet1.xml', sheetXml(roster, rules, report)),
  ];

  return zipStore(files);
}
