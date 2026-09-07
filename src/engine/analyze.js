// ============================================================================
// analyze.js — วิเคราะห์ตารางเวร
//
// JS บริสุทธิ์ ห้ามแตะ DOM (ต้อง import ด้วย node ได้ตรง ๆ)
//
// รับ roster (จาก model.js) + rules (ผ่าน mergeRules มาแล้ว) แล้วคืน object เดียว
// ที่ตอบ 3 คำถาม:
//   1. feasibility — ตารางนี้ "มีทางจัดให้ครบ" ไหม (slot ที่ต้องการ vs วันว่างที่มี)
//   2. coverage    — แต่ละกะแต่ละวันตอนนี้คนพอ/ขาด/เกิน เท่าไร
//   3. violations  — กฎที่ "ถูกละเมิดแล้ว" จากช่องที่ล็อก/เติมไว้
//
// ทุกค่า `day` ในผลลัพธ์เป็นเลขวันที่ 1-based (ตรงกับไฟล์บันทึกและหน้าจอ)
//
// หมายเหตุสำคัญ: ดต่อเช้า (night→morning) นับ `ด` ที่อยู่ในกะ 2 กะ/วัน (เช่น บ+ด) ด้วย —
//   ถ้าวัน N มี ด และวัน N+1 มี ช (กะเดียวหรือรวมอยู่ใน ช+บ / ช+ด) = ผิดกฎ
// ============================================================================

import {
  SHIFT, OFF,
  isRest, isLeave, isTraining, isWorking, isEmpty,
  isWeekend,
  bandForDay, isShiftActive, isDoubleAllowed, formatDoublePattern,
  staffAllowsShift, doublesFeasibility,
} from './model.js';

// ---------------------------------------------------------------------------
// helper ระดับช่อง
// ---------------------------------------------------------------------------

/** ช่องนี้มีกะ `shift` ไหม (นับกะที่รวมอยู่ใน ช+บ / บ+ด / ช+ด ด้วย) */
function hasShift(cell, shift) {
  return cell.shifts.includes(shift);
}

/** จำนวน slot ที่ช่องนี้กิน: กะเดียว = 1, 2 กะ/วัน = 2, หยุด/ว่าง = 0 */
function slotsInCell(cell) {
  return cell.shifts.length;
}

