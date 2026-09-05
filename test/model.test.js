import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHIFT, OFF, SHIFT_VALUES,
  WEEKDAYS, weekdayIndex,
  makeCell, setCellShifts, setCellOff, clearCellValue,
  isWorking, isOff, isEmpty, isDouble, isRest, isLeave,
  makeRoster, addStaff, removeStaff, getCell, cloneRoster,
  weekdayIndexForDay, weekdayNameForDay, isWeekend, isWeekBoundary,
  defaultRules, mergeRules, parseDoublePattern, formatDoublePattern,
  isDoubleAllowed, bandForDay, minStaffForDay, totalSlotsNeeded,
} from '../src/engine/model.js';

test('weekdayIndex: ชื่อไทย + alias', () => {
  assert.equal(weekdayIndex('อาทิตย์'), 0);
  assert.equal(weekdayIndex('อังคาร'), 2);
  assert.equal(weekdayIndex('เสาร์'), 6);
  assert.equal(weekdayIndex('พฤหัส'), 4);
  assert.equal(weekdayIndex(3), 3);
  assert.throws(() => weekdayIndex('วันจันทร์'));
});

test('cell: ทำงาน/หยุด เป็น exclusive', () => {
  const c = makeCell();
  assert.ok(isEmpty(c));

  setCellShifts(c, ['ช']);
  assert.ok(isWorking(c));
  assert.ok(!isOff(c));
  assert.deepEqual(c.shifts, ['ช']);

  setCellOff(c, OFF.LEAVE);
  assert.deepEqual(c.shifts, []);
  assert.ok(isLeave(c));
  assert.ok(!isWorking(c));

  setCellShifts(c, ['ช', 'บ']);
  assert.ok(isDouble(c));
  assert.equal(c.off, null);

  clearCellValue(c);
  assert.ok(isEmpty(c));
});

test('cell: R และ O นับเป็น "หยุด" (rest), V/T ไม่ใช่', () => {
  const r = setCellOff(makeCell(), OFF.LOCKED);
  const o = setCellOff(makeCell(), OFF.FILLED);
  const v = setCellOff(makeCell(), OFF.LEAVE);
  const t = setCellOff(makeCell(), OFF.TRAINING);
  assert.ok(isRest(r));
  assert.ok(isRest(o));
  assert.ok(!isRest(v));
  assert.ok(!isRest(t));
});

test('setCellShifts: ค่ากะเพี้ยน → error', () => {
  assert.throws(() => setCellShifts(makeCell(), ['x']));
  assert.throws(() => setCellOff(makeCell(), 'Z'));
});

test('roster: addStaff ขยาย grid ตามจำนวนวัน', () => {
  const roster = makeRoster({ days: 30, firstWeekday: 'อังคาร' });
  assert.equal(roster.staff.length, 0);
  const id = addStaff(roster, { name: 'ก' });
  assert.equal(id, 'p1');
  assert.equal(roster.grid.length, 1);
  assert.equal(roster.grid[0].length, 30);
  assert.ok(isEmpty(getCell(roster, 0, 0)));

  addStaff(roster, { name: 'ข' });
  removeStaff(roster, 0);
  assert.equal(roster.staff[0].name, 'ข');
  assert.equal(roster.grid.length, 1);
});

test('roster: id ไม่ชนกันหลังลบแล้วเพิ่มแถวใหม่ (รวมหลัง cloneRoster)', () => {
  let roster = makeRoster({ days: 10, firstWeekday: 'จันทร์' });
  addStaff(roster, { name: 'A' }); // p1
  addStaff(roster, { name: 'B' }); // p2
  addStaff(roster, { name: 'C' }); // p3
  removeStaff(roster, 1);          // ลบ p2
  roster = cloneRoster(roster);    // undo/solve ทำ clone
  const id = addStaff(roster, { name: 'D' });
  assert.equal(id, 'p4');
  const ids = roster.staff.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `id ซ้ำ: ${ids}`);
});

