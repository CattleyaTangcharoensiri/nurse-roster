import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseCellToken, cellToToken,
  parseRoster, serializeRoster, toJSONString,
} from '../src/engine/io.js';
import {
  getCell, isRest, isLeave, isDouble, weekdayIndexForDay, isWeekend,
} from '../src/engine/model.js';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sample.json', import.meta.url)), 'utf8'),
);

test('parseCellToken: กะเดียว / 2 กะ/วัน / หยุด', () => {
  assert.deepEqual(parseCellToken('ช'), { shifts: ['ช'], off: null });
  assert.deepEqual(parseCellToken('ด'), { shifts: ['ด'], off: null });
  assert.deepEqual(parseCellToken('ช+บ'), { shifts: ['ช', 'บ'], off: null });
  assert.deepEqual(parseCellToken('บ+ช'), { shifts: ['ช', 'บ'], off: null }); // เรียงให้
  assert.deepEqual(parseCellToken('R'), { shifts: [], off: 'R' });
  assert.deepEqual(parseCellToken('O'), { shifts: [], off: 'O' });
  assert.deepEqual(parseCellToken('V'), { shifts: [], off: 'V' });
  assert.deepEqual(parseCellToken(' ช '), { shifts: ['ช'], off: null });
});

test('parseCellToken: token เพี้ยน → error', () => {
  assert.throws(() => parseCellToken('x'));
  assert.throws(() => parseCellToken('ช+x'));
  assert.throws(() => parseCellToken(''));
});

test('parseCellToken: 2 กะ/วัน เขียนติดกัน "ชบ" / "บด"', () => {
  assert.deepEqual(parseCellToken('ชบ'), { shifts: ['ช', 'บ'], off: null });
  assert.deepEqual(parseCellToken('ดบ'), { shifts: ['บ', 'ด'], off: null });
  assert.throws(() => parseCellToken('ชx'));
});

test('cellToToken: round-trip', () => {
  for (const tok of ['ช', 'บ', 'ด', 'ช+บ', 'R', 'O', 'V', 'T']) {
    const p = parseCellToken(tok);
    const cell = { shifts: p.shifts, off: p.off, locked: false };
    assert.equal(cellToToken(cell), tok);
  }
  assert.equal(cellToToken({ shifts: [], off: null, locked: false }), null);
});

test('parseRoster: อ่าน fixture ข้อ 9 ได้ครบ', () => {
  const { roster, rules, warnings } = parseRoster(FIXTURE, { strict: true });
  assert.deepEqual(warnings, []);
  assert.equal(roster.days, 30);
  assert.equal(roster.firstWeekday, 'อังคาร');
  assert.equal(roster.firstWeekdayIndex, 2);
  assert.equal(roster.staff.length, 9);
  assert.equal(roster.staff[0].name, 'พยาบาล A');
  assert.equal(roster.staff[0].id, 'p1');

  // A วันที่ 1 = "บ" (ล็อก)
  const a1 = getCell(roster, 0, 0);
  assert.deepEqual(a1.shifts, ['บ']);
  assert.equal(a1.locked, true);

  // A วันที่ 9 = "R"
  assert.ok(isRest(getCell(roster, 0, 8)));

  // E วันที่ 29 = "V"
  assert.ok(isLeave(getCell(roster, 4, 28)));

  // F วันที่ 1 = "O" (หยุดที่ระบบเติม) — ยังนับเป็น rest
  const f1 = getCell(roster, 5, 0);
  assert.equal(f1.off, 'O');
  assert.ok(isRest(f1));
  assert.equal(f1.locked, true);

  // C: จำนวนช่องที่ล็อก = 19, ในนั้นเป็น R = 10
  const cRow = roster.grid[2];
  const cLocked = cRow.filter((c) => c.locked).length;
  const cR = cRow.filter((c) => c.off === 'R').length;
  assert.equal(cLocked, 19);
  assert.equal(cR, 10);

  // rules ที่ merge แล้ว
  assert.equal(rules.offQuota, 6);
  assert.equal(rules.maxConsecutiveWork, 5);
  assert.equal(rules.weights.coverage, 1000); // เติมจากค่าเริ่มต้น
});

