import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRoster, mergeRules, getCell, setCellShifts, staffAllowsShift, ALLOW_TOKENS,
} from '../src/engine/model.js';
import { parseRoster, serializeRoster } from '../src/engine/io.js';
import { analyze } from '../src/engine/analyze.js';
import { solve } from '../src/engine/solver.js';

test('staffAllowsShift: allow ว่าง = ได้ทุกกะ, มีค่า = เฉพาะที่ระบุ', () => {
  assert.ok(staffAllowsShift({ allow: [] }, ['ช']));
  assert.ok(staffAllowsShift({ allow: [] }, ['ช', 'บ']));
  assert.ok(staffAllowsShift({ allow: ['ช'] }, ['ช']));
  assert.ok(!staffAllowsShift({ allow: ['ช'] }, ['บ']));
  assert.ok(!staffAllowsShift({ allow: ['ช'] }, ['ช', 'บ']));
  assert.ok(staffAllowsShift({ allow: ['ช', 'ช+บ'] }, ['บ', 'ช']));
  assert.ok(staffAllowsShift({ allow: ['ช'] }, []));      // หยุด/ลา ไม่เกี่ยว
});

test('io: อ่าน/เขียน staff.allow (กรอง token ที่ไม่ถูกต้องทิ้ง)', () => {
  const { roster } = parseRoster({
    days: 3, firstWeekday: 'จันทร์',
    staff: [{ name: 'A', allow: ['ช', 'บ+ด', 'zzz'] }],
  });
  assert.deepEqual(roster.staff[0].allow, ['ช', 'บ+ด']);
  const doc = serializeRoster(roster);
  assert.deepEqual(doc.staff[0].allow, ['ช', 'บ+ด']);
});

test('analyze: ช่องที่ผิดเงื่อนไขรายบุคคล → shiftNotAllowed', () => {
  const rules = mergeRules({});
  const roster = makeRoster({
    days: 3, firstWeekday: 'จันทร์',
    staff: [{ name: 'A', allow: ['ช'] }],
  });
  setCellShifts(getCell(roster, 0, 0), ['ด']);
  setCellShifts(getCell(roster, 0, 1), ['ช']);
  const rep = analyze(roster, rules);
  const v = rep.violations.filter((x) => x.type === 'shiftNotAllowed');
  assert.equal(v.length, 1);
  assert.equal(v[0].day, 1);
  assert.equal(v[0].pattern, 'ด');
});

test('solver: ไม่ลงกะที่ผิดเงื่อนไขรายบุคคล', () => {
  const rules = mergeRules({ target: { 'ช': 1, 'บ': 1, 'ด': 1 }, offQuota: 2 });
  const roster = makeRoster({
    days: 7, firstWeekday: 'จันทร์',
    staff: [
      { name: 'เช้าอย่างเดียว', allow: ['ช'] },
      { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' },
    ],
  });
  const res = solve(roster, rules, { seed: 5 });
  const used = new Set();
  res.roster.grid[0].forEach((c) => c.shifts.forEach((s) => used.add(s)));
  assert.ok(![...used].some((s) => s !== 'ช'), `คนแรกต้องได้แต่ ช (ได้: ${[...used]})`);

  const rep = analyze(res.roster, rules);
  assert.equal(rep.violations.filter((v) => v.type === 'shiftNotAllowed').length, 0);
});

test('ALLOW_TOKENS: 5 ตัวเลือก (ช+ด ตัดออก)', () => {
  assert.deepEqual(ALLOW_TOKENS, ['ช', 'บ', 'ด', 'ช+บ', 'บ+ด']);
});
