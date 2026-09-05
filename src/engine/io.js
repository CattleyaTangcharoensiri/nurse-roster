// ============================================================================
// io.js — อ่าน/เขียนไฟล์บันทึกงาน
//
// รูปแบบไฟล์: คีย์เป็น "เลขวันที่" เสมอ (1-based) — ห้ามลิสต์เรียงตามตำแหน่ง
//
//   {
//     "days": 30,
//     "firstWeekday": "อังคาร",
//     "rules": { ... },                 // ไม่บังคับ (ไม่มี = ใช้ค่าเริ่มต้น)
//     "staff": [
//       { "name": "พยาบาล A",
//         "locked": { "1":"บ", "9":"R", "19":"ช+บ" },   // ตั้งค่า + ล็อก
//         "filled": { "3":"ด" } }                        // ตั้งค่า ไม่ล็อก (ไม่บังคับ)
//     ]
//   }
//
// token ของช่อง:  "ช" | "บ" | "ด" | "ช+บ" (ขึ้น 2 กะ/วัน) | "R" | "O" | "V" | "T"
// วันที่ไม่ระบุ = ช่องว่าง
// ============================================================================

import {
  makeRoster,
  addStaff,
  setCellShifts,
  setCellOff,
  mergeRules,
  parseDoublePattern,
  formatDoublePattern,
  SHIFT_VALUES,
  OFF_VALUES,
  ALLOW_TOKENS,
} from './model.js';

// ---------------------------------------------------------------------------
// TOKEN <-> CELL
// ---------------------------------------------------------------------------

/** "ช" / "ช+บ" / "R" → { shifts, off }  (โยน error ถ้า token เพี้ยน) */
export function parseCellToken(token) {
  const t = String(token).trim();
  if (t === '') throw new Error('token ว่าง');

  if (OFF_VALUES.includes(t)) {
    return { shifts: [], off: t };
  }
  if (t.includes('+')) {
    return { shifts: parseDoublePattern(t), off: null };
  }
  if (SHIFT_VALUES.includes(t)) {
    return { shifts: [t], off: null };
  }
  // 2 กะ/วัน แบบเขียนติดกัน เช่น "ชบ" (แบบในเอกสารโรงพยาบาล)
  if ([...t].length === 2 && [...t].every((ch) => SHIFT_VALUES.includes(ch))) {
    return { shifts: parseDoublePattern([...t].join('+')), off: null };
  }
  throw new Error(`token ไม่รู้จัก: "${token}" (ต้องเป็น ช/บ/ด/ช+บ/R/O/V/T)`);
}

/** cell → token string หรือ null ถ้าช่องว่าง */
export function cellToToken(cell) {
  if (cell.shifts.length >= 2) return formatDoublePattern(cell.shifts);
  if (cell.shifts.length === 1) return cell.shifts[0];
  if (cell.off !== null) return cell.off;
  return null;
}

// ---------------------------------------------------------------------------
// PARSE
// ---------------------------------------------------------------------------

/**
 * อ่าน doc (object หรือ JSON string) → { roster, rules, warnings }
 * @param {object|string} input
 * @param {{strict?:boolean}} [opts]  strict=true จะโยน error แทนการเก็บ warning
 */
