import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRoster } from '../src/engine/io.js';
import { analyze } from '../src/engine/analyze.js';
import { rosterToXlsx } from '../src/engine/xlsx.js';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sample.json', import.meta.url)), 'utf8'),
);

/** อ่าน zip แบบ stored (method 0) → { name: string(bytes) } */
function readStoredZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out = {};
  let i = 0;
  while (i + 4 <= buf.length && dv.getUint32(i, true) === 0x04034b50) {
    const method = dv.getUint16(i + 8, true);
    const size = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const nameStart = i + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = dec.decode(buf.subarray(nameStart, nameStart + nameLen));
    assert.equal(method, 0, `${name} ต้องเป็น stored`);
    out[name] = dec.decode(buf.subarray(dataStart, dataStart + size));
    i = dataStart + size;
  }
  assert.equal(dv.getUint32(i, true), 0x02014b50, 'ต่อจาก local headers ต้องเป็น central directory');
  return out;
}

test('rosterToXlsx: เป็น zip ที่ถูกต้อง มีไฟล์ครบตามสเปก', () => {
  const { roster, rules } = parseRoster(FIXTURE);
  const bytes = rosterToXlsx(roster, rules, analyze(roster, rules));

  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

  const files = readStoredZip(bytes);
  for (const need of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
  ]) {
    assert.ok(files[need], `ต้องมี ${need}`);
  }
});

test('rosterToXlsx: sheet1 มีชื่อพยาบาล + หัวคอลัมน์สรุปแบบ PDF', () => {
  const { roster, rules } = parseRoster(FIXTURE);
  const files = readStoredZip(rosterToXlsx(roster, rules, analyze(roster, rules)));
  const sheet = files['xl/worksheets/sheet1.xml'];

  assert.ok(sheet.includes('พยาบาล A'));
  assert.ok(sheet.includes('รวมวันทำงาน'));
  assert.ok(sheet.includes('วันหยุด O+R'));
  assert.ok(sheet.includes('ขึ้นเวรวันนั้น (คน)'));
  assert.ok(sheet.includes('<pane'), 'ตรึงหัวตาราง');
});

test('rosterToXlsx: หัวเรื่องใช้เดือน/ปี พ.ศ. เมื่อมีในไฟล์', () => {
  const { roster, rules } = parseRoster({ ...FIXTURE, year: 2569, month: 9 });
  const files = readStoredZip(rosterToXlsx(roster, rules, analyze(roster, rules)));
  assert.ok(files['xl/worksheets/sheet1.xml'].includes('ตารางเวร กันยายน 2569'));
});

test('rosterToXlsx: จำนวนแถวข้อมูล = จำนวนพยาบาล + หัว 3 + ท้าย 5', () => {
  const { roster, rules } = parseRoster(FIXTURE);
  const files = readStoredZip(rosterToXlsx(roster, rules, analyze(roster, rules)));
  const sheet = files['xl/worksheets/sheet1.xml'];
  const rowCount = (sheet.match(/<row /g) || []).length;
  assert.equal(rowCount, roster.staff.length + 3 + 5);
});