test('parseRoster: ปฏิทินตรงกับ fixture (วันที่ 5,6 = เสาร์,อาทิตย์)', () => {
  const { roster } = parseRoster(FIXTURE);
  assert.equal(weekdayIndexForDay(roster, 4), 6); // เสาร์
  assert.equal(weekdayIndexForDay(roster, 5), 0); // อาทิตย์
  assert.ok(isWeekend(roster, 4));
  assert.ok(isWeekend(roster, 5));
  assert.ok(!isWeekend(roster, 6));
});

test('parseRoster: ช่องขึ้น 2 กะ/วัน ที่ล็อกไว้ "ช+บ"', () => {
  const doc = {
    days: 5, firstWeekday: 'จันทร์',
    staff: [{ name: 'ก', locked: { '2': 'ช+บ' } }],
  };
  const { roster } = parseRoster(doc, { strict: true });
  const cell = getCell(roster, 0, 1);
  assert.ok(isDouble(cell));
  assert.deepEqual(cell.shifts, ['ช', 'บ']);
  assert.equal(cell.locked, true);
});

test('parseRoster: filled dict = ตั้งค่าแต่ไม่ล็อก', () => {
  const doc = {
    days: 5, firstWeekday: 'จันทร์',
    staff: [{ name: 'ก', locked: { '1': 'ช' }, filled: { '2': 'ด' } }],
  };
  const { roster } = parseRoster(doc, { strict: true });
  assert.equal(getCell(roster, 0, 0).locked, true);
  assert.equal(getCell(roster, 0, 1).locked, false);
  assert.deepEqual(getCell(roster, 0, 1).shifts, ['ด']);
});

test('parseRoster: lenient เก็บ warning สำหรับวัน/❪token❫ ผิด', () => {
  const doc = {
    days: 5, firstWeekday: 'จันทร์',
    staff: [{ name: 'ก', locked: { '9': 'ช', '3': 'zzz' } }],
  };
  const { roster, warnings } = parseRoster(doc);
  assert.equal(warnings.length, 2);
  assert.ok(getCell(roster, 0, 2).shifts.length === 0); // token เสีย → ไม่ตั้ง

  assert.throws(() => parseRoster(doc, { strict: true }));
});

test('serializeRoster: round-trip fixture → object → parse ได้กริดเดิม', () => {
  const first = parseRoster(FIXTURE, { strict: true });
  const doc2 = serializeRoster(first.roster, first.rules);
  const second = parseRoster(doc2, { strict: true });

  assert.equal(second.roster.staff.length, first.roster.staff.length);
  for (let si = 0; si < first.roster.staff.length; si++) {
    for (let di = 0; di < first.roster.days; di++) {
      assert.deepEqual(
        getCell(second.roster, si, di),
        getCell(first.roster, si, di),
        `ช่องไม่ตรงที่ staff ${si} วันที่ ${di + 1}`,
      );
    }
  }
  // ไม่มี filled เพราะ fixture ล็อกทุกช่อง
  assert.ok(doc2.staff.every((s) => s.filled === undefined));
  assert.equal(doc2.staff[0].locked['1'], 'บ');
});

test('serializeRoster: ช่องที่ไม่ล็อกไปอยู่ filled', () => {
  const doc = {
    days: 3, firstWeekday: 'จันทร์',
    staff: [{ name: 'ก', locked: { '1': 'ช' } }],
  };
  const { roster, rules } = parseRoster(doc, { strict: true });
  // เติมช่องไม่ล็อก
  roster.grid[0][2].shifts = ['ด'];
  const out = serializeRoster(roster, rules);
  assert.deepEqual(out.staff[0].locked, { '1': 'ช' });
  assert.deepEqual(out.staff[0].filled, { '3': 'ด' });

  const s = toJSONString(roster, rules);
  assert.equal(typeof s, 'string');
  assert.ok(s.includes('"firstWeekday": "จันทร์"'));
});
