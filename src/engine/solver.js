// ============================================================================
// solver.js — จัดตารางเวรอัตโนมัติ (เติมช่องว่างให้ครอบคลุม)
//
// JS บริสุทธิ์ ห้ามแตะ DOM
//
// วิธี:
//   1) constructive — ไล่เติมกะให้ถึงขั้นต่ำของแต่ละกะแต่ละวัน (ด ก่อน แล้ว ช, บ)
//   2) polish — สุ่มปรับช่องที่ไม่ล็อก รับเฉพาะที่คะแนนดีขึ้น (hill-climb)
//   3) fillRest / balanceRest — เติมช่องว่างที่เหลือเป็น O แล้วเกลี่ยให้ตรงโควตา
//   4) restViaDoubles (เฉพาะโหมด exact) — คนที่หยุดไม่ถึงโควตา ยกกะเดียวไปเป็น
//      กะที่ 2 ของเพื่อนร่วมกะ เพื่อปิดช่องว่างวันหยุดโดย coverage คงเดิม
//
// กติกาที่ "ห้ามละเมิดเด็ดขาด" ระหว่างจัด:
//   - ไม่แตะช่องที่ล็อก / ลา (V) / อบรม (T)
//   - ด (วันที่ N) → ช (วันที่ N+1) ห้าม  (นับ ด/ช ที่รวมอยู่ในกะ 2 กะ/วันด้วย)
//   - กะ 2 กะ/วัน ต้องอยู่ใน allowedDoubles
//   - ห้ามเกินเพดานคนต่อกะ (band.max), maxConsecutiveNights, maxConsecutiveWork,
//     maxDoublesPerPerson, minGapBetweenDoubles
// ============================================================================

import {
  SHIFT, OFF, ROTATION_ORDER,
  cloneRoster, isWeekend,
  bandForDay, isShiftActive, isDoubleAllowed, staffAllowsShift,
} from './model.js';

// ลำดับความสำคัญตอนเติม: ด ยากสุด → ช → บ
const FILL_ORDER = [SHIFT.NIGHT, SHIFT.MORNING, SHIFT.AFTERNOON];

// ---------------------------------------------------------------------------
// RNG (seeded, ผลซ้ำได้)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];

// ---------------------------------------------------------------------------
// helper ระดับช่อง (raw — ไม่ validate, เร็ว)
// ---------------------------------------------------------------------------
function sortShifts(arr) {
  return [...arr].sort((x, y) => ROTATION_ORDER.indexOf(x) - ROTATION_ORDER.indexOf(y));
}
function setShifts(cell, arr) { cell.shifts = sortShifts(arr); cell.off = null; }
function setOff(cell, off) { cell.shifts = []; cell.off = off; }
function clearCell(cell) { cell.shifts = []; cell.off = null; }
function snap(cell) { return { shifts: [...cell.shifts], off: cell.off, locked: cell.locked }; }
function restore(cell, s) { cell.shifts = [...s.shifts]; cell.off = s.off; cell.locked = s.locked; }

function isFixed(cell) {
  return cell.locked || cell.off === OFF.LEAVE || cell.off === OFF.TRAINING;
}
function assignedCount(roster, d, shift) {
  let n = 0;
  for (const row of roster.grid) if (row[d].shifts.includes(shift)) n++;
  return n;
}
function personDoubles(row, exceptDay) {
  const days = [];
  for (let k = 0; k < row.length; k++) if (k !== exceptDay && row[k].shifts.length >= 2) days.push(k);
  return days;
}

