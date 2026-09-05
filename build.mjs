// ============================================================================
// build.mjs — รวม engine + ui เป็นไฟล์เดียว dist/index.html (offline, เปิดได้เลย)
//
//   node build.mjs
//
// วิธี: ตัด import/export ออกจากไฟล์ engine (ES module) แล้ววางต่อกันใน <script>
// ธรรมดา ตัวเดียว — top-level const/function เห็นกันข้าม <script> ได้
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

/** ตัด `import { ... } from '...'` และคำนำหน้า `export ` ทิ้ง */
function stripModule(src) {
  return src
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/^export\s+/gm, '');
}

const engine = [
  read('src/engine/model.js'),
  read('src/engine/io.js'),
  read('src/engine/analyze.js'),
  read('src/engine/solver.js'),
  read('src/engine/csv.js'),
  read('src/engine/xlsx.js'),
].map(stripModule).join('\n\n');

const app = stripModule(read('src/ui/app.js'));
const css = read('src/ui/styles.css');

const html = read('src/ui/index.html')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__APP__*/', () => app);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/index.html'), html);

console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
