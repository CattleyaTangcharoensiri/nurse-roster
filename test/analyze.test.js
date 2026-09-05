import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRoster } from '../src/engine/io.js';
import {
  makeRoster, mergeRules, getCell, setCellShifts, setCellOff, OFF,
} from '../src/engine/model.js';
import { analyze, advise } from '../src/engine/analyze.js';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sample.json', import.meta.url)), 'utf8'),
);

function analyzeFixture() {
  const { roster, rules } = parseRoster(FIXTURE);
  return analyze(roster, rules);
}

test('analyze: feasibility ของ fixture', () => {
  const r = analyzeFixture();
  assert.equal(r.feasibility.slotsNeeded, 270);
  // R+O = 39, V = 7, T = 0  →  270 - 46 = 224
  assert.equal(r.feasibility.restDays, 39);
  assert.equal(r.feasibility.leaveDays, 7);
  assert.equal(r.feasibility.workDaysAvailable, 224);
  // ยังไม่มีช่องขึ้น 2 กะ/วัน ล็อกไว้เลย → ต้องเติม 270 - 224 = 46 ครั้ง
  assert.equal(r.feasibility.doublesExisting, 0);
  assert.equal(r.feasibility.doublesNeeded, 46);
});

test('analyze: restLockedOver ยกเว้น C (ล็อก 10) และ G (ล็อก 7) เกินโควตา 6', () => {
  const r = analyzeFixture();
  const oq = r.violations.filter((v) => v.type === 'restLockedOver');
  const names = oq.map((v) => `${v.name}:${v.count}`).sort();
  assert.deepEqual(names, ['พยาบาล C:10', 'พยาบาล G:7']);
});

test('analyze: ไม่มีดต่อเช้าในช่องที่ล็อก', () => {
  const r = analyzeFixture();
  assert.equal(r.violations.filter((v) => v.type === 'nightToMorning').length, 0);
});

test('analyze: จับ ด ติดกัน 3 คืนของ D (วันที่ 16-18)', () => {
  const r = analyzeFixture();
  const cn = r.violations.filter((v) => v.type === 'consecutiveNights');
  assert.equal(cn.length, 1);
  assert.equal(cn[0].name, 'พยาบาล D');
  assert.equal(cn[0].count, 3);
});

test('analyze: coverage วันที่ 1 กะ ช = ขาด (min 4, มี 0)', () => {
  const r = analyzeFixture();
  const day1M = r.coverage.find((c) => c.day === 1 && c.shift === 'ช');
  assert.equal(day1M.assigned, 0);
  assert.equal(day1M.min, 4);
  assert.equal(day1M.status, 'under');
});

test('analyze: ดต่อเช้า นับ ด/ช ที่รวมอยู่ในกะ 2 กะ/วันด้วย', () => {
  const rules = mergeRules({});
  const roster = makeRoster({ days: 4, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }] });
  setCellShifts(getCell(roster, 0, 0), ['บ', 'ด']);  // บ+ด — มี ด
  setCellShifts(getCell(roster, 0, 1), ['ช', 'บ']);  // ช+บ — มี ช วันรุ่งขึ้น
  const r = analyze(roster, rules);
  const n2m = r.violations.filter((v) => v.type === 'nightToMorning');
  assert.equal(n2m.length, 1);
  assert.equal(n2m[0].day, 1);
});

test('analyze: กะ 2 กะ/วัน ที่ไม่อยู่ใน allowedDoubles → doubleNotAllowed', () => {
  const rules = mergeRules({ allowedDoubles: ['ช+บ'] });
  const roster = makeRoster({ days: 3, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }] });
  setCellShifts(getCell(roster, 0, 0), ['บ', 'ด']);
  const r = analyze(roster, rules);
  const dna = r.violations.filter((v) => v.type === 'doubleNotAllowed');
  assert.equal(dna.length, 1);
  assert.equal(dna[0].pattern, 'บ+ด');
});

test('analyze: feasible=false เมื่อวันขึ้น 2 กะ/วัน ที่ต้องการเกินเพดานรวม', () => {
  const rules = mergeRules({ target: { 'ช': 5, 'บ': 5, 'ด': 5 }, maxDoublesPerPerson: 1 });
  const roster = makeRoster({ days: 10, firstWeekday: 'จันทร์', staff: [
    { name: 'ก' }, { name: 'ข' }, { name: 'ค' },
  ] });
  const r = analyze(roster, rules);
  // ต้องการ 150 slot, มี 3 คน x 10 วัน = 30 วันว่าง, เพดาน 2 กะ/วัน รวม = 3
  assert.equal(r.feasibility.feasible, false);
  assert.ok(r.feasibility.reasons.some((x) => x.includes('2 กะ/วัน')));
});