// ---------------------------------------------------------------------------
// ตรวจกติกา "ห้ามเด็ดขาด" ของช่อง (i,d) หลังใส่ค่าแล้ว
// ---------------------------------------------------------------------------
function cellHardOK(roster, rules, i, d) {
  const row = roster.grid[i];
  const cell = row[d];
  if (cell.shifts.length === 0) return true;
  const last = row.length - 1;

  // เงื่อนไขรายบุคคล
  if (!staffAllowsShift(roster.staff[i], cell.shifts)) return false;

  if (cell.shifts.length >= 2) {
    if (!isDoubleAllowed(rules, cell.shifts)) return false;
    const others = personDoubles(row, d);
    if (others.length + 1 > rules.maxDoublesPerPerson) return false;
    for (const k of others) if (Math.abs(k - d) < rules.minGapBetweenDoubles) return false;
  }

  // ด→ช
  if (cell.shifts.includes(SHIFT.MORNING) && d > 0 && row[d - 1].shifts.includes(SHIFT.NIGHT)) return false;
  if (cell.shifts.includes(SHIFT.NIGHT) && d < last && row[d + 1].shifts.includes(SHIFT.MORNING)) return false;

  // ด ติดกัน
  if (cell.shifts.includes(SHIFT.NIGHT)) {
    let run = 1;
    for (let k = d - 1; k >= 0 && row[k].shifts.includes(SHIFT.NIGHT); k--) run++;
    for (let k = d + 1; k <= last && row[k].shifts.includes(SHIFT.NIGHT); k++) run++;
    if (run > rules.maxConsecutiveNights) return false;
  }

  // ช/บ/ด ติดกัน
  {
    let run = 1;
    for (let k = d - 1; k >= 0 && row[k].shifts.length > 0; k--) run++;
    for (let k = d + 1; k <= last && row[k].shifts.length > 0; k++) run++;
    if (run > rules.maxConsecutiveWork) return false;
  }
  return true;
}

function coverageMaxOK(roster, rules, d) {
  for (const s of rules.activeShifts) {
    if (!isShiftActive(rules, s)) continue;
    const band = bandForDay(roster, rules, d, s);
    if (band.max != null && assignedCount(roster, d, s) > band.max) return false;
  }
  return true;
}

