// ============================================================================
// csv.js — นำเข้า/ส่งออก CSV (เปิด/บันทึกผ่าน Excel ได้ตรง ๆ)
//
// JS บริสุทธิ์ ห้ามแตะ DOM
//
// รูปแบบ:  แถวแรก = "ชื่อ",1,2,3,...,D   (หัวเป็นเลขวันที่)
//          แถวถัดไป = ชื่อพยาบาล, token แต่ละวัน (ว่าง = ช่องว่าง)
//   token: ช บ ด | ช+บ / ชบ (2 กะ/วัน) | R O V T
//   แถวสรุป/รวมท้ายไฟล์ (ขึ้นต้นด้วย "รวม"/"ขึ้นเวร"/"หยุด") จะถูกข้าม
// ============================================================================

import { cellToToken } from './io.js';

/** แยกข้อความ CSV → array ของ array (รองรับฟิลด์ในเครื่องหมายคำพูด) */
export function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // ตัด BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      /* ข้าม */
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const FOOTER_RE = /^(รวม|ขึ้นเวร|หยุด|เป้า|โควตา)/;

/**
 * CSV → { days, staff:[{name, locked:{day:token}}] }
 * (ส่งต่อเข้า parseRoster ได้เลย)
 */
export function csvToStaffGrid(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) throw new Error('CSV ต้องมีหัวตาราง + อย่างน้อย 1 แถว');

  const header = rows[0];
  // นับคอลัมน์วันที่จากหัวที่เป็นตัวเลขติดกันหลังคอลัมน์แรก
  let days = 0;
  for (let i = 1; i < header.length; i++) {
    if (/^\d+$/.test(header[i].trim())) days++;
    else break;
  }
  if (days === 0) days = header.length - 1;
  if (days < 1 || days > 31) throw new Error(`จำนวนวันจาก CSV ไม่ถูกต้อง: ${days}`);

  const staff = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const name = (cells[0] || '').trim();
    if (!name || FOOTER_RE.test(name)) continue;
    const locked = {};
    for (let d = 0; d < days; d++) {
      const tok = (cells[d + 1] || '').trim();
      if (tok) locked[String(d + 1)] = tok;
    }
    staff.push({ name, locked });
  }
  if (!staff.length) throw new Error('CSV ไม่พบแถวพยาบาล');
  return { days, staff };
}

/** roster → ข้อความ CSV (มี BOM ให้ Excel อ่านภาษาไทยถูก) */
export function rosterToCsv(roster) {
  const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['ชื่อ'];
  for (let d = 1; d <= roster.days; d++) head.push(String(d));
  const lines = [head.map(esc).join(',')];

  roster.staff.forEach((s, si) => {
    const row = [s.name];
    for (let d = 0; d < roster.days; d++) row.push(cellToToken(roster.grid[si][d]) || '');
    lines.push(row.map(esc).join(','));
  });
  return '﻿' + lines.join('\r\n');
}
