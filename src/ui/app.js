// ============================================================================
// app.js — UI ต่อกับ engine (model.js / io.js / analyze.js ถูก bundle มาก่อนหน้า)
//
// engine เปิดเป็น global ให้แล้ว: makeRoster, parseRoster, serializeRoster,
//   analyze, cloneRoster, cellToToken, parseCellToken, setCellShifts, ...
// ============================================================================

(function () {
  'use strict';

  const TH_MONTH = [
    'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
  ];

  // วนค่าเมื่อคลิกซ้าย
  const CYCLE = ['', 'ช', 'บ', 'ด', 'R', 'O', 'V', 'T'];
  // เมนูคลิกขวา (ช+ด ตัดออก — ห้ามเด็ดขาด)
  const PICK = ['ช', 'บ', 'ด', 'ช+บ', 'บ+ด', 'R', 'O', 'V', 'T'];

  const LEGEND = [
    ['ช', 'เช้า', 't-ch'], ['บ', 'บ่าย', 't-b'], ['ด', 'ดึก', 't-d'],
    ['ช+บ', '2 กะ/วัน', 't-dbl'], ['บ+ด', '2 กะ/วัน', 't-dbl'],
    ['R', 'หยุด', 't-R'], ['O', 'หยุด (ระบบเติม)', 't-O'], ['V', 'ลา', 't-V'], ['T', 'อบรม', 't-T'],
  ];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const now = new Date();
  const S = {
    roster: null, rules: null, report: null,
    month: { be: now.getFullYear() + 543, mn: now.getMonth() + 1 },
  };
  const undoStack = [];
  let toastTimer = 0;

  // อุปกรณ์สัมผัส (มือถือ/แท็บเล็ต) — ใช้ "แตะค้าง" แทนคลิกขวา
  const IS_TOUCH = matchMedia('(hover: none)').matches;
  let lastLongPress = 0;

  // ---------------------------------------------------------------------------
  // เดือน / ปี (พ.ศ.) — คำนวณจำนวนวัน + วันเริ่มต้นจากปฏิทินจริง
  // ---------------------------------------------------------------------------
  const DEFAULT_ROWS = 12;

  function calendarFor(be, mn) {
    const ce = be - 543;
    const days = new Date(ce, mn, 0).getDate();
    const fwi = new Date(ce, mn - 1, 1).getDay(); // 0=อาทิตย์ ตรงกับ WEEKDAYS
    return { days, firstWeekdayIndex: fwi, firstWeekday: WEEKDAYS[fwi] };
  }

  /** ตารางเปล่าของเดือนที่เลือก (แถวพยาบาลว่าง ๆ) */
  function blankRoster(be, mn, rows) {
    const cal = calendarFor(be, mn);
    const staff = [];
    for (let i = 1; i <= rows; i++) staff.push({ name: `พยาบาล ${i}` });
    return makeRoster({ days: cal.days, firstWeekday: cal.firstWeekday, year: be, month: mn, staff });
  }

  function initMonthUI() {
    const sel = $('#selMonth');
    TH_MONTH.forEach((name, i) => {
      const o = el('option', null, name);
      o.value = String(i + 1);
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => setMonth(S.month.be, +sel.value));
    $('#selYear').addEventListener('change', () => {
      const be = +$('#selYear').value;
      if (be >= 2500 && be <= 2650) setMonth(be, S.month.mn);
      else syncMonthUI();
    });
    syncMonthUI();
  }

  function syncMonthUI() {
    $('#selMonth').value = String(S.month.mn);
    $('#selYear').value = String(S.month.be);
  }

  // ---------------------------------------------------------------------------
  // กติกา: วันหยุด O+R ต่อคน
  // ---------------------------------------------------------------------------
  const TARGET_INPUT = { [SHIFT.MORNING]: 'selTargetCh', [SHIFT.AFTERNOON]: 'selTargetB', [SHIFT.NIGHT]: 'selTargetD' };

  function syncRuleUI() {
    if (!S.rules) return;
    for (const sh of SHIFT_VALUES) $('#' + TARGET_INPUT[sh]).value = String(S.rules.target[sh].min);
    $('#selQuota').value = String(S.rules.offQuota);
    $('#selExact').checked = S.rules.offQuotaMode === 'exact';
    $('#selMaxDbl').value = String(S.rules.maxDoublesPerPerson);
  }
  function initRuleUI() {
    for (const sh of SHIFT_VALUES) {
      const input = $('#' + TARGET_INPUT[sh]);
      input.addEventListener('change', () => {
        const n = +input.value;
        if (Number.isInteger(n) && n >= 0 && n <= 99) { S.rules.target[sh] = { min: n, max: n }; afterRuleChange(); }
        else syncRuleUI();
      });
    }
    $('#selQuota').addEventListener('change', () => {
      const n = +$('#selQuota').value;
      if (Number.isInteger(n) && n >= 0 && n <= 31) { S.rules.offQuota = n; afterRuleChange(); }
      else syncRuleUI();
    });
    $('#selExact').addEventListener('change', () => {
      S.rules.offQuotaMode = $('#selExact').checked ? 'exact' : 'max';
      afterRuleChange();
    });
    $('#selMaxDbl').addEventListener('change', () => {
      const n = +$('#selMaxDbl').value;
      if (Number.isInteger(n) && n >= 0 && n <= 15) { S.rules.maxDoublesPerPerson = n; afterRuleChange(); }
      else syncRuleUI();
    });
    syncRuleUI();
  }

  // ตารางถูกจัดเต็มแล้วหรือยัง — ไม่มีช่องว่างที่แก้ได้ และมีเวร/O ที่ระบบเติมอยู่จริง
  function rosterFilled() {
    const r = S.roster;
    if (!r || !r.staff.length) return false;
    let hasFill = false;
    for (const row of r.grid) {
      for (const c of row) {
        if (isEmpty(c) && !c.locked) return false;
        if (!c.locked && (c.shifts.length > 0 || c.off === OFF.FILLED)) hasFill = true;
      }
    }
    return hasFill;
  }

  // เปลี่ยนกติกาแล้ว: ถ้าตารางถูกจัดเต็มอยู่แล้ว จัดใหม่ให้ตรงกติกาใหม่; ถ้ายัง แค่ re-render
  function afterRuleChange() {
    if (rosterFilled()) runSolve();
    else render();
  }

  function shiftMonth(delta) {
    let { be, mn } = S.month;
    mn += delta;
    if (mn > 12) { mn = 1; be += 1; }
    if (mn < 1) { mn = 12; be -= 1; }
    setMonth(be, mn);
  }

  function resizeRoster(r, days) {
    if (days === r.days) return;
    if (days > r.days) {
      for (const row of r.grid) while (row.length < days) row.push(makeCell());
    } else {
      let lost = 0;
      for (const row of r.grid) {
        for (let d = days; d < row.length; d++) {
          const c = row[d];
          if (c.shifts.length || c.off !== null) lost += 1;
        }
        row.length = days;
      }
      if (lost) toast(`ตัดวันที่ ${days + 1}–${r.days} ออก (มีข้อมูล ${lost} ช่อง)`);
    }
    r.days = days;
  }

  function setMonth(be, mn) {
    S.month = { be, mn };
    const cal = calendarFor(be, mn);
    if (S.roster) {
      pushUndo();
      resizeRoster(S.roster, cal.days);
      S.roster.firstWeekday = cal.firstWeekday;
      S.roster.firstWeekdayIndex = cal.firstWeekdayIndex;
      S.roster.year = be;
      S.roster.month = mn;
    }
    syncMonthUI();
    render();
  }

  // ---------------------------------------------------------------------------
  // token → คลาสสี
  // ---------------------------------------------------------------------------
  function tokenClass(tok) {
    if (!tok) return 'empty';
    if (tok.includes('+')) return 't-dbl';
    return { 'ช': 't-ch', 'บ': 't-b', 'ด': 't-d', 'R': 't-R', 'O': 't-O', 'V': 't-V', 'T': 't-T' }[tok] || '';
  }

  // ---------------------------------------------------------------------------
  // โหลด / บันทึก
  // ---------------------------------------------------------------------------
  function loadDoc(doc) {
    const { roster, rules, warnings } = parseRoster(doc);
    S.roster = roster;
    S.rules = rules;
    if (roster.year && roster.month) S.month = { be: roster.year, mn: roster.month };
    undoStack.length = 0;
    syncMonthUI();
    syncRuleUI();
    render();
    if (warnings.length) toast(`เปิดไฟล์ได้ (มีคำเตือน ${warnings.length} รายการ)`);
  }

  function saveDoc() {
    if (!S.roster) return;
    const text = JSON.stringify(serializeRoster(S.roster, S.rules), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'roster.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------------------
  // แก้ค่าช่อง
  // ---------------------------------------------------------------------------
  function pushUndo() {
    undoStack.push(cloneRoster(S.roster));
    if (undoStack.length > 60) undoStack.shift();
  }
  function undo() {
    if (!undoStack.length) return;
    S.roster = undoStack.pop();
    render();
  }

  function setToken(si, di, tok) {
    const cell = S.roster.grid[si][di];
    if (tok === '') { clearCellValue(cell); return; }
    const p = parseCellToken(tok);
    if (p.off !== null) setCellOff(cell, p.off);
    else setCellShifts(cell, p.shifts);
  }

  function cycleCell(si, di) {
    const cell = S.roster.grid[si][di];
    const cur = cellToToken(cell) || '';
    const idx = CYCLE.indexOf(cur.includes('+') ? '' : cur);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    pushUndo();
    const wasLocked = cell.locked;
    setToken(si, di, next);
    cell.locked = wasLocked;
    render();
  }

  function toggleLock(si, di) {
    const cell = S.roster.grid[si][di];
    pushUndo();
    cell.locked = !cell.locked;
    render();
  }

  // ---------------------------------------------------------------------------
  // เมนูคลิกขวา
  // ---------------------------------------------------------------------------
  function openMenu(x, y, si, di) {
    const menu = $('#menu');
    menu.innerHTML = '';
    const cell = S.roster.grid[si][di];

    for (const tok of PICK) {
      const b = el('button');
      b.appendChild(withChip(tok));
      b.onclick = () => { pushUndo(); const lk = cell.locked; setToken(si, di, tok); cell.locked = lk; closeMenu(); render(); };
      menu.appendChild(b);
    }
    menu.appendChild(el('div', 'sep'));

    const clr = el('button', null, 'ล้างช่อง');
    clr.onclick = () => { pushUndo(); const lk = cell.locked; setToken(si, di, ''); cell.locked = lk; closeMenu(); render(); };
    menu.appendChild(clr);

    const lk = el('button', null, cell.locked ? 'ปลดล็อก' : 'ล็อกช่อง');
    lk.onclick = () => { toggleLock(si, di); closeMenu(); };
    menu.appendChild(lk);

    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  }
  function closeMenu() { $('#menu').hidden = true; }
  function withChip(tok) {
    const s = el('span', 'chip ' + tokenClass(tok), tok);
    s.style.minWidth = '0';
    return s;
  }

  function placeMenu(menu, x, y) {
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  }

  /** เมนู "กะที่พยาบาลคนนี้ทำได้" (staff.allow) — เปิดค้าง กดติ๊กได้หลายรอบ */
  function openAllowMenu(x, y, si) {
    const menu = $('#menu');
    const staff = S.roster.staff[si];
    const all = ALLOW_TOKENS;
    const set = new Set(staff.allow && staff.allow.length ? staff.allow : all);
    let snapshotPushed = false;

    const commit = () => {
      if (!snapshotPushed) { pushUndo(); snapshotPushed = true; }
      staff.allow = (set.size === all.length) ? [] : all.filter((t) => set.has(t));
      render();
    };

    menu.innerHTML = '';
    menu.appendChild(el('div', 'menu-head', `กะที่ทำได้ · ${staff.name}`));

    for (const tok of all) {
      const b = el('button');
      const chk = el('span', 'chk', set.has(tok) ? '☑' : '☐');
      b.appendChild(chk);
      b.appendChild(withChip(tok));
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (set.has(tok)) { if (set.size <= 1) { toast('ต้องเลือกอย่างน้อย 1 กะ'); return; } set.delete(tok); }
        else set.add(tok);
        chk.textContent = set.has(tok) ? '☑' : '☐';
        commit();
      };
      menu.appendChild(b);
    }

    menu.appendChild(el('div', 'sep'));
    const clr = el('button', null, 'ทุกกะ (ไม่จำกัด)');
    clr.onclick = (ev) => {
      ev.stopPropagation();
      set.clear();
      for (const t of all) set.add(t);
      for (const el2 of menu.querySelectorAll('.chk')) el2.textContent = '☑';
      commit();
    };
    menu.appendChild(clr);

    const done = el('button', 'menu-done', 'เสร็จ');
    done.onclick = (ev) => { ev.stopPropagation(); closeMenu(); };
    menu.appendChild(done);

    placeMenu(menu, x, y);
  }

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  function render() {
    const r = S.roster;
    const empty = $('#empty');
    const grid = $('#grid');
    if (!r || r.staff.length === 0) {
      empty.classList.add('show');
      grid.style.display = 'none';
      $('#report').hidden = true;
      $('#reportBtn').classList.remove('on');
      syncReportOpen();
      $('#title').textContent = r ? titleText(r) : 'จัดตารางเวรพยาบาล';
      return;
    }
    empty.classList.remove('show');
    grid.style.display = '';

    S.report = analyze(r, S.rules);
    $('#title').textContent = titleText(r);
    renderLegend();
    renderHead(r);
    renderBody(r);
    renderFoot(r);
    if (!$('#report').hidden) renderReport();
  }

  function titleText(r) {
    if (r.year && r.month) return `${TH_MONTH[r.month - 1]} ${r.year} · ${r.days} วัน`;
    return `${r.days} วัน · เริ่มวัน${r.firstWeekday}`;
  }

  function renderLegend() {
    const box = $('#legend');
    box.innerHTML = '';
    for (const [tok, label, cls] of LEGEND) {
      const s = el('span', 'sym ' + cls);
      s.appendChild(el('b', null, tok));
      s.appendChild(el('span', null, label));
      box.appendChild(s);
    }
    box.appendChild(el('span', 'hint', IS_TOUCH
      ? 'แตะช่องเพื่อวนค่า · แตะค้าง = เลือกค่า/ล็อก · แตะค้างที่ชื่อ = กำหนดกะที่ทำได้ · แตะชื่อ = แก้ชื่อ'
      : 'คลิกช่องเพื่อวนค่า · Shift+คลิก ล็อก · คลิกขวา เลือกค่า · คลิกขวาที่ชื่อ = กำหนดกะที่ทำได้ · Ctrl+Z ย้อน'));
  }

  function renderHead(r) {
    const tr = el('tr');
    tr.appendChild(thName('พยาบาล'));
    for (let d = 0; d < r.days; d++) {
      const th = el('th', 'day');
      if (isWeekend(r, d)) th.classList.add('wknd');
      if (S.report.gaps.some((g) => g.day === d + 1 && g.status === 'over')) th.classList.add('bad');
      th.appendChild(el('span', 'dh-num', String(d + 1)));
      th.appendChild(el('span', 'dh-dow', WEEKDAY_SHORT[weekdayIndexForDay(r, d)]));
      tr.appendChild(th);
    }
    const th = el('th', 'col-sum');
    th.title = 'รวมวันทำงาน · ช · บ · ด · ช+บ (2 กะ/วัน) · วันหยุด O+R';
    th.appendChild(sumRow(['รวม', 'ช', 'บ', 'ด', 'ช+บ', 'O+R'], true));
    tr.appendChild(th);
    const head = $('#grid thead');
    head.innerHTML = '';
    head.appendChild(tr);
  }
  function thName(t) { const th = el('th', 'col-name', t); return th; }

  /** แถวตารางสรุปด้านขวา (6 ช่อง) — เลย์เอาต์เหมือน PDF */
  function sumRow(vals, head) {
    const g = el('div', 'sumgrid' + (head ? ' head' : ''));
    for (const v of vals) {
      const s = el('span', (!head && (v === 0 || v === '0')) ? 'z' : null, String(v));
      g.appendChild(s);
    }
    return g;
  }

  function badCellSet() {
    const set = new Set();
    const idById = {};
    S.roster.staff.forEach((s, i) => { idById[s.id] = i; });
    for (const v of S.report.violations) {
      if (v.staffId != null && v.day != null && idById[v.staffId] != null) {
        set.add(idById[v.staffId] + '|' + (v.day - 1));
      }
    }
    return set;
  }

  function renderBody(r) {
    const bad = badCellSet();
    const body = $('#grid tbody');
    body.innerHTML = '';
    r.staff.forEach((staff, si) => {
      const tr = el('tr');
      const name = el('td', 'col-name');
      name.dataset.si = si;
      const nm1 = el('span', 'nm-1', staff.name);
      nm1.title = 'ดับเบิลคลิก/แตะเพื่อแก้ชื่อ · คลิกขวา/แตะค้าง = กะที่ทำได้';
      const doRename = () => {
        const v = window.prompt('ชื่อพยาบาล', staff.name);
        if (v != null) { pushUndo(); staff.name = v.trim() || staff.name; render(); }
      };
      nm1.ondblclick = doRename;
      if (IS_TOUCH) nm1.onclick = () => { if (Date.now() - lastLongPress < 700) return; doRename(); };
      name.appendChild(nm1);
      const bits = [staff.role, staff.team].filter(Boolean);
      if (staff.allow && staff.allow.length) bits.push('กะ: ' + staff.allow.join(' '));
      if (bits.length) name.appendChild(el('span', 'nm-2', bits.join(' · ')));
      const cfg = el('button', 'rowcfg', 'กะ');
      cfg.title = 'กำหนดกะที่พยาบาลคนนี้ทำได้';
      cfg.onclick = (ev) => { ev.stopPropagation(); openAllowMenu(ev.clientX, ev.clientY, si); };
      name.appendChild(cfg);
      const del = el('button', 'rowdel', '×');
      del.title = 'ลบแถวนี้';
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (S.roster.staff.length <= 1) { toast('ต้องมีอย่างน้อย 1 แถว'); return; }
        pushUndo();
        removeStaff(S.roster, si);
        render();
      };
      name.appendChild(del);
      tr.appendChild(name);

      for (let di = 0; di < r.days; di++) {
        const cell = r.grid[si][di];
        const td = el('td', 'cell');
        if (isWeekend(r, di)) td.classList.add('wknd');
        if (cell.locked) td.classList.add('locked');
        if (bad.has(si + '|' + di)) td.classList.add('bad');
        const tok = cellToToken(cell) || '';
        td.appendChild(el('span', 'chip ' + tokenClass(tok), tok || '·'));
        td.dataset.si = si;
        td.dataset.di = di;
        tr.appendChild(td);
      }

      const p = S.report.perPerson[si];
      const sum = el('td', 'col-sum');
      const extra = [p.leave ? `V ${p.leave}` : '', p.training ? `T ${p.training}` : ''].filter(Boolean).join(' · ');
      if (extra) sum.title = extra;
      sum.appendChild(sumRow(
        [p.work, p.byShift['ช'], p.byShift['บ'], p.byShift['ด'], p.doubles, p.rest],
        false,
      ));
      tr.appendChild(sum);
      body.appendChild(tr);
    });
  }

  function renderFoot(r) {
    const cov = {};
    for (const c of S.report.coverage) cov[c.day + '|' + c.shift] = c;

    const foot = $('#grid tfoot');
    foot.innerHTML = '';

    for (const sh of ['ช', 'บ', 'ด']) {
      const tr = el('tr');
      tr.appendChild(el('td', 'col-name', `รวม ${sh}`));
      for (let d = 0; d < r.days; d++) {
        const c = cov[(d + 1) + '|' + sh];
        const td = el('td', 'day');
        if (c) {
          td.classList.add('cnt', c.status);
          td.textContent = c.assigned;
        } else td.textContent = '–';
        tr.appendChild(td);
      }
      const c0 = cov['1|' + sh] || { min: 0, max: 0 };
      tr.appendChild(el('td', 'col-sum', `เป้า ${c0.min}${c0.max === c0.min ? '' : '–' + (c0.max == null ? '∞' : c0.max)}`));
      foot.appendChild(tr);
    }

    // แถว "ขึ้นเวรวันนั้น (คน)" — เหมือน PDF
    const trW = el('tr');
    trW.appendChild(el('td', 'col-name', 'ขึ้นเวรวันนั้น (คน)'));
    for (let d = 0; d < r.days; d++) {
      let n = 0;
      for (let si = 0; si < r.staff.length; si++) if (r.grid[si][d].shifts.length > 0) n++;
      trW.appendChild(el('td', 'day', String(n)));
    }
    trW.appendChild(el('td', 'col-sum', ''));
    foot.appendChild(trW);

    // แถว R+O ต่อวัน
    const tr = el('tr');
    tr.appendChild(el('td', 'col-name', 'หยุด R+O'));
    for (let d = 0; d < r.days; d++) {
      let n = 0;
      for (let si = 0; si < r.staff.length; si++) if (isRest(r.grid[si][d])) n++;
      tr.appendChild(el('td', 'day', String(n)));
    }
    tr.appendChild(el('td', 'col-sum', `โควตา ${S.rules.offQuota}/คน`));
    foot.appendChild(tr);
  }

  // ---------------------------------------------------------------------------
  // REPORT panel
  // ---------------------------------------------------------------------------
  function syncReportOpen() {
    document.querySelector('.app').classList.toggle('report-open', !$('#report').hidden);
  }

  function toggleReport() {
    const p = $('#report');
    p.hidden = !p.hidden;
    $('#reportBtn').classList.toggle('on', !p.hidden);
    syncReportOpen();
    if (!p.hidden) renderReport();
  }

  function renderReport() {
    const rep = S.report;
    if (!rep) return;
    const f = rep.feasibility;
    const p = $('#report');
    p.innerHTML = '';

    const head = el('div', 'rp-head');
    const pill = f.feasible ? '<span class="pill good">จัดได้</span>' : '<span class="pill bad">ยังจัดไม่ได้</span>';
    head.innerHTML = `<b>รายงาน</b> ${pill} <span style="flex:1"></span>`;
    const x = el('button', 'btn', 'ปิด');
    x.onclick = toggleReport;
    head.appendChild(x);
    p.appendChild(head);

    const body = el('div', 'rp-body');

    // การ์ด 0 — คำแนะนำสำหรับเดือนนี้
    const adv = rep.advice;
    if (adv && adv.lines && adv.lines.length) {
      const c0 = el('div', 'rp-card');
      c0.innerHTML = `<h4>คำแนะนำ — ${adv.days} วัน · ${adv.staff} คน · หยุด ${adv.quota} · ต้องการ ${adv.shiftsNeeded} กะ</h4>`;
      const cls = { over: 'warn', under: 'error', tight: 'warn' }[adv.status] || '';
      adv.lines.forEach((line, i) => c0.appendChild(el('div', 'rp-line ' + (i === 0 ? cls : ''), (i === 0 ? '' : '• ') + line)));
      if (adv.table && adv.table.length > 1) {
        c0.appendChild(el('div', 'rp-line', 'คน → เวรคู่:  ' + adv.table.map((x) => `${x.staff}→${x.doubles}`).join('   ')));
      }
      body.appendChild(c0);
    }

    // การ์ด 1 — ความเป็นไปได้
    const c1 = el('div', 'rp-card');
    c1.innerHTML = `<h4>ความเป็นไปได้</h4>
      <div class="rp-stat"><b>${f.slotsNeeded}</b><span>slot ที่ต้องการ (ทั้งเดือน)</span></div>
      <div class="rp-stat"><b>${f.workDaysAvailable}</b><span>วัน-คน ที่ว่างทำงาน</span></div>
      <div class="rp-stat"><b class="${f.doublesNeeded > f.doubleCapacity ? 'warn' : ''}">${f.doublesNeeded}</b><span>ต้องเพิ่มวันขึ้น 2 กะ/วัน (เพดานรวม ${f.doubleCapacity})</span></div>
      <div class="rp-stat"><b>${f.avgDoublesPerPerson}</b><span>เฉลี่ยต่อคน</span></div>
      <div class="rp-stat"><b>${f.restDays}</b><span>วันหยุด R+O · ลา ${f.leaveDays} · อบรม ${f.trainingDays}</span></div>`;
    if (f.reasons.length) {
      for (const rs of f.reasons) c1.appendChild(el('div', 'rp-line error', rs));
    }
    body.appendChild(c1);

    // การ์ด 2 — coverage ที่ยังไม่ครบ
    const c2 = el('div', 'rp-card');
    const under = rep.gaps.filter((g) => g.status === 'under');
    const over = rep.gaps.filter((g) => g.status === 'over');
    c2.innerHTML = `<h4>คนไม่พอ/เกิน (${under.length} ขาด · ${over.length} เกิน)</h4>`;
    if (!under.length && !over.length) c2.appendChild(el('div', 'rp-ok', 'ครบทุกกะทุกวัน'));
    for (const g of over) c2.appendChild(el('div', 'rp-line error', `วันที่ ${g.day} ${g.shift}: ${g.assigned} คน (เพดาน ${g.max})`));
    for (const g of under.slice(0, 40)) c2.appendChild(el('div', 'rp-line', `วันที่ ${g.day} ${g.shift}: ${g.assigned}/${g.min}`));
    if (under.length > 40) c2.appendChild(el('div', 'rp-ok', `…และอีก ${under.length - 40}`));
    body.appendChild(c2);

    // การ์ด 3 — การละเมิดกฎ
    const c3 = el('div', 'rp-card');
    c3.innerHTML = `<h4>ผิดกฎ (${rep.summary.errors} error · ${rep.summary.warnings} เตือน)</h4>`;
    if (!rep.violations.length) c3.appendChild(el('div', 'rp-ok', 'ไม่พบการละเมิดกฎ'));
    for (const v of rep.violations) c3.appendChild(el('div', 'rp-line ' + v.severity, v.message));
    body.appendChild(c3);

    p.appendChild(body);
  }

  // ---------------------------------------------------------------------------
  // toast
  // ---------------------------------------------------------------------------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------
  function fileBase() {
    const r = S.roster;
    return (r && r.year && r.month) ? `เวร-${TH_MONTH[r.month - 1]}-${r.year}` : 'เวร';
  }
  function downloadBytes(bytes, name, mime) {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportXlsx() {
    if (!S.roster) return;
    const rep = S.report || analyze(S.roster, S.rules);
    downloadBytes(
      rosterToXlsx(S.roster, S.rules, rep),
      fileBase() + '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  }
  function exportCsv() {
    if (!S.roster) return;
    downloadBytes(new TextEncoder().encode(rosterToCsv(S.roster)), fileBase() + '.csv', 'text/csv;charset=utf-8');
  }

  function onAction(act) {
    if (act === 'sample') loadDoc(SAMPLE);
    else if (act === 'open') $('#file').click();
    else if (act === 'save') saveDoc();
    else if (act === 'exportXlsx') exportXlsx();
    else if (act === 'exportCsv') exportCsv();
    else if (act === 'print') window.print();
    else if (act === 'clear') {
      pushUndo();
      S.rules = mergeRules({});
      S.roster = blankRoster(S.month.be, S.month.mn, DEFAULT_ROWS);
      syncRuleUI();
      render();
    }
    else if (act === 'addStaff') {
      pushUndo();
      addStaff(S.roster, { name: `พยาบาล ${S.roster.staff.length + 1}` });
      render();
    }
    else if (act === 'report') toggleReport();
    else if (act === 'solve') runSolve();
    else if (act === 'prevMonth') shiftMonth(-1);
    else if (act === 'nextMonth') shiftMonth(1);
  }

  function runSolve() {
    if (!S.roster || S.roster.staff.length === 0) { toast('ยังไม่มีข้อมูล'); return; }
    const btn = $('#solveBtn');
    btn.disabled = true;
    btn.textContent = 'กำลังจัด…';
    toast('กำลังจัดตาราง…');
    setTimeout(() => {
      try {
        pushUndo();
        const t0 = performance.now();
        const res = solve(S.roster, S.rules, { seed: 1 });
        S.roster = res.roster;
        render();
        if ($('#report').hidden) toggleReport();
        const ms = Math.round(performance.now() - t0);
        const left = S.report.gaps.filter((g) => g.status === 'under').length;
        toast(`จัดเสร็จใน ${ms} ms · เติม ${res.filled} ช่อง` + (left ? ` · ยังขาด ${left} กะ` : ' · ครบทุกกะ'));
      } catch (err) {
        toast('จัดไม่สำเร็จ: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'จัดตารางอัตโนมัติ';
      }
    }, 30);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) { onAction(b.dataset.act); return; }
    if (Date.now() - lastLongPress < 700) return; // กันคลิกลวงหลังแตะค้าง
    if (!e.target.closest('#menu')) closeMenu();
  });

  $('#grid').addEventListener('click', (e) => {
    if (Date.now() - lastLongPress < 700) return; // แตะค้างเพิ่งเปิดเมนู — ไม่วนค่า
    const td = e.target.closest('td.cell');
    if (!td) return;
    const si = +td.dataset.si, di = +td.dataset.di;
    if (e.shiftKey) toggleLock(si, di);
    else cycleCell(si, di);
  });

  $('#grid').addEventListener('contextmenu', (e) => {
    if (Date.now() - lastLongPress < 700) { e.preventDefault(); return; }
    const nameTd = e.target.closest('tbody td.col-name');
    if (nameTd) {
      e.preventDefault();
      openAllowMenu(e.clientX, e.clientY, +nameTd.dataset.si);
      return;
    }
    const td = e.target.closest('td.cell');
    if (!td) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, +td.dataset.si, +td.dataset.di);
  });

  // แตะค้าง (touch) = เปิดเมนูเลือกค่า เหมือนคลิกขวาบนเดสก์ท็อป
  let lpTimer = 0;
  let lpXY = null;
  $('#grid').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearTimeout(lpTimer); return; }
    const cellTd = e.target.closest('td.cell');
    const nameTd = e.target.closest('tbody td.col-name');
    if (!cellTd && !nameTd) return;
    const t = e.touches[0];
    lpXY = { x: t.clientX, y: t.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      lastLongPress = Date.now();
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* ignore */ } }
      if (nameTd) openAllowMenu(lpXY.x, lpXY.y, +nameTd.dataset.si);
      else openMenu(lpXY.x, lpXY.y, +cellTd.dataset.si, +cellTd.dataset.di);
    }, 420);
  }, { passive: true });
  $('#grid').addEventListener('touchmove', (e) => {
    if (!lpXY || !e.touches.length) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpXY.x) > 12 || Math.abs(t.clientY - lpXY.y) > 12) clearTimeout(lpTimer);
  }, { passive: true });
  const endLongPress = () => clearTimeout(lpTimer);
  $('#grid').addEventListener('touchend', endLongPress, { passive: true });
  $('#grid').addEventListener('touchcancel', endLongPress, { passive: true });

  $('#file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const text = String(fr.result);
      try {
        const isCsv = /\.csv$/i.test(file.name) || !/^\s*[{[]/.test(text);
        if (isCsv) {
          const { days, staff } = csvToStaffGrid(text);
          const cal = calendarFor(S.month.be, S.month.mn);
          loadDoc({ days, firstWeekday: cal.firstWeekday, year: S.month.be, month: S.month.mn, staff });
          if (days !== cal.days) toast(`CSV มี ${days} วัน — เลือกเดือนให้ตรงถ้าต้องการปฏิทินถูก`);
        } else {
          loadDoc(JSON.parse(text));
        }
      } catch (err) {
        toast('เปิดไฟล์ไม่สำเร็จ: ' + err.message);
      }
    };
    fr.readAsText(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName);
    if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape') closeMenu();
  });

  // กันปิด/รีเฟรชพลาดตอนมีข้อมูล (ไม่มีบันทึกอัตโนมัติ — สำคัญบนมือถือ)
  window.addEventListener('beforeunload', (e) => {
    const dirty = S.roster && S.roster.grid.some((row) => row.some((c) => c.shifts.length || c.off));
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // ตัวอย่าง — ตารางเวรที่ "จัดครบสมบูรณ์" ไว้ให้หัวหน้าพยาบาลดูเป็นแบบ
  //   ตุลาคม 2569 · 16 คน · เป้า ช5/บ4/ด3 ทุกวัน · หยุด R+O คนละ 8 พอดี
  //   coverage ครบทุกวัน · ไม่ผิดกฎ · เวรคู่แค่ 4 ครั้ง (ช+บ / บ+ด) กระจายทั้งเดือน
  // ---------------------------------------------------------------------------
  const SAMPLE = {
    days: 31,
    firstWeekday: 'พฤหัสบดี',
    year: 2569,
    month: 10,
    rules: {
      target: { 'ช': 5, 'บ': 4, 'ด': 3 },
      offQuota: 8, offQuotaMode: 'exact', countLeaveInQuota: false,
      allowedDoubles: ['ช+บ', 'บ+ด'],
      maxNightToMorning: 0, maxConsecutiveNights: 2, maxConsecutiveWork: 5,
      maxConsecutiveOff: 2, maxDoublesPerPerson: 4, minGapBetweenDoubles: 3,
    },
    staff: [
      { name: 'พยาบาล 1', filled: { 1: 'O', 2: 'ช', 3: 'ด', 4: 'บ', 5: 'ช', 6: 'ช', 7: 'O', 8: 'ช', 9: 'ช', 10: 'ช', 11: 'บ', 12: 'O', 13: 'ด', 14: 'บ', 15: 'บ', 16: 'O', 17: 'ช', 18: 'O', 19: 'ด', 20: 'ด', 21: 'O', 22: 'ด', 23: 'บ', 24: 'ช', 25: 'ช', 26: 'O', 27: 'บ+ด', 28: 'ด', 29: 'O', 30: 'ด', 31: 'บ' } },
      { name: 'พยาบาล 2', filled: { 1: 'ด', 2: 'บ', 3: 'O', 4: 'ช', 5: 'ด', 6: 'O', 7: 'ช', 8: 'ช', 9: 'ด', 10: 'O', 11: 'ช', 12: 'ด', 13: 'บ', 14: 'O', 15: 'ด', 16: 'บ', 17: 'บ', 18: 'ช', 19: 'บ', 20: 'O', 21: 'บ', 22: 'บ', 23: 'บ', 24: 'O', 25: 'O', 26: 'ด', 27: 'ด', 28: 'บ', 29: 'ช', 30: 'ช', 31: 'O' } },
      { name: 'พยาบาล 3', filled: { 1: 'บ', 2: 'O', 3: 'ด', 4: 'บ', 5: 'บ', 6: 'บ', 7: 'บ', 8: 'O', 9: 'ช', 10: 'บ', 11: 'บ', 12: 'O', 13: 'ช', 14: 'บ', 15: 'ช', 16: 'O', 17: 'O', 18: 'ด', 19: 'ด', 20: 'บ', 21: 'บ', 22: 'ช', 23: 'O', 24: 'ด', 25: 'O', 26: 'ด', 27: 'บ', 28: 'ด', 29: 'ด', 30: 'บ', 31: 'O' } },
      { name: 'พยาบาล 4', filled: { 1: 'ช', 2: 'ช', 3: 'ช', 4: 'O', 5: 'ช', 6: 'ช', 7: 'O', 8: 'ด', 9: 'บ', 10: 'ช', 11: 'O', 12: 'ช', 13: 'ช', 14: 'ช', 15: 'O', 16: 'ช', 17: 'ช', 18: 'บ', 19: 'ช', 20: 'O', 21: 'O', 22: 'ช', 23: 'ด', 24: 'บ', 25: 'ด', 26: 'O', 27: 'ช', 28: 'ช', 29: 'ช', 30: 'O', 31: 'ด' } },
      { name: 'พยาบาล 5', filled: { 1: 'ช', 2: 'ช', 3: 'O', 4: 'ช', 5: 'ช', 6: 'ช', 7: 'บ', 8: 'O', 9: 'O', 10: 'ช', 11: 'ช', 12: 'ด', 13: 'O', 14: 'ด', 15: 'บ', 16: 'ช', 17: 'O', 18: 'ด', 19: 'บ', 20: 'O', 21: 'O', 22: 'ด', 23: 'บ', 24: 'ช', 25: 'บ', 26: 'บ', 27: 'O', 28: 'ด', 29: 'บ', 30: 'ช', 31: 'ช' } },
      { name: 'พยาบาล 6', filled: { 1: 'O', 2: 'ด', 3: 'ด', 4: 'บ', 5: 'บ', 6: 'บ', 7: 'O', 8: 'ช', 9: 'ช', 10: 'ช', 11: 'บ', 12: 'O', 13: 'ด', 14: 'O', 15: 'ช', 16: 'ช', 17: 'บ', 18: 'O', 19: 'ช', 20: 'ช', 21: 'O', 22: 'ด', 23: 'ด', 24: 'บ', 25: 'ช', 26: 'ช', 27: 'O', 28: 'ช', 29: 'O', 30: 'ช', 31: 'ช' } },
      { name: 'พยาบาล 7', filled: { 1: 'บ', 2: 'บ', 3: 'O', 4: 'ด', 5: 'ด', 6: 'O', 7: 'ด', 8: 'บ', 9: 'ช', 10: 'ช', 11: 'ช', 12: 'O', 13: 'ช', 14: 'ช', 15: 'ช', 16: 'O', 17: 'ด', 18: 'บ', 19: 'บ', 20: 'O', 21: 'ด', 22: 'บ', 23: 'ช', 24: 'O', 25: 'ด', 26: 'บ', 27: 'O', 28: 'O', 29: 'ด', 30: 'บ', 31: 'บ' } },
      { name: 'พยาบาล 8', filled: { 1: 'ด', 2: 'บ', 3: 'บ', 4: 'O', 5: 'ช', 6: 'ช', 7: 'บ', 8: 'O', 9: 'O', 10: 'ด', 11: 'บ', 12: 'O', 13: 'ช', 14: 'บ', 15: 'O', 16: 'ช', 17: 'บ', 18: 'ช', 19: 'O', 20: 'ช+บ', 21: 'บ', 22: 'ช', 23: 'บ', 24: 'O', 25: 'บ', 26: 'ช', 27: 'บ', 28: 'O', 29: 'บ', 30: 'ช', 31: 'ช' } },
      { name: 'พยาบาล 9', filled: { 1: 'ช', 2: 'ช', 3: 'บ', 4: 'O', 5: 'O', 6: 'ด', 7: 'ด', 8: 'บ', 9: 'บ', 10: 'O', 11: 'ช', 12: 'ช', 13: 'บ', 14: 'ช', 15: 'O', 16: 'ช', 17: 'ช', 18: 'บ', 19: 'ช', 20: 'O', 21: 'ช', 22: 'ช', 23: 'ช', 24: 'O', 25: 'O', 26: 'ด', 27: 'ด', 28: 'บ', 29: 'ช', 30: 'ช', 31: 'O' } },
      { name: 'พยาบาล 10', filled: { 1: 'บ', 2: 'ช', 3: 'ช', 4: 'O', 5: 'ช', 6: 'บ', 7: 'O', 8: 'ด', 9: 'ด', 10: 'O', 11: 'ด', 12: 'บ', 13: 'O', 14: 'ด', 15: 'บ', 16: 'ด', 17: 'O', 18: 'ช', 19: 'ช', 20: 'ด', 21: 'ด', 22: 'O', 23: 'ด', 24: 'บ', 25: 'ช', 26: 'ช', 27: 'O', 28: 'บ', 29: 'ช', 30: 'O', 31: 'ด' } },
      { name: 'พยาบาล 11', filled: { 1: 'บ', 2: 'O', 3: 'ช', 4: 'ช+บ', 5: 'บ', 6: 'บ', 7: 'ช', 8: 'O', 9: 'O', 10: 'ด', 11: 'ด', 12: 'บ', 13: 'O', 14: 'ช', 15: 'ด', 16: 'บ', 17: 'ด', 18: 'บ', 19: 'O', 20: 'บ', 21: 'ช', 22: 'บ', 23: 'O', 24: 'ช', 25: 'บ', 26: 'O', 27: 'ช', 28: 'ช', 29: 'ด', 30: 'O', 31: 'ช' } },
      { name: 'พยาบาล 12', filled: { 1: 'ช', 2: 'บ', 3: 'O', 4: 'ด', 5: 'ด', 6: 'O', 7: 'ช', 8: 'ด', 9: 'O', 10: 'ด', 11: 'ด', 12: 'บ', 13: 'บ', 14: 'บ', 15: 'O', 16: 'ด', 17: 'บ', 18: 'O', 19: 'ช', 20: 'ช', 21: 'ช', 22: 'O', 23: 'ช', 24: 'ด', 25: 'O', 26: 'ช', 27: 'ช', 28: 'ช', 29: 'O', 30: 'ด', 31: 'ด' } },
      { name: 'พยาบาล 13', filled: { 1: 'ช', 2: 'O', 3: 'ช', 4: 'ด', 5: 'O', 6: 'ด', 7: 'ด', 8: 'บ', 9: 'ช', 10: 'O', 11: 'ช', 12: 'ช', 13: 'ด', 14: 'O', 15: 'ด', 16: 'บ', 17: 'ด', 18: 'O', 19: 'ด', 20: 'บ', 21: 'ด', 22: 'O', 23: 'ช', 24: 'ช', 25: 'ช', 26: 'บ', 27: 'ช', 28: 'O', 29: 'O', 30: 'ด', 31: 'บ' } },
      { name: 'พยาบาล 14', filled: { 1: 'ด', 2: 'O', 3: 'ช', 4: 'ช', 5: 'O', 6: 'ช', 7: 'ช', 8: 'ช', 9: 'บ', 10: 'บ', 11: 'O', 12: 'ช+บ', 13: 'ช', 14: 'ช', 15: 'ช', 16: 'O', 17: 'ช', 18: 'ช', 19: 'O', 20: 'ช', 21: 'ช', 22: 'ช', 23: 'O', 24: 'ช', 25: 'ด', 26: 'O', 27: 'ช', 28: 'ช', 29: 'บ', 30: 'O', 31: 'ช' } },
      { name: 'พยาบาล 15', filled: { 1: 'O', 2: 'ด', 3: 'บ', 4: 'O', 5: 'บ', 6: 'O', 7: 'ช', 8: 'บ', 9: 'บ', 10: 'บ', 11: 'O', 12: 'ด', 13: 'O', 14: 'ด', 15: 'บ', 16: 'ด', 17: 'O', 18: 'ด', 19: 'บ', 20: 'ช', 21: 'ช', 22: 'O', 23: 'ช', 24: 'บ', 25: 'ช', 26: 'บ', 27: 'บ', 28: 'O', 29: 'ช', 30: 'บ', 31: 'บ' } },
      { name: 'พยาบาล 16', filled: { 1: 'O', 2: 'ด', 3: 'บ', 4: 'ช', 5: 'O', 6: 'ด', 7: 'บ', 8: 'ช', 9: 'ด', 10: 'บ', 11: 'O', 12: 'ช', 13: 'บ', 14: 'O', 15: 'ช', 16: 'บ', 17: 'ช', 18: 'ช', 19: 'O', 20: 'ด', 21: 'บ', 22: 'บ', 23: 'O', 24: 'ด', 25: 'บ', 26: 'ช', 27: 'O', 28: 'บ', 29: 'บ', 30: 'บ', 31: 'O' } },
    ],
  };

  initMonthUI();
  S.rules = mergeRules({});
  S.roster = blankRoster(S.month.be, S.month.mn, DEFAULT_ROWS);
  initRuleUI();
  render();
})();
