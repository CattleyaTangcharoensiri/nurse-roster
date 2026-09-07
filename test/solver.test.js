import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRoster } from '../src/engine/io.js';
import { makeRoster, mergeRules, addStaff, getCell, setCellShifts, setCellOff, OFF } from '../src/engine/model.js';
import { analyze } from '../src/engine/analyze.js';
import { solve } from '../src/engine/solver.js';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sample.json', import.meta.url)), 'utf8'),
);
const WARD17 = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/ward17-sep.json', import.meta.url)), 'utf8'),
);
const OCT2569 = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/oct2569.json', import.meta.url)), 'utf8'),
);

const HARD = new Set(['nightToMorning', 'consecutiveNights', 'doubleNotAllowed', 'coverageOver']);
const hardViolations = (rep) => rep.violations.filter((v) => HARD.has(v.type));

test('solver: เคสที่จัดได้ครบ → ไม่มีกะไหนขาด และไม่ผิดกฎห้าม', () => {
  const rules = mergeRules({
    target: { 'ช': 1, 'บ': 1, 'ด': 1 },
    offQuota: 2, maxConsecutiveWork: 5, maxConsecutiveNights: 2,
  });
  const roster = makeRoster({
    days: 7, firstWeekday: 'จันทร์',
    staff: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
  });

  const res = solve(roster, rules, { seed: 7 });
  const rep = analyze(res.roster, rules);

  assert.equal(rep.gaps.filter((g) => g.status === 'under').length, 0, 'ไม่มีกะไหนคนไม่พอ');
  assert.equal(hardViolations(rep).length, 0, 'ไม่มีการละเมิดกฎห้าม');
});

test('solver: ไม่แตะช่องที่ล็อกไว้', () => {
  const rules = mergeRules({ target: { 'ช': 1, 'บ': 1, 'ด': 1 }, offQuota: 2 });
  const roster = makeRoster({
    days: 6, firstWeekday: 'จันทร์',
    staff: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
  });
  setCellShifts(getCell(roster, 0, 0), ['ด']); getCell(roster, 0, 0).locked = true;
  setCellOff(getCell(roster, 1, 2), OFF.LEAVE); getCell(roster, 1, 2).locked = true;

  const res = solve(roster, rules, { seed: 3 });
  assert.deepEqual(res.roster.grid[0][0].shifts, ['ด']);
  assert.ok(res.roster.grid[0][0].locked);
  assert.equal(res.roster.grid[1][2].off, OFF.LEAVE);
});

test('solver: sample — ไม่สร้างการละเมิดกฎห้าม และครอบคลุมดีขึ้น', () => {
  const { roster, rules } = parseRoster(FIXTURE);
  const before = analyze(roster, rules);
  const res = solve(roster, rules, { seed: 1 });
  const after = analyze(res.roster, rules);

  // sample มีการละเมิดที่ "ล็อกมาแต่แรก" (D ขึ้น ด วันที่ 16-18) — solver แก้ไม่ได้
  // แต่ต้องไม่ "สร้างเพิ่ม"
  assert.ok(
    hardViolations(after).length <= hardViolations(before).length,
    `ห้ามสร้างการละเมิดกฎห้ามเพิ่ม (${hardViolations(before).length} → ${hardViolations(after).length})`,
  );

  const underBefore = before.gaps.filter((g) => g.status === 'under').length;
  const underAfter = after.gaps.filter((g) => g.status === 'under').length;
  assert.ok(underAfter < underBefore, `ช่องขาดต้องลดลง (${underBefore} → ${underAfter})`);
  assert.ok(res.filled > 0);
});

test('solver: ward17 (กันยายน, 14 คน) — จัดได้ครบทุกกะ ไม่ผิดกฎห้าม', () => {
  const { roster, rules } = parseRoster(WARD17);
  const before = analyze(roster, rules);
  assert.equal(before.feasibility.feasible, true);
  assert.equal(hardViolations(before).length, 0, 'ข้อมูลตั้งต้นไม่มีการละเมิดกฎห้าม');

  const res = solve(roster, rules, { seed: 1 });
  const after = analyze(res.roster, rules);
  assert.equal(after.gaps.filter((g) => g.status === 'under').length, 0, 'ครบทุกกะทุกวัน');
  assert.equal(hardViolations(after).length, 0);
  // ช่องที่ล็อกไว้ต้องไม่ถูกแตะ
  const w4 = res.roster.staff.findIndex((s) => s.name === 'พยาบาล D');
  assert.deepEqual(res.roster.grid[w4][0].shifts, ['ด']);
});

