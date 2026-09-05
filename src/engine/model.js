// ============================================================================
// model.js — โครงสร้างข้อมูล + ค่าคงที่
//
// JS บริสุทธิ์ ห้ามแตะ DOM (ต้อง import ด้วย node ได้ตรง ๆ)
//
// แนวคิดสำคัญ:
//   - engine ผูกกับปฏิทินจริงเฉพาะผ่าน `days` + `firstWeekday` เท่านั้น
//     (year/month เป็นข้อมูลเสริมของ UI — engine ไม่อ่าน)
//   - วันในโค้ด engine เป็น dayIndex 0-based; ไฟล์บันทึกใช้เลขวันที่ 1-based
// ============================================================================

/** กะทำงาน */
export const SHIFT = { MORNING: 'ช', AFTERNOON: 'บ', NIGHT: 'ด' };

/** สถานะไม่ขึ้นเวรปกติ
 *   R = หยุดที่คนล็อกเอง (locked off)
 *   O = หยุดที่ระบบเติมให้ครบโควตา (auto-off ที่ solver ใส่) — นับเป็นวันหยุดเหมือน R
 *   V = ลา
 *   T = อบรม
 */
export const OFF = { LOCKED: 'R', FILLED: 'O', LEAVE: 'V', TRAINING: 'T' };

export const SHIFT_VALUES = [SHIFT.MORNING, SHIFT.AFTERNOON, SHIFT.NIGHT];
export const OFF_VALUES = [OFF.LOCKED, OFF.FILLED, OFF.LEAVE, OFF.TRAINING];

/** ทั้ง R และ O ถือเป็น "วันหยุด" ในการนับโควตา/วันทำงาน */
export const OFF_AS_REST = [OFF.LOCKED, OFF.FILLED];

/** ลำดับกะที่ถือว่า "หมุนไปข้างหน้า": ช → บ → ด */
export const ROTATION_ORDER = [SHIFT.MORNING, SHIFT.AFTERNOON, SHIFT.NIGHT];

// ---- ปฏิทินไทย: อาทิตย์ = 0 (ตรงกับ Date.getDay()) ----
export const WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
export const WEEKDAY_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
export const WEEKEND_INDICES = [0, 6]; // อาทิตย์, เสาร์

const WEEKDAY_ALIASES = {
  'พฤหัส': 'พฤหัสบดี',
  'พฤหัสฯ': 'พฤหัสบดี',
  'อาทิตย': 'อาทิตย์',
};

/** ชื่อวัน (ไทย, รับ alias สั้น) → index 0..6 */
export function weekdayIndex(name) {
  if (typeof name === 'number') {
    if (name >= 0 && name <= 6) return name;
    throw new Error(`weekday index นอกช่วง: ${name}`);
  }
  const key = String(name).trim();
  const canonical = WEEKDAY_ALIASES[key] || key;
  const idx = WEEKDAYS.indexOf(canonical);
  if (idx === -1) throw new Error(`ไม่รู้จักชื่อวัน: "${name}"`);
  return idx;
}

// ---------------------------------------------------------------------------
// CELL
// ---------------------------------------------------------------------------

/** ช่องในตาราง — ทำงาน (shifts) กับ หยุด (off) เป็น exclusive กัน */
export function makeCell() {
  return { shifts: [], off: null, locked: false };
}

export function isWorking(cell) { return cell.shifts.length > 0; }
export function isOff(cell) { return cell.off !== null; }
export function isEmpty(cell) { return cell.shifts.length === 0 && cell.off === null; }
export function isDouble(cell) { return cell.shifts.length >= 2; }
export function isRest(cell) { return OFF_AS_REST.includes(cell.off); }
export function isLeave(cell) { return cell.off === OFF.LEAVE; }
export function isTraining(cell) { return cell.off === OFF.TRAINING; }