/** วันนี้ "ไม่พร้อมทำงาน" (หยุด/ลา/อบรม) */
function isAway(cell) {
  return isRest(cell) || isLeave(cell) || isTraining(cell);
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

/**
 * @param {object} roster  — จาก makeRoster/parseRoster
 * @param {object} rules   — จาก mergeRules
 * @param {{manyOffThreshold?:number}} [opts]
 */
export function analyze(roster, rules, opts = {}) {
  const manyOffThreshold = opts.manyOffThreshold ?? 3;
  const D = roster.days;
  const N = roster.staff.length;
  const activeShifts = rules.activeShifts.filter((s) => isShiftActive(rules, s));

  // ---- slot ที่ทั้งเดือนต้องการ (ต่ำสุด / เพดานรวม) ----
  let slotsNeeded = 0;
  let slotsMax = 0;
  let slotsMaxUnbounded = false;
  for (let d = 0; d < D; d++) {
    for (const s of activeShifts) {
      const band = bandForDay(roster, rules, d, s);
      slotsNeeded += band.min;
      if (band.max === null) slotsMaxUnbounded = true;
      else slotsMax += band.max;
    }
  }

  // ---- เดินกริดทีละคน: สถิติ + run-length ----
  let assignedSlots = 0;
  let emptyDays = 0;
  let restDays = 0;
  let leaveDays = 0;
  let trainingDays = 0;

  const perPerson = roster.staff.map((s) => ({
    staffId: s.id,
    name: s.name,
    team: s.team || '',
    work: 0,        // จำนวน "วันที่ขึ้นเวร" (2 กะ/วัน นับ 1 วัน)
    byShift: { [SHIFT.MORNING]: 0, [SHIFT.AFTERNOON]: 0, [SHIFT.NIGHT]: 0 }, // นับกะ (รวมที่อยู่ใน 2 กะ/วัน)
    doubles: 0,
    nights: 0,
    weekends: 0,    // วันหยุดสุดสัปดาห์ที่ต้องขึ้นเวร
    rest: 0,        // R + O
    leave: 0,       // V
    training: 0,    // T
    empty: 0,
    offCounted: 0,  // วันที่นับเข้าโควตาหยุด
    maxConsecutiveWork: 0,
    maxConsecutiveNights: 0,
    maxConsecutiveOff: 0,
  }));

  for (let i = 0; i < N; i++) {
    const row = roster.grid[i];
    const p = perPerson[i];
    let runWork = 0;
    let runNight = 0;
    let runOff = 0;

    for (let d = 0; d < D; d++) {
      const cell = row[d];
      const n = slotsInCell(cell);
      assignedSlots += n;

      if (n > 0) {
        p.work += 1;
        if (n >= 2) p.doubles += 1;
        for (const sh of cell.shifts) p.byShift[sh] += 1;
        if (hasShift(cell, SHIFT.NIGHT)) p.nights += 1;
        if (isWeekend(roster, d)) p.weekends += 1;
        runWork += 1;
        if (runWork > p.maxConsecutiveWork) p.maxConsecutiveWork = runWork;
      } else {
        runWork = 0;
      }

      if (hasShift(cell, SHIFT.NIGHT)) {
        runNight += 1;
        if (runNight > p.maxConsecutiveNights) p.maxConsecutiveNights = runNight;
      } else {
        runNight = 0;
      }

      if (isRest(cell)) {
        p.rest += 1;
        restDays += 1;
        runOff += 1;
        if (runOff > p.maxConsecutiveOff) p.maxConsecutiveOff = runOff;
      } else {
        runOff = 0;
      }

      if (isLeave(cell)) { p.leave += 1; leaveDays += 1; }
      if (isTraining(cell)) { p.training += 1; trainingDays += 1; }
      if (isEmpty(cell)) { p.empty += 1; emptyDays += 1; }
    }

    p.offCounted = p.rest + (rules.countLeaveInQuota ? p.leave : 0);
  }

  // ---- coverage รายวัน/รายกะ + วันที่คนหยุดเยอะ ----
  const coverage = [];
  const gaps = [];
  const daysManyOff = [];

  for (let d = 0; d < D; d++) {
    let offToday = 0;
    for (let i = 0; i < N; i++) {
      const cell = roster.grid[i][d];
      if (isRest(cell) || isLeave(cell)) offToday += 1;
    }
    if (offToday >= manyOffThreshold) {
      daysManyOff.push({ day: d + 1, off: offToday, available: N - offToday });
    }

    for (const s of activeShifts) {
      const band = bandForDay(roster, rules, d, s);
      let assigned = 0;
      for (let i = 0; i < N; i++) {
        if (hasShift(roster.grid[i][d], s)) assigned += 1;
      }
      let status = 'ok';
      if (assigned < band.min) status = 'under';
      else if (band.max !== null && assigned > band.max) status = 'over';

      const entry = { day: d + 1, shift: s, assigned, min: band.min, max: band.max, status };
      coverage.push(entry);
      if (status !== 'ok') gaps.push(entry);
    }
  }

  // ---- violations ----
  const violations = [];
  const add = (v) => violations.push(v);

  for (let i = 0; i < N; i++) {
    const row = roster.grid[i];
    const p = perPerson[i];
    const who = { staffId: roster.staff[i].id, name: roster.staff[i].name };

    // ด→ช — นับ ด/ช ที่รวมอยู่ในกะ 2 กะ/วันด้วย
    const n2m = [];
    for (let d = 0; d < D - 1; d++) {
      if (hasShift(row[d], SHIFT.NIGHT) && hasShift(row[d + 1], SHIFT.MORNING)) n2m.push(d);
    }
    if (n2m.length > (rules.maxNightToMorning || 0)) {
      for (const d of n2m) {
        add({
          type: 'nightToMorning', severity: 'error', ...who, day: d + 1,
          message: `${who.name}: ด (วันที่ ${d + 1}) → ช (วันที่ ${d + 2})`,
        });
      }
    }

    // กะ 2 กะ/วัน ที่ไม่อยู่ในลิสต์ allowedDoubles
    for (let d = 0; d < D; d++) {
      const cell = row[d];
      if (cell.shifts.length >= 2 && !isDoubleAllowed(rules, cell.shifts)) {
        const pattern = formatDoublePattern(cell.shifts);
        add({
          type: 'doubleNotAllowed', severity: 'error', ...who, day: d + 1, pattern,
          message: `${who.name}: ${pattern} ไม่อนุญาต (วันที่ ${d + 1})`,
        });
      }
    }

    // กะที่ไม่ตรงเงื่อนไขรายบุคคล (staff.allow)
    for (let d = 0; d < D; d++) {
      const cell = row[d];
      if (cell.shifts.length > 0 && !staffAllowsShift(roster.staff[i], cell.shifts)) {
        const pattern = formatDoublePattern(cell.shifts);
        add({
          type: 'shiftNotAllowed', severity: 'error', ...who, day: d + 1, pattern,
          message: `${who.name}: ${pattern} (วันที่ ${d + 1}) ไม่ใช่กะที่ทำได้ (จำกัด: ${roster.staff[i].allow.join(' ')})`,
        });
      }
    }

    // ด ติดกันเกินเพดาน
    if (p.maxConsecutiveNights > rules.maxConsecutiveNights) {
      add({
        type: 'consecutiveNights', severity: 'error', ...who,
        count: p.maxConsecutiveNights, limit: rules.maxConsecutiveNights,
        message: `${who.name}: ด ติดกัน ${p.maxConsecutiveNights} วัน (เพดาน ${rules.maxConsecutiveNights})`,
      });
    }

    // ช/บ/ด ติดกันเกินเพดาน
    if (p.maxConsecutiveWork > rules.maxConsecutiveWork) {
      add({
        type: 'consecutiveWork', severity: 'warn', ...who,
        count: p.maxConsecutiveWork, limit: rules.maxConsecutiveWork,
        message: `${who.name}: ช/บ/ด ติดกัน ${p.maxConsecutiveWork} วัน (เพดาน ${rules.maxConsecutiveWork})`,
      });
    }

    // R/O ติดกันเกินเพดาน
    if (p.maxConsecutiveOff > rules.maxConsecutiveOff) {
      add({
        type: 'consecutiveOff', severity: 'warn', ...who,
        count: p.maxConsecutiveOff, limit: rules.maxConsecutiveOff,
        message: `${who.name}: R/O ติดกัน ${p.maxConsecutiveOff} วัน (เพดาน ${rules.maxConsecutiveOff})`,
      });
    }

    // ขึ้น 2 กะ/วัน เยอะเกินเพดานต่อคน
    if (p.doubles > rules.maxDoublesPerPerson) {
      add({
        type: 'tooManyDoubles', severity: 'warn', ...who,
        count: p.doubles, limit: rules.maxDoublesPerPerson,
        message: `${who.name}: ขึ้น 2 กะ/วัน ${p.doubles} ครั้ง (เพดาน ${rules.maxDoublesPerPerson})`,
      });
    }

    // ระยะห่างระหว่างวันที่ขึ้น 2 กะ/วัน สองครั้งติดกัน
    const dblDays = [];
    for (let d = 0; d < D; d++) if (row[d].shifts.length >= 2) dblDays.push(d);
    for (let k = 1; k < dblDays.length; k++) {
      const gap = dblDays[k] - dblDays[k - 1];
      if (gap < rules.minGapBetweenDoubles) {
        add({
          type: 'doubleGapTooSmall', severity: 'warn', ...who,
          day: dblDays[k - 1] + 1, nextDay: dblDays[k] + 1, gap, limit: rules.minGapBetweenDoubles,
          message: `${who.name}: ขึ้น 2 กะ/วัน วันที่ ${dblDays[k - 1] + 1} กับ ${dblDays[k] + 1} ห่างกัน ${gap} วัน (ต้อง ≥ ${rules.minGapBetweenDoubles})`,
        });
      }
    }

    // วันหยุด O+R เทียบโควตา — ยกเว้นคนที่ "ล็อก" วันหยุดไว้เกินโควตาอยู่แล้ว
    {
      let lockedRest = 0;
      let emptyCells = 0;
      for (let d = 0; d < D; d++) {
        const cell = row[d];
        if (cell.locked && isRest(cell)) lockedRest += 1;
        if (isEmpty(cell)) emptyCells += 1;
      }
      const total = p.offCounted;
      const quota = rules.offQuota;
      const kinds = rules.countLeaveInQuota ? 'R+O+V' : 'R+O';
      if (lockedRest > quota) {
        add({
          type: 'restLockedOver', severity: 'warn', ...who,
          count: lockedRest, quota,
          message: `${who.name}: ล็อกวันหยุดไว้ ${lockedRest} วัน (เกินโควตา ${quota}) — ยกเว้นให้`,
        });
      } else if (total > quota) {
        add({
          type: 'restOver', severity: 'error', ...who,
          count: total, quota,
          message: `${who.name}: ${kinds} ${total} วัน เกินโควตา ${quota}`,
        });
      } else if (rules.offQuotaMode === 'exact' && total < quota && emptyCells === 0) {
        add({
          type: 'restShort', severity: 'error', ...who,
          count: total, quota,
          message: `${who.name}: ${kinds} ${total} วัน ขาดโควตา ${quota}`,
        });
      }
    }
  }

  // coverage ที่ "เกินเพดาน" ตอนนี้ = คนถูกล็อกไว้เกิน → ละเมิด
  for (const g of gaps) {
    if (g.status === 'over') {
      add({
        type: 'coverageOver', severity: 'error',
        day: g.day, shift: g.shift, count: g.assigned, max: g.max,
        message: `วันที่ ${g.day} ${g.shift}: ${g.assigned} คน (เพดาน ${g.max})`,
      });
    }
  }

  // ---- feasibility ----
  const doublesExisting = perPerson.reduce((a, p) => a + p.doubles, 0);
  const workDaysAvailable = N * D - restDays - leaveDays - trainingDays;
  // เติมช่องว่างทุกช่องเป็นกะเดียว จะได้ slot รวมเท่านี้
  const capacitySingles = assignedSlots + emptyDays;
  const doublesNeeded = Math.max(0, slotsNeeded - capacitySingles);
  const doubleCapacity = perPerson.reduce(
    (a, p) => a + Math.max(0, rules.maxDoublesPerPerson - p.doubles), 0,
  );

  const reasons = [];
  if (N === 0) reasons.push('ไม่มีพนักงาน');
  if (doublesNeeded > doubleCapacity) {
    reasons.push(`ต้องเพิ่มวันขึ้น 2 กะ/วัน อีก ${doublesNeeded} ครั้ง แต่เพดานรวมรับได้อีก ${doubleCapacity}`);
  }
  if (!slotsMaxUnbounded && assignedSlots > slotsMax) {
    reasons.push(`กะที่ล็อก/เติมไว้ (${assignedSlots}) เกินเพดานรวม (${slotsMax})`);
  }

  const feasibility = {
    slotsNeeded,
    slotsMax: slotsMaxUnbounded ? null : slotsMax,
    assignedSlots,
    workDaysAvailable,
    emptyDays,
    restDays,
    leaveDays,
    trainingDays,
    doublesExisting,
    doublesNeeded,
    doubleCapacity,
    avgDoublesPerPerson: N ? Number((doublesNeeded / N).toFixed(2)) : 0,
    feasible: reasons.length === 0,
    reasons,
  };

  return {
    days: D,
    staffCount: N,
    activeShifts,
    feasibility,
    coverage,
    gaps,
    daysManyOff,
    violations,
    perPerson,
    advice: advise(roster, rules),
    summary: {
      errors: violations.filter((v) => v.severity === 'error').length,
      warnings: violations.filter((v) => v.severity === 'warn').length,
      under: gaps.filter((g) => g.status === 'under').length,
      over: gaps.filter((g) => g.status === 'over').length,
    },
  };
}

// ---------------------------------------------------------------------------
// advise — คำแนะนำเชิงตัวเลข "สำหรับเดือนนี้โดยเฉพาะ"
//
// ตอบคำถาม: ด้วยจำนวนวันของเดือนนี้ + เป้ารายวัน + โควตาหยุด ที่ตั้งไว้
//   จะให้ "ทุกคนหยุดตรงโควตา" ได้ไหม ต้องเวรคู่กี่ครั้ง ถ้าไม่อยากอัดเวรคู่
//   ควรปรับจำนวนคน / โควตา / เป้า เป็นเท่าไร
//
// สูตรหลัก:  เวรคู่ที่ต้องใช้ = (กะที่ต้องการทั้งเดือน) − (วันทำงานรวมถ้าทุกคนหยุด Q)
//            วันทำงานรวม = N·(D − Q) − (วันลา/อบรมที่ไม่นับเข้าโควตา)
// ---------------------------------------------------------------------------
export function advise(roster, rules) {
  const D = roster.days;
  const N = roster.staff.length;
  const Q = rules.offQuota;
  const cap = Math.max(0, rules.maxDoublesPerPerson);

  // สูตรกลาง (model.js) — solver.restViaDoubles ใช้ตัวเดียวกันเป็นเกต
  const { slotsNeeded: S, away, leave, training, doublesNeeded, doubleCapacity } = doublesFeasibility(roster, rules);
  const doublesAt = (n) => S - (n * (D - Q) - away);

  // ช่วงจำนวนคนที่ "ทุกคนหยุด Q พอดี" เป็นไปได้
  const nMax = D - Q > 0 ? Math.floor((S + away) / (D - Q)) : 0;          // เกินนี้ = คนล้น
  const nMin = D - Q + cap > 0 ? Math.ceil((S + away) / (D - Q + cap)) : nMax;

  const base = {
    days: D, staff: N, quota: Q, shiftsNeeded: S,
    doublesNeeded, doubleCapacity,
    avgPerPerson: N ? Number((doublesNeeded / N).toFixed(2)) : 0,
    feasibleStaff: { min: nMin, max: nMax },
  };

  if (N === 0) return { ...base, status: 'empty', lines: ['ยังไม่มีพยาบาล'], table: [] };

  const table = [];
  for (let n = Math.max(1, nMin); n <= Math.max(nMin, nMax); n++) {
    table.push({ staff: n, doubles: doublesAt(n) });
  }

  const lines = [];
  let status;

  if (D - Q <= 0) {
    status = 'under';
    lines.push(`โควตาหยุด ${Q} ≥ จำนวนวัน (${D}) — ตั้งใหม่ให้ต่ำกว่า ${D}`);
    return { ...base, status, lines, table: [] };
  }

  if (doublesNeeded < 0) {
    status = 'over';
    const qFit = Math.round((N * D - S - leave - training) / N);
    lines.push(`${N} คน มากไปสำหรับ ${D} วัน + หยุด ${Q} — งานเกินมา ${-doublesNeeded} กะ บางคนต้องหยุดเกิน ${Q}`);
    lines.push(`ลดเหลือ ${nMax} คน → ทุกคนหยุด ${Q} พอดี (เวรคู่ ${doublesAt(nMax)} ครั้ง)`);
    lines.push(`หรือคง ${N} คน แล้วตั้งโควตาหยุด = ${qFit}`);
  } else if (doublesNeeded > doubleCapacity) {
    status = 'under';
    lines.push(`${N} คน น้อยไป — ต้องเวรคู่ ${doublesNeeded} ครั้ง แต่เพดานรวมรับได้แค่ ${doubleCapacity}`);
    if (nMax >= nMin) lines.push(`เพิ่มเป็น ${nMin}–${nMax} คน (${nMax} คน → เวรคู่ ${doublesAt(nMax)} ครั้ง)`);
    lines.push(`หรือลดเป้ารายวัน / ลดโควตาหยุด / เพิ่มเพดานเวรคู่ต่อคน`);
  } else {
    const avg = doublesNeeded / N;
    if (avg <= 0.75) {
      status = 'ok';
      lines.push(`${D} วัน · ${N} คน · หยุด ${Q} → จัดได้สบาย` + (doublesNeeded ? ` (เวรคู่ ${doublesNeeded} ครั้ง)` : ' (ไม่ต้องเวรคู่)'));
    } else {
      status = 'tight';
      const how = avg > 2 ? 'แน่นมาก อ่านยาก' : 'ตารางจะแน่น';
      lines.push(`จัดได้ แต่ต้องเวรคู่ ${doublesNeeded} ครั้ง (เฉลี่ย ${avg.toFixed(1)}/คน) — ${how}`);
      if (nMax > N) lines.push(`เพิ่มเป็น ${nMax} คน → เวรคู่เหลือ ${doublesAt(nMax)} ครั้ง`);
      else lines.push(`รับได้ก็ปล่อยไว้ตามนี้`);
    }
  }

  return { ...base, status, lines, table };
}