test('solver: เกลี่ยวันหยุด O+R ให้ใกล้โควตา (ห้ามขาด/เกิน) ยกเว้นช่องล็อก', () => {
  const rules = mergeRules({
    target: { 'ช': 2, 'บ': 2, 'ด': 1 },
    offQuota: 3, offQuotaMode: 'exact', maxConsecutiveWork: 6,
  });
  // 7 คน x 7 วัน = 49 ช่อง ; ต้องการ 5*7 = 35 slot ; หยุดควรได้ ~ 49-35-0 = 14 → 2/คน
  // ตั้งโควตา 3 (รวม 21) เกินพอดี ตรวจว่าเกลี่ยได้ใกล้เคียง
  const roster = makeRoster({
    days: 7, firstWeekday: 'จันทร์',
    staff: Array.from({ length: 8 }, (_, i) => ({ name: 'N' + i })),
  });
  const res = solve(roster, rules, { seed: 9 });
  const rep = analyze(res.roster, rules);
  const rests = rep.perPerson.map((p) => p.rest);
  const spread = Math.max(...rests) - Math.min(...rests);
  assert.ok(spread <= 2, `วันหยุดต้องเกลี่ยใกล้กัน (ได้: ${rests})`);
  assert.equal(rep.gaps.filter((g) => g.status === 'under').length, 0);
});

test('solver: ต.ค. 2569 (16 คน, ช5/บ4/ด3, หยุด 8 เป๊ะ) — ยอมขึ้น 2 กะ/วัน เพื่อปิดช่องว่างวันหยุด', () => {
  const { roster, rules } = parseRoster(OCT2569);
  assert.equal(rules.maxDoublesPerPerson, 4);

  const res = solve(roster, rules, { seed: 1 });
  const rep = analyze(res.roster, rules);

  // ครบทุกกะทุกวัน (min===max → เป๊ะ ช5/บ4/ด3)
  assert.equal(rep.gaps.filter((g) => g.status === 'under').length, 0, 'ไม่มีกะไหนขาด');
  assert.equal(rep.gaps.filter((g) => g.status === 'over').length, 0, 'ไม่มีกะไหนเกิน');

  // หยุด 8 ครบทุกคน — ไม่ทิ้งโควตา
  for (const p of rep.perPerson) assert.equal(p.rest, 8, `${p.name} ต้องหยุด 8 (ได้ ${p.rest})`);

  // ปิดช่องว่างด้วยการขึ้น 2 กะ/วัน (arithmetic: 372 - 16*23 = 4)
  const doubles = rep.perPerson.reduce((a, p) => a + p.doubles, 0);
  assert.equal(doubles, 4, `ต้องใช้ 2 กะ/วัน 4 ครั้ง (ได้ ${doubles})`);
  for (const p of rep.perPerson) assert.ok(p.doubles <= rules.maxDoublesPerPerson);

  assert.equal(hardViolations(rep).length, 0, 'ไม่ผิดกฎห้าม');
  assert.equal(rep.summary.errors, 0, 'ไม่มี error');

  // เวรคู่ต้องกระจายตามแกนเวลา ไม่กระจุกต้นเดือน
  const dblDays = [];
  res.roster.grid.forEach((row) => row.forEach((c, d) => { if (c.shifts.length >= 2) dblDays.push(d); }));
  dblDays.sort((a, b) => a - b);
  const D = res.roster.days;
  const thirds = [0, 0, 0];
  dblDays.forEach((d) => { thirds[Math.min(2, Math.floor(d / D * 3))] += 1; });
  assert.ok(Math.max(...thirds) - Math.min(...thirds) <= 1, `เวรคู่ต้องกระจายทั่วเดือน (ต้น/กลาง/ปลาย = ${thirds})`);
  assert.ok(dblDays[dblDays.length - 1] - dblDays[0] >= D * 0.5, `เวรคู่ต้องคลุมช่วงเดือนกว้าง (วัน ${dblDays.map((d) => d + 1)})`);
  // แต่ละคนโดนเวรคู่ไม่กระจุก
  for (const p of rep.perPerson) assert.ok(p.doubles <= 2, `${p.name} โดนเวรคู่ ${p.doubles} ครั้ง — กระจุกเกินไป`);
});

test('solver: โหมด max — ไม่ดันคนขึ้น 2 กะ/วัน เพื่อไปให้ถึงโควตาหยุด', () => {
  const { roster } = parseRoster(OCT2569);
  const rules = mergeRules({
    target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, offQuotaMode: 'max', maxDoublesPerPerson: 4,
  });
  const res = solve(roster, rules, { seed: 1 });
  const rep = analyze(res.roster, rules);
  assert.equal(rep.gaps.filter((g) => g.status === 'under').length, 0);
  // โหมด max: หยุดไม่ถึง 8 ไม่ผิด และไม่ควรมี restViaDoubles มายัด 2 กะ/วัน
  assert.equal(rep.perPerson.reduce((a, p) => a + p.doubles, 0), 0);
});