/** ตั้งเป็นกะทำงาน (ล้าง off) */
export function setCellShifts(cell, shifts) {
  const list = Array.isArray(shifts) ? shifts : [shifts];
  for (const s of list) {
    if (!SHIFT_VALUES.includes(s)) throw new Error(`ค่ากะไม่ถูกต้อง: "${s}"`);
  }
  cell.shifts = [...list];
  cell.off = null;
  return cell;
}

/** ตั้งเป็นวันหยุด/ลา/อบรม (ล้าง shifts) */
export function setCellOff(cell, off) {
  if (!OFF_VALUES.includes(off)) throw new Error(`ค่าหยุดไม่ถูกต้อง: "${off}"`);
  cell.off = off;
  cell.shifts = [];
  return cell;
}

export function clearCellValue(cell) {
  cell.shifts = [];
  cell.off = null;
  return cell;
}

export function cloneCell(cell) {
  return { shifts: [...cell.shifts], off: cell.off, locked: cell.locked };
}

// ---------------------------------------------------------------------------
// STAFF
// ---------------------------------------------------------------------------

/** token กะที่ตั้งเป็น "เงื่อนไขรายบุคคล" ได้ */
export const ALLOW_TOKENS = ['ช', 'บ', 'ด', 'ช+บ', 'บ+ด', 'ช+ด'];

export function makeStaff({ id, name, role = '', team = '', teamColor = '', allow = [] }) {
  return { id, name, role, team, teamColor, allow: [...allow] };
}

/**
 * พยาบาลคนนี้ขึ้นกะชุดนี้ได้ไหม (ตาม staff.allow)
 *   allow ว่าง = ทำได้ทุกกะ
 *   หยุด/ลา/อบรม (shifts ว่าง) = ไม่เกี่ยว คืน true เสมอ
 */
export function staffAllowsShift(staff, shifts) {
  const allow = staff && staff.allow;
  if (!allow || allow.length === 0) return true;
  if (!shifts || shifts.length === 0) return true;
  return allow.includes(formatDoublePattern(shifts));
}

// ---------------------------------------------------------------------------
// ROSTER
// ---------------------------------------------------------------------------

/**
 * สร้าง roster เปล่า
 * @param {{days:number, firstWeekday:string|number, staff?:object[], year?:number|null, month?:number|null}} opts
 */
export function makeRoster({ days, firstWeekday, staff = [], year = null, month = null }) {
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw new Error(`จำนวนวันไม่ถูกต้อง: ${days}`);
  }
  const fwi = weekdayIndex(firstWeekday);
  const roster = {
    year: year ?? null,
    month: month ?? null,
    days,
    firstWeekday: WEEKDAYS[fwi],
    firstWeekdayIndex: fwi,
    staff: [],
    grid: [],
    _seq: 0, // ตัวนับ id — เดินหน้าอย่างเดียว ไม่ถอยเมื่อลบแถว (กัน id ชนกัน)
  };
  for (const s of staff) addStaff(roster, s);
  return roster;
}

function nextStaffId(roster, provided) {
  if (provided) return provided;
  // เดินจากตัวนับที่ไม่ถอยหลัง — ลบแถวแล้วเพิ่มใหม่จะไม่ได้ id ซ้ำของเดิม
  roster._seq = (roster._seq || 0) + 1;
  return `p${roster._seq}`;
}

export function addStaff(roster, entry) {
  const id = nextStaffId(roster, entry && entry.id);
  roster.staff.push(makeStaff({ ...entry, id }));
  roster.grid.push(Array.from({ length: roster.days }, makeCell));
  return id;
}

export function removeStaff(roster, staffIndex) {
  roster.staff.splice(staffIndex, 1);
  roster.grid.splice(staffIndex, 1);
}

export function staffIndexById(roster, id) {
  return roster.staff.findIndex((s) => s.id === id);
}

export function getCell(roster, staffIndex, dayIndex) {
  const row = roster.grid[staffIndex];
  return row ? row[dayIndex] : undefined;
}