/** ลองใส่ shifts ที่ช่อง (i,d) — คืน true ถ้าผ่านกติกาห้าม (คงค่าไว้), ไม่ผ่าน = คืนค่าเดิม */
function tryPut(roster, rules, i, d, shifts) {
  const cell = roster.grid[i][d];
  if (isFixed(cell)) return false;
  const sv = snap(cell);
  if (shifts.length === 0) setOff(cell, OFF.FILLED);
  else setShifts(cell, shifts);
  cell.locked = false;
  const last = roster.days - 1;
  const ok = cellHardOK(roster, rules, i, d)
    && coverageMaxOK(roster, rules, d)
    && (d <= 0 || cellHardOK(roster, rules, i, d - 1))
    && (d >= last || cellHardOK(roster, rules, i, d + 1));
  if (!ok) { restore(cell, sv); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// คะแนน (ยิ่งน้อยยิ่งดี)
// ---------------------------------------------------------------------------
function spread(arr) {
  if (arr.length < 2) return 0;
  return Math.max(...arr) - Math.min(...arr);
}

export function cost(roster, rules) {
  const D = roster.days;
  const N = roster.staff.length;
  const W = rules.weights;
  const active = rules.activeShifts.filter((s) => isShiftActive(rules, s));

  let coverage = 0;
  let safety = 0;
  let workload = 0;

  for (let d = 0; d < D; d++) {
    for (const s of active) {
      const band = bandForDay(roster, rules, d, s);
      const a = assignedCount(roster, d, s);
      if (a < band.min) coverage += band.min - a;
      if (band.max != null && a > band.max) coverage += (a - band.max) * 2;
    }
  }

  const loads = [];
  const nights = [];
  const weekends = [];
  let totalDoubles = 0;

  for (let i = 0; i < N; i++) {
    const row = roster.grid[i];
    let w = 0; let n = 0; let we = 0; let off = 0; let leave = 0; let db = 0;
    let runW = 0; let runN = 0; let runO = 0;

    for (let d = 0; d < D; d++) {
      const cell = row[d];
      const k = cell.shifts.length;
      if (k > 0) {
        w += k;
        if (k >= 2) db++;
        if (cell.shifts.includes(SHIFT.NIGHT)) n++;
        if (isWeekend(roster, d)) we++;
        runW++;
        if (runW > rules.maxConsecutiveWork) safety += runW - rules.maxConsecutiveWork;
        if (cell.shifts.includes(SHIFT.NIGHT)) {
          runN++;
          if (runN > rules.maxConsecutiveNights) safety += runN - rules.maxConsecutiveNights;
        } else runN = 0;
        runO = 0;
        if (k >= 2 && !isDoubleAllowed(rules, cell.shifts)) safety += 5;
        if (cell.shifts.includes(SHIFT.MORNING) && d > 0 && row[d - 1].shifts.includes(SHIFT.NIGHT)) safety += 10;
      } else {
        runW = 0; runN = 0;
        if (cell.off === OFF.LOCKED || cell.off === OFF.FILLED) {
          off++; runO++;
          if (runO > rules.maxConsecutiveOff) workload += runO - rules.maxConsecutiveOff;
        } else {
          runO = 0;
          if (cell.off === OFF.LEAVE) leave++;
        }
      }
    }

    if (db > rules.maxDoublesPerPerson) workload += (db - rules.maxDoublesPerPerson) * 3;
    const quota = off + (rules.countLeaveInQuota ? leave : 0);
    if (rules.offQuotaMode === 'exact') workload += Math.abs(quota - rules.offQuota);
    else workload += Math.max(0, quota - rules.offQuota);

    loads.push(w);
    nights.push(n);
    weekends.push(we);
    totalDoubles += db;
  }

  const fairness = spread(loads) + spread(nights) * 0.5 + spread(weekends) * 0.5;
  const total = safety * W.safety
    + coverage * W.coverage
    + workload * W.workload
    + fairness * W.fairness
    + totalDoubles * (W.workload * 0.4);

  return { total, coverage, safety, workload, fairness, doubles: totalDoubles };
}

// ---------------------------------------------------------------------------
// 1) constructive
// ---------------------------------------------------------------------------
function loadOf(row) {
  let n = 0;
  for (const c of row) n += c.shifts.length;
  return n;
}

function constructive(R, rules, rnd) {
  const D = R.days;
  const N = R.staff.length;
  const active = FILL_ORDER.filter((s) => isShiftActive(rules, s));

  for (let pass = 0; pass < 2; pass++) {
    for (let d = 0; d < D; d++) {
      for (const s of active) {
        const band = bandForDay(R, rules, d, s);
        let guard = 0;
        while (assignedCount(R, d, s) < band.min && guard++ < N * 2) {
          // ผู้สมัคร: ช่องว่าง/O ก่อน แล้วค่อยเป็นกะ 2 กะ/วัน
          const singles = [];
          const doubles = [];
          for (let i = 0; i < N; i++) {
            const cell = R.grid[i][d];
            if (isFixed(cell) || cell.shifts.includes(s) || cell.shifts.length >= 2) continue;
            if (cell.shifts.length === 0) singles.push(i);
            else doubles.push(i);
          }
          const orderBy = (list) => list
            .map((i) => ({ i, k: loadOf(R.grid[i]) + rnd() * 0.5 }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.i);

          let placed = false;
          for (const i of orderBy(singles)) {
            if (tryPut(R, rules, i, d, [s])) { placed = true; break; }
          }
          if (!placed) {
            for (const i of orderBy(doubles)) {
              const cur = R.grid[i][d].shifts[0];
              if (tryPut(R, rules, i, d, [cur, s])) { placed = true; break; }
            }
          }
          if (!placed) break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2) polish (hill-climb)
// ---------------------------------------------------------------------------
function polish(R, rules, rnd, iterations) {
  const D = R.days;
  const N = R.staff.length;
  const active = rules.activeShifts.filter((s) => isShiftActive(rules, s));
  let curCost = cost(R, rules).total;
  let best = cloneRoster(R);
  let bestCost = curCost;

  for (let it = 0; it < iterations; it++) {
    // เป้าหมาย: 60% เล็งไปที่กะที่ยังขาด
    let i; let d;
    const sv = [];
    const touched = [];

    if (rnd() < 0.6) {
      const shorts = [];
      for (let dd = 0; dd < D; dd++) {
        for (const s of active) {
          const b = bandForDay(R, rules, dd, s);
          if (assignedCount(R, dd, s) < b.min) shorts.push([dd, s]);
        }
      }
      if (!shorts.length) continue;
      const [dd, s] = pick(rnd, shorts);
      d = dd;
      const opts = [];
      for (let ii = 0; ii < N; ii++) {
        const c = R.grid[ii][d];
        if (isFixed(c) || c.shifts.includes(s) || c.shifts.length >= 2) continue;
        opts.push(ii);
      }
      if (!opts.length) continue;
      i = pick(rnd, opts);
      const cell = R.grid[i][d];
      sv.push(snap(cell)); touched.push([i, d]);
      const next = cell.shifts.length === 1 ? [cell.shifts[0], s] : [s];
      setShifts(cell, next);
      cell.locked = false;
    } else {
      i = (rnd() * N) | 0;
      d = (rnd() * D) | 0;
      const cell = R.grid[i][d];
      if (isFixed(cell)) continue;
      sv.push(snap(cell)); touched.push([i, d]);
      const r = rnd();
      if (r < 0.4) setShifts(cell, [pick(rnd, active)]);
      else if (r < 0.7) setOff(cell, OFF.FILLED);
      else if (r < 0.9 && cell.shifts.length === 1) {
        const other = active.filter((x) => x !== cell.shifts[0]);
        if (!other.length) { touched.pop(); sv.pop(); continue; }
        setShifts(cell, [cell.shifts[0], pick(rnd, other)]);
      } else clearCell(cell);
    }

    const last = D - 1;
    const ok = cellHardOK(R, rules, i, d)
      && coverageMaxOK(R, rules, d)
      && (d <= 0 || cellHardOK(R, rules, i, d - 1))
      && (d >= last || cellHardOK(R, rules, i, d + 1));

    let accept = false;
    if (ok) {
      const c = cost(R, rules).total;
      if (c <= curCost) { curCost = c; accept = true; if (c < bestCost) { bestCost = c; best = cloneRoster(R); } }
    }
    if (!accept) {
      for (let t = touched.length - 1; t >= 0; t--) {
        const [ti, td] = touched[t];
        restore(R.grid[ti][td], sv[t]);
      }
    }
  }
  return { roster: best, cost: bestCost };
}

// ---------------------------------------------------------------------------
// 3) จัดช่องว่างที่เหลือ — ลำดับความสำคัญ:
//    A) ปิด coverage ให้ถึงขั้นต่ำของทุกกะทุกวันก่อน (สำคัญสุด — คนไข้ต้องมีคนดูแล)
//    B) แล้วค่อยเติม O ให้ถึงโควตาหยุด
//    C) ช่องว่างที่เหลือ → เวร (ถ้ายังไม่ถึงเพดาน) มิฉะนั้น O
// ---------------------------------------------------------------------------
function fillRest(R, rules) {
  const active = rules.activeShifts.filter((s) => isShiftActive(rules, s));
  const D = R.days;
  const N = R.staff.length;

  const emptyAt = (i, d) => {
    const c = R.grid[i][d];
    return !c.locked && c.off === null && c.shifts.length === 0;
  };
  const byLoad = (list) => list
    .map((i) => ({ i, k: loadOf(R.grid[i]) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.i);

  // ---- A) coverage ก่อน ----
  for (let d = 0; d < D; d++) {
    for (const s of FILL_ORDER) {
      if (!active.includes(s)) continue;
      let guard = 0;
      while (assignedCount(R, d, s) < bandForDay(R, rules, d, s).min && guard++ < N * 2) {
        let placed = false;
        // 1) คนที่ช่องวันนั้นว่าง
        const free = [];
        for (let i = 0; i < N; i++) if (emptyAt(i, d)) free.push(i);
        for (const i of byLoad(free)) {
          if (tryPut(R, rules, i, d, [s])) { placed = true; break; }
        }
        // 2) ยังไม่พอ → ให้คนที่ทำงานกะเดียวอยู่แล้วขึ้นเป็น 2 กะ/วัน
        if (!placed) {
          const one = [];
          for (let i = 0; i < N; i++) {
            const c = R.grid[i][d];
            if (!c.locked && c.shifts.length === 1 && !c.shifts.includes(s)) one.push(i);
          }
          for (const i of byLoad(one)) {
            if (tryPut(R, rules, i, d, [R.grid[i][d].shifts[0], s])) { placed = true; break; }
          }
        }
        if (!placed) break; // จัดไม่ได้จริง ๆ (เช่นติดเพดานเวรติดกัน) — ปล่อยให้ report แจ้ง
      }
    }
  }

  // ---- B) เติม O ให้ถึงโควตาหยุด จากช่องที่ยังว่าง ----
  for (let i = 0; i < N; i++) {
    const row = R.grid[i];
    let lockedRest = 0;
    let rest = 0;
    let leave = 0;
    const empties = [];
    for (let d = 0; d < D; d++) {
      const c = row[d];
      if (c.off === OFF.LOCKED || c.off === OFF.FILLED) {
        rest += 1;
        if (c.locked) lockedRest += 1;
      } else if (c.off === OFF.LEAVE) {
        leave += 1;
      } else if (emptyAt(i, d)) {
        empties.push(d);
      }
    }
    const counted = rest + (rules.countLeaveInQuota ? leave : 0);
    // exact = ดันให้ถึงโควตา ; max = โควตาเป็นเพดาน ไม่ดัน
    const target = rules.offQuotaMode === 'exact'
      ? Math.max(lockedRest, rules.offQuota)
      : lockedRest;
    let need = target - counted;

    // วาง O แบบกระจาย — เลือกวันที่เพื่อนบ้านยังไม่หยุดก่อน (เลี่ยง O ติดกัน)
    const isRestNow = (d) => d >= 0 && d < D && (row[d].off === OFF.LOCKED || row[d].off === OFF.FILLED);
    const nbrRest = (d) => (isRestNow(d - 1) ? 1 : 0) + (isRestNow(d + 1) ? 1 : 0);
    const order = [...empties].sort((a, b) => nbrRest(a) - nbrRest(b) || a - b);
    for (const d of order) {
      if (need <= 0) break;
      row[d].off = OFF.FILLED;
      need -= 1;
    }
  }

  // ---- C) ช่องว่างที่เหลือ → เวร (ดูดซับ capacity) ไม่งั้น O ----
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) {
      if (!emptyAt(i, d)) continue;
      const c = R.grid[i][d];
      let placed = false;
      for (const s of active) {
        const band = bandForDay(R, rules, d, s);
        if (band.max != null && assignedCount(R, d, s) >= band.max) continue;
        const sv = snap(c);
        setShifts(c, [s]);
        const ok = cellHardOK(R, rules, i, d)
          && (d <= 0 || cellHardOK(R, rules, i, d - 1))
          && (d >= D - 1 || cellHardOK(R, rules, i, d + 1));
        if (ok) { placed = true; break; }
        restore(c, sv);
      }
      if (!placed) c.off = OFF.FILLED;
    }
  }
}

// ---------------------------------------------------------------------------
// 4) เกลี่ยวันหยุด O+R ให้ทุกคนใกล้โควตา (ย้ายเวรจากคนหยุดน้อย → คนหยุดเยอะ)
//    coverage ไม่เปลี่ยน เพราะเป็นการสลับเวรระหว่างคนในวันเดียวกัน
// ---------------------------------------------------------------------------
function balanceRest(R, rules) {
  const D = R.days;
  const N = R.staff.length;

  const restTarget = (i) => {
    let lr = 0;
    for (const c of R.grid[i]) if (c.locked && (c.off === OFF.LOCKED || c.off === OFF.FILLED)) lr += 1;
    return Math.max(lr, rules.offQuota);
  };
  const restCount = (i) => {
    let n = 0;
    for (const c of R.grid[i]) if (c.off === OFF.LOCKED || c.off === OFF.FILLED) n += 1;
    return n;
  };

  const trySwap = (over, under) => {
    for (let d = 0; d < D; d++) {
      const co = R.grid[over][d];
      const cu = R.grid[under][d];
      if (co.locked || cu.locked) continue;
      if (co.off !== OFF.FILLED) continue;      // over ต้องเป็น O ที่ระบบเติม
      if (cu.shifts.length !== 1) continue;     // under ทำงานกะเดียว
      const s = cu.shifts[0];
      const svo = snap(co);
      const svu = snap(cu);
      setShifts(co, [s]); co.locked = false;
      setOff(cu, OFF.FILLED); cu.locked = false;
      const ok = cellHardOK(R, rules, over, d)
        && (d <= 0 || cellHardOK(R, rules, over, d - 1))
        && (d >= D - 1 || cellHardOK(R, rules, over, d + 1))
        && (d <= 0 || cellHardOK(R, rules, under, d - 1))
        && (d >= D - 1 || cellHardOK(R, rules, under, d + 1));
      if (ok) return true;
      restore(co, svo);
      restore(cu, svu);
    }
    return false;
  };

  for (let guard = 0; guard < N * D; guard++) {
    const overs = [];
    const unders = [];
    for (let i = 0; i < N; i++) {
      const diff = restCount(i) - restTarget(i);
      if (diff > 0) overs.push(i);
      else if (diff < 0) unders.push(i);
    }
    if (!overs.length || !unders.length) break;

    let moved = false;
    for (const over of overs) {
      for (const under of unders) {
        if (trySwap(over, under)) { moved = true; break; }
      }
      if (moved) break;
    }
    if (!moved) break;
  }
}

// ---------------------------------------------------------------------------
// 5) ปิดช่องว่างวันหยุด: คนที่ยังหยุดไม่ถึงโควตา ยกกะเดียวของเขาไปเป็น
//    กะที่ 2 ของเพื่อนร่วมกะวันนั้น (coverage คงเดิม) แล้วช่องนั้นกลายเป็น O
//    ใช้เฉพาะโหมด exact — โหมด max โควตาเป็นเพดาน หยุดไม่ถึงไม่ผิด
//
//    การเลือก "วัน" ของเวรคู่: กระจายให้สม่ำเสมอตลอดเดือน — วางจุดเป้าหมาย
//    (slots) ห่างเท่า ๆ กันตามจำนวนเวรคู่ที่ต้องเติม แล้วแต่ละรอบเลือกท่าที่
//    วันใกล้ slot ที่สุด บวกกับเลือก "คนรับ" (taker) ที่ยังโดนเวรคู่น้อย
//    และห่างจากเวรคู่เดิมของตัวเอง เพื่อไม่ให้กระจุกทั้งแกนเวลาและรายคน
// ---------------------------------------------------------------------------
function restViaDoubles(R, rules) {
  if (rules.offQuotaMode !== 'exact') return;
  const D = R.days;
  const N = R.staff.length;
  const active = rules.activeShifts.filter((s) => isShiftActive(rules, s));

  // "ทุกคนหยุดตรงโควตา" เป็นไปได้ไหมด้วยการเวรคู่?
  //   เวรคู่ที่ต้องใช้ = กะที่ต้องการทั้งเดือน − วันทำงานรวมเมื่อทุกคนหยุด Q
  //   < 0  → คนล้น (บางคนต้องหยุดเกิน Q) — ดันวันหยุดไม่ได้อยู่ดี
  //   > เพดานรวม → คนไม่พอจริง — ปล่อยให้ report โชว์ gap + คนทำงานเยอะ ดีกว่าโชว์หยุดเต็มวอร์ดว่าง
  //   นอกนั้น → ทำได้ ลุยเลย (ข้าม "วันที่ยังขาดคน" ไว้ ไม่ไปยุ่งกับกะวันนั้น —
  //   applyMove เป็นการสลับในวันเดียว coverage คงเดิม จึงไม่ทำ gap แย่ลง)
  let slotsNeeded = 0;
  for (let d = 0; d < D; d++) for (const s of active) slotsNeeded += bandForDay(R, rules, d, s).min;
  let leaveT = 0;
  let trainT = 0;
  for (let i = 0; i < N; i++) {
    for (const c of R.grid[i]) {
      if (c.off === OFF.LEAVE) leaveT += 1;
      else if (c.off === OFF.TRAINING) trainT += 1;
    }
  }
  const away = trainT + (rules.countLeaveInQuota ? 0 : leaveT);
  const doublesNeededGlobal = slotsNeeded - (N * (D - rules.offQuota) - away);
  const doubleCapGlobal = N * Math.max(0, rules.maxDoublesPerPerson);
  if (doublesNeededGlobal < 0 || doublesNeededGlobal > doubleCapGlobal) return;

  const dayCovered = [];
  for (let d = 0; d < D; d++) {
    dayCovered[d] = active.every((s) => assignedCount(R, d, s) >= bandForDay(R, rules, d, s).min);
  }

  const isRestCell = (c) => c.off === OFF.LOCKED || c.off === OFF.FILLED;
  const lockedRestOf = (i) => R.grid[i].reduce((n, c) => n + (c.locked && isRestCell(c) ? 1 : 0), 0);
  const restCount = (i) => R.grid[i].reduce((n, c) => n + (isRestCell(c) ? 1 : 0), 0);
  const targetOf = (i) => Math.max(lockedRestOf(i), rules.offQuota);

  const neighborsRest = (i, d) => {
    const a = d > 0 && isRestCell(R.grid[i][d - 1]);
    const b = d < D - 1 && isRestCell(R.grid[i][d + 1]);
    return (a ? 1 : 0) + (b ? 1 : 0);
  };

  // ใครยังหยุดไม่ถึงโควตา + รวมต้องเติมกี่เวรคู่
  const needs = [];
  let K = 0;
  for (let i = 0; i < N; i++) {
    const need = targetOf(i) - restCount(i);
    if (need > 0) { needs.push({ i, need }); K += need; }
  }
  if (K === 0) return;

  // สถานะเวรคู่ปัจจุบัน (นับของเดิมจาก constructive/polish ด้วย)
  const takerDbl = Array.from({ length: N }, () => 0);
  const takerDblDays = Array.from({ length: N }, () => []);
  for (let q = 0; q < N; q++) {
    R.grid[q].forEach((c, d) => {
      if (c.shifts.length >= 2) { takerDbl[q] += 1; takerDblDays[q].push(d); }
    });
  }

  // จุดเป้าหมายกระจายทั้งเดือน (index วัน 0-based)
  const slots = [];
  for (let k = 0; k < K; k++) slots.push(Math.round((k + 0.5) / K * D - 0.5));

  // ตรวจว่า q รับกะ s เป็นกะที่ 2 ในวัน d ได้ไหม (dry-run)
  const takerOK = (q, d, s) => {
    const cq = R.grid[q][d];
    if (q < 0 || cq.locked || cq.shifts.length !== 1 || cq.shifts.includes(s)) return false;
    const svq = snap(cq);
    setShifts(cq, [cq.shifts[0], s]); cq.locked = false;
    const ok = cellHardOK(R, rules, q, d)
      && (d <= 0 || cellHardOK(R, rules, q, d - 1))
      && (d >= D - 1 || cellHardOK(R, rules, q, d + 1));
    restore(cq, svq);
    return ok;
  };

  // คนรับที่ดีที่สุดในวัน d สำหรับกะ s: เวรคู่น้อย + ห่างจากเวรคู่เดิมของตัวเอง
  const bestTaker = (i, d, s) => {
    let best = -1;
    let bestScore = Infinity;
    for (let q = 0; q < N; q++) {
      if (q === i || !takerOK(q, d, s)) continue;
      const near = takerDblDays[q].reduce((m, dd) => Math.min(m, Math.abs(dd - d)), Infinity);
      const score = takerDbl[q] * 10 + (near < 7 ? 7 - near : 0);
      if (score < bestScore) { bestScore = score; best = q; }
    }
    return best;
  };

  const applyMove = (i, d, q) => {
    const ci = R.grid[i][d];
    const cq = R.grid[q][d];
    const svi = snap(ci);
    const svq = snap(cq);
    setShifts(cq, [cq.shifts[0], ci.shifts[0]]); cq.locked = false;
    setOff(ci, OFF.FILLED); ci.locked = false;
    const ok = cellHardOK(R, rules, q, d)
      && (d <= 0 || cellHardOK(R, rules, q, d - 1))
      && (d >= D - 1 || cellHardOK(R, rules, q, d + 1))
      && (d <= 0 || cellHardOK(R, rules, i, d - 1))
      && (d >= D - 1 || cellHardOK(R, rules, i, d + 1));
    if (ok) { takerDbl[q] += 1; takerDblDays[q].push(d); return true; }
    restore(ci, svi); restore(cq, svq);
    return false;
  };

  // เดินทีละ slot — แต่ละรอบเลือกท่าที่วันใกล้ slot ที่สุด (ทุกคนที่ยังขาด)
  for (const slot of slots) {
    let pick = null;
    let pickScore = Infinity;
    for (const entry of needs) {
      if (entry.need <= 0) continue;
      const i = entry.i;
      for (let d = 0; d < D; d++) {
        if (!dayCovered[d]) continue;
        const ci = R.grid[i][d];
        if (ci.locked || ci.shifts.length !== 1) continue;
        const q = bestTaker(i, d, ci.shifts[0]);
        if (q < 0) continue;
        const score = Math.abs(d - slot) * 4 + neighborsRest(i, d) * 2 + takerDbl[q] * 3;
        if (score < pickScore) { pickScore = score; pick = { entry, d, q }; }
      }
    }
    if (pick && applyMove(pick.entry.i, pick.d, pick.q)) pick.entry.need -= 1;
  }

  // เผื่อบาง slot หาท่าไม่ได้ — ไล่เก็บคนที่ยังขาดแบบตรงไปตรงมา
  for (const entry of needs) {
    while (entry.need > 0) {
      let moved = false;
      for (let d = 0; d < D && !moved; d++) {
        if (!dayCovered[d]) continue;
        const ci = R.grid[entry.i][d];
        if (ci.locked || ci.shifts.length !== 1) continue;
        const q = bestTaker(entry.i, d, ci.shifts[0]);
        if (q >= 0 && applyMove(entry.i, d, q)) { entry.need -= 1; moved = true; }
      }
      if (!moved) break;
    }
  }
}

// ---------------------------------------------------------------------------
// 6) แตก O ที่ติดกันเกิน maxConsecutiveOff — สลับ 4 ช่องระหว่างคนสองคนในสองวัน
//    (coverage + จำนวนวันหยุดของทั้งคู่คงเดิม) เพื่อไม่ให้ใครหยุดยาวติดกัน
// ---------------------------------------------------------------------------
function spreadLongRest(R, rules) {
  const D = R.days;
  const N = R.staff.length;
  const maxO = rules.maxConsecutiveOff;
  const isR = (c) => c.off === OFF.LOCKED || c.off === OFF.FILLED;
  const isMovableO = (c) => c.off === OFF.FILLED && !c.locked;
  const noLongRun = (i) => {
    let run = 0;
    for (let d = 0; d < D; d++) {
      if (isR(R.grid[i][d])) { run += 1; if (run > maxO) return false; } else run = 0;
    }
    return true;
  };

  for (let a = 0; a < N; a++) {
    let guard = 0;
    while (!noLongRun(a) && guard++ < D) {
      // หา O (ระบบเติม) ของ a ที่อยู่กลางแถบยาว
      let fixed = false;
      for (let d = 0; d < D && !fixed; d++) {
        const cad = R.grid[a][d];
        if (!isMovableO(cad)) continue;
        const runL = (() => {
          let n = 1;
          for (let k = d - 1; k >= 0 && isR(R.grid[a][k]); k--) n += 1;
          for (let k = d + 1; k < D && isR(R.grid[a][k]); k++) n += 1;
          return n;
        })();
        if (runL <= maxO) continue;

        for (let b = 0; b < N && !fixed; b++) {
          if (b === a) continue;
          const cbd = R.grid[b][d];
          if (cbd.locked || cbd.shifts.length !== 1) continue;
          const s = cbd.shifts[0];
          for (let x = 0; x < D && !fixed; x++) {
            if (x === d) continue;
            const cax = R.grid[a][x];
            const cbx = R.grid[b][x];
            if (!isMovableO(cbx) || cax.locked || cax.shifts.length !== 1) continue;
            const sx = cax.shifts[0];
            const sv = [snap(cad), snap(cbd), snap(cax), snap(cbx)];
            setShifts(cad, [s]); cad.locked = false;
            setOff(cbd, OFF.FILLED); cbd.locked = false;
            setOff(cax, OFF.FILLED); cax.locked = false;
            setShifts(cbx, [sx]); cbx.locked = false;
            const cells = [[a, d], [b, d], [a, x], [b, x]];
            const ok = cells.every(([ii, dd]) => cellHardOK(R, rules, ii, dd)
              && (dd <= 0 || cellHardOK(R, rules, ii, dd - 1))
              && (dd >= D - 1 || cellHardOK(R, rules, ii, dd + 1)))
              && noLongRun(a) && noLongRun(b);
            if (ok) { fixed = true; }
            else {
              restore(cad, sv[0]); restore(cbd, sv[1]);
              restore(cax, sv[2]); restore(cbx, sv[3]);
            }
          }
        }
      }
      if (!fixed) break;
    }
  }
}

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------
/**
 * @param {object} roster
 * @param {object} rules
 * @param {{seed?:number, iterations?:number}} [opts]
 * @returns {{roster:object, cost:object, filled:number, changed:number}}
 */
export function solve(roster, rules, opts = {}) {
  const rnd = mulberry32(opts.seed ?? 1);
  const iterations = opts.iterations ?? 6000;
  const R = cloneRoster(roster);
  if (R.staff.length === 0) return { roster: R, cost: cost(R, rules), filled: 0, changed: 0 };

  // จัดใหม่ทั้งหมดจากศูนย์ — เก็บไว้เฉพาะช่องที่ล็อก / ลา (V) / อบรม (T)
  // (กันผลเพี้ยนเวลากด "จัดตารางอัตโนมัติ" ซ้ำ หรือจัดหลังเพิ่มคน/แก้กติกา)
  for (const row of R.grid) {
    for (const c of row) if (!isFixed(c)) clearCell(c);
  }

  constructive(R, rules, rnd);
  const polished = polish(R, rules, rnd, iterations);
  const out = polished.roster;
  fillRest(out, rules);
  balanceRest(out, rules);
  restViaDoubles(out, rules);
  balanceRest(out, rules);
  spreadLongRest(out, rules);

  // นับช่องที่เปลี่ยนจากต้นฉบับ
  let filled = 0;
  let changed = 0;
  for (let i = 0; i < roster.staff.length; i++) {
    for (let d = 0; d < roster.days; d++) {
      const a = roster.grid[i][d];
      const b = out.grid[i][d];
      const wasEmpty = a.shifts.length === 0 && a.off === null;
      const tokA = a.shifts.join('+') || a.off || '';
      const tokB = b.shifts.join('+') || b.off || '';
      if (tokA !== tokB) { changed++; if (wasEmpty) filled++; }
    }
  }

  return { roster: out, cost: cost(out, rules), filled, changed };
}