test('solver: คนไม่พอ → coverage มาก่อนโควตาหยุด (ไม่แจกวันหยุดจนวอร์ดว่าง)', () => {
  // 12 คน x 14 วัน, ต้องการ 12 คน/วัน — จัดไม่ครบแน่ ๆ
  const rules = mergeRules({
    target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, offQuotaMode: 'exact', maxConsecutiveWork: 5,
  });
  const roster = makeRoster({
    days: 14, firstWeekday: 'จันทร์',
    staff: Array.from({ length: 12 }, (_, i) => ({ name: 'N' + (i + 1) })),
  });
  const res = solve(roster, rules, { seed: 1 });
  const rep = analyze(res.roster, rules);

  // solver ต้องดันคนขึ้นเวรให้มากที่สุดเท่าที่กฎยอม (maxConsecutiveWork 5 → ทำได้ ~12/14 วัน)
  // ไม่ใช่กันวันหยุดไว้ 8 แล้วปล่อยกะโหว่
  const rests = rep.perPerson.map((p) => p.rest);
  assert.ok(Math.max(...rests) <= 4, `ห้ามแจกวันหยุดเต็มโควตาแล้วทิ้ง coverage (rests=${rests})`);
  assert.ok(rep.feasibility.assignedSlots >= rep.feasibility.slotsNeeded - 30,
    `ต้องเติมกะให้ได้เกือบเต็ม (${rep.feasibility.assignedSlots}/${rep.feasibility.slotsNeeded})`);
  assert.equal(hardViolations(rep).length, 0);
});

test('solver: กะขาดไม่กี่จุด ไม่บล็อกการเวรคู่เพื่อให้ทุกคนหยุดตรงโควตา', () => {
  // 14 คน x 30 วัน, ช5/บ4/ด3, หยุด 8 เป๊ะ — แน่นแต่ทำได้ (ต้องเวรคู่ ~52, เพดานรวม 56)
  // เดิม: เหลือกะโหว่แค่ 1–2 จุด → restViaDoubles ยกเลิกทั้ง pass → ทุกคนค้างที่หยุด 5
  const rules = mergeRules({
    target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, offQuotaMode: 'exact', maxDoublesPerPerson: 4,
  });
  const roster = makeRoster({
    days: 30, firstWeekday: 'จันทร์',
    staff: Array.from({ length: 14 }, (_, i) => ({ name: 'N' + (i + 1) })),
  });
  const res = solve(roster, rules, { seed: 1 });
  const rep = analyze(res.roster, rules);

  const rests = rep.perPerson.map((p) => p.rest);
  assert.ok(Math.min(...rests) >= 7, `ทุกคนต้องเข้าใกล้โควตา 8 (ได้ ${rests})`);
  assert.ok(rep.perPerson.reduce((a, p) => a + p.doubles, 0) >= 30, 'ต้องใช้เวรคู่จริง ไม่ใช่ปล่อยผ่าน');
  assert.equal(hardViolations(rep).length, 0);
});

test('solver: จัดซ้ำ / จัดหลังเพิ่มคน → เริ่มจากศูนย์ ไม่เพี้ยน', () => {
  const { roster, rules } = parseRoster(OCT2569);
  const tok = (r) => r.grid.map((row) => row.map((c) => c.shifts.join('+') || c.off || '.').join(',')).join('|');

  const once = solve(roster, rules, { seed: 1 });
  const twice = solve(once.roster, rules, { seed: 1 });
  assert.equal(tok(once.roster), tok(twice.roster), 'จัดซ้ำบนผลเดิมต้องได้ตารางเดิม');

  // เพิ่ม 2 คนเข้าไปในตารางที่จัดแล้ว → จัดใหม่ต้องสะอาด ไม่มีใครหยุดทะลุ
  addStaff(twice.roster, { name: 'เพิ่ม 1' });
  addStaff(twice.roster, { name: 'เพิ่ม 2' });
  const after = solve(twice.roster, rules, { seed: 1 });
  const rep = analyze(after.roster, rules);
  for (const p of rep.perPerson) assert.ok(p.rest <= 12, `${p.name} หยุด ${p.rest} วัน — เพี้ยน`);
  assert.equal(hardViolations(rep).length, 0);
});

test('solver: ผลซ้ำได้เมื่อ seed เดิม', () => {
  const { roster, rules } = parseRoster(FIXTURE);
  const a = solve(roster, rules, { seed: 42, iterations: 1500 });
  const b = solve(roster, rules, { seed: 42, iterations: 1500 });
  const tok = (r) => r.grid.map((row) => row.map((c) => c.shifts.join('+') || c.off || '.').join(',')).join('|');
  assert.equal(tok(a.roster), tok(b.roster));
});

test('solver: เติมช่องว่างที่เหลือเป็น O', () => {
  const rules = mergeRules({ target: { 'ช': 1, 'บ': 1, 'ด': 1 }, offQuota: 3 });
  const roster = makeRoster({
    days: 5, firstWeekday: 'จันทร์',
    staff: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
  });
  const res = solve(roster, rules, { seed: 2 });
  let empty = 0;
  for (const row of res.roster.grid) for (const c of row) if (c.shifts.length === 0 && c.off === null) empty++;
  assert.equal(empty, 0, 'ไม่เหลือช่องว่าง');
});