export function cloneRoster(roster) {
  return {
    year: roster.year,
    month: roster.month,
    days: roster.days,
    firstWeekday: roster.firstWeekday,
    firstWeekdayIndex: roster.firstWeekdayIndex,
    _seq: roster._seq || 0,
    staff: roster.staff.map((s) => ({ ...s, allow: [...(s.allow || [])] })),
    grid: roster.grid.map((row) => row.map(cloneCell)),
  };
}

// ---------------------------------------------------------------------------
// ปฏิทินภายใน roster
// ---------------------------------------------------------------------------

/** dayIndex (0-based) → weekday index 0..6 */
export function weekdayIndexForDay(roster, dayIndex) {
  return (roster.firstWeekdayIndex + dayIndex) % 7;
}

export function weekdayNameForDay(roster, dayIndex) {
  return WEEKDAYS[weekdayIndexForDay(roster, dayIndex)];
}

export function isWeekend(roster, dayIndex) {
  return WEEKEND_INDICES.includes(weekdayIndexForDay(roster, dayIndex));
}

/** dayIndex ที่เป็นวันแรกของแต่ละสัปดาห์ (ไว้ตีเส้นหนาทุก 7 วันใน UI) */
export function isWeekBoundary(roster, dayIndex) {
  return dayIndex > 0 && weekdayIndexForDay(roster, dayIndex) === roster.firstWeekdayIndex;
}

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

export function defaultRules() {
  return {
    // จำนวนคนต่อกะต่อวัน — เป็นช่วง { min, max } (min===max = ต้องเป๊ะ, max=null = ไม่มีเพดาน)
    activeShifts: [SHIFT.MORNING, SHIFT.AFTERNOON, SHIFT.NIGHT], // เอากะออก = ตัดจากลิสต์นี้
    target: {
      [SHIFT.MORNING]: { min: 4, max: 4 },
      [SHIFT.AFTERNOON]: { min: 3, max: 3 },
      [SHIFT.NIGHT]: { min: 2, max: 2 },
    },
    targetOverrides: [],            // { weekday?, day?, shift, min, max }
    offQuota: 6,
    offQuotaMode: 'exact',          // 'exact' | 'max'
    countLeaveInQuota: false,
    keepExcessLockedOff: true,
    // ขึ้น 2 กะ/วัน ได้ทุกแบบเมื่อจำเป็น — ไม่ล็อกว่าต้องเป็นคู่ไหน
    // (ตัดออกจากลิสต์ = ห้ามคู่นั้น; ลิสต์ว่าง = ห้ามขึ้น 2 กะ/วัน ทั้งหมด)
    allowedDoubles: ['ช+บ', 'บ+ด', 'ช+ด'],
    maxNightToMorning: 0,            // ด → เช้าวันรุ่งขึ้น: ห้ามเด็ดขาด (0 = ผิดกฎเสมอ)
    maxConsecutiveNights: 2,
    maxConsecutiveWork: 5,
    maxConsecutiveOff: 2,
    maxDoublesPerPerson: 4,
    minGapBetweenDoubles: 3,
    lockedShiftsEditable: false,
    fairnessPriority: 'totalShifts', // 'offDays' | 'totalShifts' | 'nights' | 'weekends'
    weights: { safety: 500, coverage: 1000, workload: 120, fairness: 30 },
  };
}

/**
 * ทำค่าเป้าให้เป็นช่วงมาตรฐาน { min, max }
 *   number n            -> { min:n, max:n }
 *   { min }             -> { min, max:min }
 *   { min, max:null }   -> { min, max:null }  (ไม่มีเพดาน)
 *   { min, max }        -> ตามนั้น
 */
export function normalizeBand(value) {
  if (value == null) return { min: 0, max: 0 };
  if (typeof value === 'number') return { min: value, max: value };
  const min = Number.isFinite(value.min) ? value.min : 0;
  const max = value.max === null ? null : (Number.isFinite(value.max) ? value.max : min);
  return { min, max };
}

