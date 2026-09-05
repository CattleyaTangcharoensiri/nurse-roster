import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, csvToStaffGrid, rosterToCsv } from '../src/engine/csv.js';
import { parseRoster } from '../src/engine/io.js';
import { makeRoster, getCell, setCellShifts, setCellOff, OFF } from '../src/engine/model.js';

test('parseCsv: ฟิลด์ในเครื่องหมายคำพูด + คอมมา', () => {
  const rows = parseCsv('a,b,c\r\n"x,1","y""z",\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x,1', 'y"z', '']]);
});

test('parseCsv: ตัด BOM', () => {
  const rows = parseCsv('﻿ชื่อ,1,2\nA,ช,บ');
  assert.equal(rows[0][0], 'ชื่อ');
});

test('csvToStaffGrid: อ่านหัวเลขวัน + ข้ามแถวสรุป', () => {
  const csv = [
    'ชื่อ,1,2,3,4,รวมวันทำงาน,ช',
    'พยาบาล A,ช,,ด,ช+บ,3,2',
    'พยาบาล B,R,บ,,ชบ,2,1',
    'รวม ช,1,1,1,2,,',
  ].join('\n');
  const { days, staff } = csvToStaffGrid(csv);
  assert.equal(days, 4);
  assert.equal(staff.length, 2);
  assert.deepEqual(staff[0].locked, { 1: 'ช', 3: 'ด', 4: 'ช+บ' });
  assert.deepEqual(staff[1].locked, { 1: 'R', 2: 'บ', 4: 'ชบ' });
});

test('csvToStaffGrid → parseRoster: token ควบแบบเขียนติด "ชบ" ใช้ได้', () => {
  const csv = 'ชื่อ,1,2\nพยาบาล A,ชบ,บด';
  const { days, staff } = csvToStaffGrid(csv);
  const { roster } = parseRoster({ days, firstWeekday: 'จันทร์', staff });
  assert.deepEqual(getCell(roster, 0, 0).shifts, ['ช', 'บ']);
  assert.deepEqual(getCell(roster, 0, 1).shifts, ['บ', 'ด']);
});

test('rosterToCsv → csvToStaffGrid: round-trip', () => {
  const roster = makeRoster({ days: 5, firstWeekday: 'จันทร์', staff: [{ name: 'ก' }, { name: 'ข' }] });
  setCellShifts(getCell(roster, 0, 0), ['ช']);
  setCellShifts(getCell(roster, 0, 2), ['ช', 'บ']);
  setCellOff(getCell(roster, 1, 1), OFF.LEAVE);

  const csv = rosterToCsv(roster);
  assert.ok(csv.startsWith('﻿'), 'มี BOM');
  const { days, staff } = csvToStaffGrid(csv);
  assert.equal(days, 5);
  assert.equal(staff[0].name, 'ก');
  assert.deepEqual(staff[0].locked, { 1: 'ช', 3: 'ช+บ' });
  assert.deepEqual(staff[1].locked, { 2: 'V' });
});