export function parseRoster(input, opts = {}) {
  const strict = !!opts.strict;
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const warnings = [];

  const fail = (msg) => {
    if (strict) throw new Error(msg);
    warnings.push(msg);
  };

  if (!doc || typeof doc !== 'object') throw new Error('ไฟล์บันทึกไม่ใช่ object');
  if (!Number.isInteger(doc.days)) throw new Error('ไฟล์บันทึกต้องมี "days" เป็นจำนวนเต็ม');
  if (doc.firstWeekday == null) throw new Error('ไฟล์บันทึกต้องมี "firstWeekday"');

  const rules = mergeRules(doc.rules || {});
  const roster = makeRoster({
    days: doc.days,
    firstWeekday: doc.firstWeekday,
    year: doc.year ?? null,
    month: doc.month ?? null,
  });

  const staffList = Array.isArray(doc.staff) ? doc.staff : [];
  staffList.forEach((entry, si) => {
    if (!entry || typeof entry !== 'object') {
      fail(`staff[${si}] ไม่ใช่ object — ข้าม`);
      return;
    }
    const label = entry.name || `staff[${si}]`;
    const staffIndex = roster.staff.length;
    addStaff(roster, {
      id: entry.id,
      name: entry.name || `พนักงาน ${si + 1}`,
      role: entry.role || '',
      team: entry.team || '',
      teamColor: entry.teamColor || '',
      allow: (Array.isArray(entry.allow) ? entry.allow : []).filter((t) => ALLOW_TOKENS.includes(t)),
    });

    applyDayDict(roster, staffIndex, entry.locked, true, label, doc.days, fail);
    applyDayDict(roster, staffIndex, entry.filled, false, label, doc.days, fail);
  });

  return { roster, rules, warnings };
}

function applyDayDict(roster, staffIndex, dict, locked, label, days, fail) {
  if (dict == null) return;
  if (typeof dict !== 'object') {
    fail(`${label}: ฟิลด์ ${locked ? 'locked' : 'filled'} ไม่ใช่ object — ข้าม`);
    return;
  }
  for (const [dayKey, token] of Object.entries(dict)) {
    const dayNum = Number(dayKey);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > days) {
      fail(`${label}: เลขวันที่ "${dayKey}" นอกช่วง 1..${days} — ข้าม`);
      continue;
    }
    const dayIndex = dayNum - 1;
    const cell = roster.grid[staffIndex][dayIndex];

    if (cell.shifts.length > 0 || cell.off !== null) {
      // ช่องนี้ถูกกำหนดไปแล้ว (locked มาก่อน filled) — locked ชนะ
      if (locked) {
        fail(`${label}: วันที่ ${dayNum} ซ้ำใน locked — ใช้ค่าหลัง`);
      } else {
        fail(`${label}: วันที่ ${dayNum} อยู่ทั้ง locked และ filled — คง locked ไว้`);
        continue;
      }
    }

    let parsed;
    try {
      parsed = parseCellToken(token);
    } catch (err) {
      fail(`${label}: วันที่ ${dayNum} — ${err.message}`);
      continue;
    }

    if (parsed.off !== null) setCellOff(cell, parsed.off);
    else setCellShifts(cell, parsed.shifts);
    cell.locked = locked;
  }
}

// ---------------------------------------------------------------------------
// SERIALIZE
// ---------------------------------------------------------------------------

/**
 * roster (+ rules) → plain object พร้อม JSON.stringify
 * เขียน `locked` เสมอ, `filled` เฉพาะเมื่อมีช่องที่เติมแล้วไม่ล็อก
 */
export function serializeRoster(roster, rules = null) {
  const doc = {
    days: roster.days,
    firstWeekday: roster.firstWeekday,
  };
  if (roster.year != null) doc.year = roster.year;
  if (roster.month != null) doc.month = roster.month;
  if (rules) doc.rules = rules;

  doc.staff = roster.staff.map((s, si) => {
    const entry = { name: s.name };
    if (s.role) entry.role = s.role;
    if (s.team) entry.team = s.team;
    if (s.teamColor) entry.teamColor = s.teamColor;
    if (s.allow && s.allow.length) entry.allow = [...s.allow];

    const locked = {};
    const filled = {};
    roster.grid[si].forEach((cell, di) => {
      const token = cellToToken(cell);
      if (token == null) return;
      (cell.locked ? locked : filled)[String(di + 1)] = token;
    });
    entry.locked = locked;
    if (Object.keys(filled).length > 0) entry.filled = filled;
    return entry;
  });

  return doc;
}

/** helper: serialize แล้ว stringify สวย ๆ สำหรับดาวน์โหลด */
export function toJSONString(roster, rules = null) {
  return JSON.stringify(serializeRoster(roster, rules), null, 2);
}