/** รวม rules ที่ผู้ใช้ให้มาทับค่าเริ่มต้น (deep เฉพาะ target/weights/overrides) */
export function mergeRules(partial = {}) {
  const base = defaultRules();
  const merged = { ...base, ...partial };

  merged.activeShifts = [...(partial.activeShifts || base.activeShifts)];

  const rawTarget = { ...base.target, ...(partial.target || {}) };
  merged.target = {};
  for (const s of SHIFT_VALUES) merged.target[s] = normalizeBand(rawTarget[s]);

  merged.targetOverrides = (partial.targetOverrides || base.targetOverrides).map((o) => {
    // รองรับรูปแบบเก่า { ..., target: n }
    const band = 'target' in o ? normalizeBand(o.target) : normalizeBand({ min: o.min, max: o.max });
    const out = { shift: o.shift, min: band.min, max: band.max };
    if (o.weekday != null) out.weekday = o.weekday;
    if (o.day != null) out.day = Number(o.day);
    return out;
  });

  merged.weights = { ...base.weights, ...(partial.weights || {}) };
  merged.allowedDoubles = [...(partial.allowedDoubles || base.allowedDoubles)];
  return merged;
}

export function isShiftActive(rules, shift) {
  return rules.activeShifts.includes(shift);
}

/** parse 'ช+บ' → ['ช','บ'] (เรียงตาม ROTATION_ORDER) */
export function parseDoublePattern(pattern) {
  const parts = String(pattern).split('+').map((p) => p.trim());
  for (const p of parts) {
    if (!SHIFT_VALUES.includes(p)) throw new Error(`รูปแบบกะ 2 กะ/วัน ไม่ถูกต้อง: "${pattern}"`);
  }
  return [...parts].sort((a, b) => ROTATION_ORDER.indexOf(a) - ROTATION_ORDER.indexOf(b));
}

/** ['ช','บ'] → 'ช+บ' (เรียงตาม ROTATION_ORDER) */
export function formatDoublePattern(shifts) {
  return [...shifts].sort((a, b) => ROTATION_ORDER.indexOf(a) - ROTATION_ORDER.indexOf(b)).join('+');
}

export function isDoubleAllowed(rules, shifts) {
  if (shifts.length < 2) return true;
  const key = formatDoublePattern(shifts);
  return rules.allowedDoubles.some((p) => formatDoublePattern(parseDoublePattern(p)) === key);
}

/**
 * ช่วงจำนวนคนของกะหนึ่งในวันหนึ่ง โดยคิด targetOverrides
 * ลำดับ: ค่าฐาน → override ตามวันในสัปดาห์ → override ตามเลขวันที่ (เลขวันที่ชนะ)
 * กะที่ปิด (ไม่อยู่ใน activeShifts) → { min:0, max:0 }
 * @returns {{min:number, max:number|null}}
 */
export function bandForDay(roster, rules, dayIndex, shift) {
  if (!isShiftActive(rules, shift)) return { min: 0, max: 0 };
  let band = { ...rules.target[shift] };
  const day1 = dayIndex + 1;

  for (const ov of rules.targetOverrides) {
    if (ov.shift !== shift) continue;
    if (ov.weekday != null && weekdayIndex(ov.weekday) === weekdayIndexForDay(roster, dayIndex)) {
      band = { min: ov.min, max: ov.max };
    }
  }
  for (const ov of rules.targetOverrides) {
    if (ov.shift !== shift) continue;
    if (ov.day != null && Number(ov.day) === day1) {
      band = { min: ov.min, max: ov.max };
    }
  }
  return band;
}

/** เป้าขั้นต่ำของกะในวันนั้น (ใช้บ่อยใน analyze) */
export function minStaffForDay(roster, rules, dayIndex, shift) {
  return bandForDay(roster, rules, dayIndex, shift).min;
}

/** ผลรวมเป้าขั้นต่ำทุกกะทั้งเดือน = slotsNeeded */
export function totalSlotsNeeded(roster, rules) {
  let total = 0;
  for (let d = 0; d < roster.days; d++) {
    for (const s of rules.activeShifts) total += bandForDay(roster, rules, d, s).min;
  }
  return total;
}