test('analyze: coverageOver เมื่อล็อกคนเกินเพดานกะ', () => {
  const rules = mergeRules({ target: { 'ด': { min: 1, max: 1 } } });
  const roster = makeRoster({ days: 2, firstWeekday: 'จันทร์', staff: [
    { name: 'ก' }, { name: 'ข' },
  ] });
  setCellShifts(getCell(roster, 0, 0), ['ด']);
  setCellShifts(getCell(roster, 1, 0), ['ด']);
  const r = analyze(roster, rules);
  const over = r.violations.filter((v) => v.type === 'coverageOver');
  assert.equal(over.length, 1);
  assert.equal(over[0].day, 1);
  assert.equal(over[0].count, 2);
});

test('analyze: countLeaveInQuota นับ V เข้าโควตา', () => {
  const roster = makeRoster({ days: 8, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }] });
  for (let d = 0; d < 4; d++) setCellOff(getCell(roster, 0, d), OFF.LOCKED);
  for (let d = 4; d < 8; d++) setCellOff(getCell(roster, 0, d), OFF.LEAVE);
  // โควตา 4 พอดีกับ R 4 วัน
  const off = analyze(roster, mergeRules({ offQuota: 4, countLeaveInQuota: false }));
  assert.equal(off.violations.filter((v) => v.type === 'restOver' || v.type === 'restShort').length, 0);
  const on = analyze(roster, mergeRules({ offQuota: 4, countLeaveInQuota: true }));
  assert.equal(on.violations.filter((v) => v.type === 'restOver').length, 1);
  assert.equal(on.perPerson[0].offCounted, 8);
});

test('analyze: restShort เฉพาะเมื่อกรอกครบแล้ว (ไม่มีช่องว่าง)', () => {
  const rules = mergeRules({ offQuota: 3, offQuotaMode: 'exact' });
  const roster = makeRoster({ days: 5, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }] });
  // ยังมีช่องว่าง → ไม่ควรฟ้อง restShort
  setCellOff(getCell(roster, 0, 0), OFF.LOCKED);
  assert.equal(analyze(roster, rules).violations.filter((v) => v.type === 'restShort').length, 0);
  // เติมจนเต็ม: R 1 + เวร 4 = ไม่มีช่องว่าง, หยุด 1 < โควตา 3 → restShort
  for (let d = 1; d < 5; d++) setCellShifts(getCell(roster, 0, d), ['ช']);
  const v = analyze(roster, rules).violations.filter((x) => x.type === 'restShort');
  assert.equal(v.length, 1);
  assert.equal(v[0].count, 1);
});

test('advise: เดือน ต.ค. (31 วัน) ช5/บ4/ด3 หยุด 8', () => {
  const mk = (N) => makeRoster({
    days: 31, firstWeekday: 'พฤหัสบดี', year: 2569, month: 10,
    staff: Array.from({ length: N }, (_, i) => ({ name: 'พ' + (i + 1) })),
  });
  const rules = mergeRules({ target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, maxDoublesPerPerson: 5 });

  const a16 = advise(mk(16), rules);
  assert.equal(a16.status, 'ok');
  assert.equal(a16.shiftsNeeded, 372);
  assert.equal(a16.doublesNeeded, 4);
  assert.deepEqual(a16.feasibleStaff, { min: 14, max: 16 });

  const a14 = advise(mk(14), rules);
  assert.equal(a14.status, 'tight');       // 50 doubles = แน่น
  assert.equal(a14.doublesNeeded, 50);
  assert.ok(a14.lines.some((l) => l.includes('16 คน')), 'ต้องแนะนำเพิ่มเป็น 16 คน');

  const a18 = advise(mk(18), rules);
  assert.equal(a18.status, 'over');        // คนล้น
  assert.ok(a18.doublesNeeded < 0);
  assert.ok(a18.lines.some((l) => l.includes('ลดเหลือ 16 คน')));
});

test('advise: คนน้อยเกินเพดานเวรคู่ → under + แนะนำเพิ่มคน', () => {
  const roster = makeRoster({
    days: 31, firstWeekday: 'พฤหัสบดี',
    staff: Array.from({ length: 12 }, (_, i) => ({ name: 'พ' + (i + 1) })),
  });
  const a = advise(roster, mergeRules({ target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, maxDoublesPerPerson: 4 }));
  assert.equal(a.status, 'under');
  assert.ok(a.doublesNeeded > a.doubleCapacity);
});

test('advise: ลา/อบรม ดันจำนวนคนที่ต้องใช้ให้มากขึ้น', () => {
  const base = makeRoster({
    days: 31, firstWeekday: 'พฤหัสบดี',
    staff: Array.from({ length: 16 }, (_, i) => ({ name: 'พ' + (i + 1) })),
  });
  const rules = mergeRules({ target: { 'ช': 5, 'บ': 4, 'ด': 3 }, offQuota: 8, maxDoublesPerPerson: 5 });
  const before = advise(base, rules).doublesNeeded;
  for (let d = 0; d < 10; d++) setCellOff(getCell(base, 0, d), OFF.LEAVE);
  const after = advise(base, rules).doublesNeeded;
  assert.equal(after, before + 10);
});