test('roster: ปฏิทินภายในจาก firstWeekday (อังคาร = index 2)', () => {
  const roster = makeRoster({ days: 30, firstWeekday: 'อังคาร' });
  assert.equal(roster.firstWeekdayIndex, 2);
  // วันที่ 1 = อังคาร, 5 = เสาร์, 6 = อาทิตย์, 7 = จันทร์
  assert.equal(weekdayNameForDay(roster, 0), 'อังคาร');
  assert.equal(weekdayIndexForDay(roster, 4), 6);
  assert.equal(weekdayIndexForDay(roster, 5), 0);
  assert.ok(isWeekend(roster, 4)); // เสาร์
  assert.ok(isWeekend(roster, 5)); // อาทิตย์
  assert.ok(!isWeekend(roster, 6)); // จันทร์
  // ขอบสัปดาห์: วันที่ 7 (index 6) = จันทร์... firstWeekday คืออังคาร
  // ขอบสัปดาห์ถัดไปคือวันที่ 8 (index 7) = อังคาร
  assert.ok(isWeekBoundary(roster, 7));
  assert.ok(!isWeekBoundary(roster, 6));
});

test('cloneRoster: ลึกจริง', () => {
  const roster = makeRoster({ days: 5, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }] });
  setCellShifts(getCell(roster, 0, 0), ['ช']);
  const copy = cloneRoster(roster);
  setCellShifts(getCell(copy, 0, 0), ['ด']);
  assert.deepEqual(getCell(roster, 0, 0).shifts, ['ช']);
  assert.deepEqual(getCell(copy, 0, 0).shifts, ['ด']);
});

test('rules: default + merge', () => {
  const d = defaultRules();
  assert.equal(d.offQuota, 6);
  assert.equal(d.maxDoublesPerPerson, 4);
  assert.deepEqual(d.target['ช'], { min: 4, max: 4 });
  assert.equal(d.weights.coverage, 1000);

  assert.equal(mergeRules({ maxDoublesPerPerson: 2 }).maxDoublesPerPerson, 2);

  const m = mergeRules({ offQuota: 8, target: { 'ด': 3 }, weights: { safety: 999 } });
  assert.equal(m.offQuota, 8);
  assert.deepEqual(m.target['ช'], { min: 4, max: 4 });   // คงค่าฐาน
  assert.deepEqual(m.target['ด'], { min: 3, max: 3 });   // ทับ (number → band)
  assert.equal(m.weights.safety, 999);
  assert.equal(m.weights.coverage, 1000);
});

test('double pattern: parse / format / allowed', () => {
  assert.deepEqual(parseDoublePattern('บ+ช'), ['ช', 'บ']); // เรียงตาม ช→บ→ด
  assert.equal(formatDoublePattern(['ด', 'ช']), 'ช+ด');
  const rules = mergeRules({ allowedDoubles: ['ช+บ'] });
  assert.ok(isDoubleAllowed(rules, ['บ', 'ช']));
  assert.ok(!isDoubleAllowed(rules, ['บ', 'ด']));
  assert.ok(isDoubleAllowed(rules, ['ช'])); // กะเดี่ยว ผ่านเสมอ
});

test('bandForDay / minStaffForDay: override ตามวันในสัปดาห์ + ตามเลขวันที่ (เลขวันที่ชนะ)', () => {
  const roster = makeRoster({ days: 30, firstWeekday: 'อังคาร' });
  const rules = mergeRules({
    targetOverrides: [
      { weekday: 'อังคาร', shift: 'ช', target: 5 },
      { day: 8, shift: 'ช', target: 6 },
    ],
  });
  assert.equal(minStaffForDay(roster, rules, 0, 'ช'), 5); // วันที่ 1 = อังคาร
  assert.equal(minStaffForDay(roster, rules, 1, 'ช'), 4); // วันที่ 2 = พุธ
  assert.equal(minStaffForDay(roster, rules, 7, 'ช'), 6); // วันที่ 8 = อังคาร แต่ day override ชนะ
  assert.equal(minStaffForDay(roster, rules, 0, 'บ'), 3); // กะอื่นไม่โดน
  assert.deepEqual(bandForDay(roster, rules, 0, 'ช'), { min: 5, max: 5 });
});

test('totalSlotsNeeded: fixture = 270', () => {
  const roster = makeRoster({ days: 30, firstWeekday: 'อังคาร' });
  const rules = mergeRules({ target: { 'ช': 4, 'บ': 3, 'ด': 2 } });
  assert.equal(totalSlotsNeeded(roster, rules), 270);
});
