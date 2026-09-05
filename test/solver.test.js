import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRoster } from '../src/engine/io.js';
import { makeRoster, mergeRules, getCell, setCellShifts, setCellOff, OFF } from '../src/engine/model.js';
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
