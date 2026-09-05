'use strict';

/* ============================================================================
   จัดตารางเวรพยาบาล — แท็บตารางเวร
   ตารางคือหน้าจอ: เปิดมาเจอตารางเต็มจอ แก้ด้วยการคลิกในตารางโดยตรง
   ============================================================================ */

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const SHIFTS = {
    M: { label: 'เช้า', short: 'ช', cls: 'shift-morning' },
    A: { label: 'บ่าย', short: 'บ', cls: 'shift-afternoon' },
    N: { label: 'ดึก', short: 'ด', cls: 'shift-night' },
    O: { label: 'ควบ', short: 'ควบ', cls: 'shift-ot' },
    R: { label: 'หยุด', short: 'ห', cls: 'shift-off' },
    V: { label: 'ลา', short: 'ลา', cls: 'shift-leave' },
};

// วนค่าเมื่อคลิก: ว่าง → ช → บ → ด → ควบ → หยุด → ว่าง  (ลา ตั้งผ่านคลิกขวาเท่านั้น)
const CYCLE = [null, 'M', 'A', 'N', 'O', 'R'];

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

const LS_KEY = 'nurseRoster.v2';

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const state = {
    year: 2026,
    month: 8,                 // 0-based → กันยายน 2026 = 2569
    nurses: [],               // { name, position, team, shifts: (code|null)[] }
    locks: new Set(),         // "r-c"
    config: {
        goalM: 4, goalA: 3, goalN: 2,
        quotaDays: 6,
        nightToMorning: 'forbidden',
        consecutiveWorkLimit: 5,
        consecutiveNightLimit: 2,
    },
    history: [],
    histIndex: -1,
    highlightShift: null,
    focused: null,            // { r, c }
    drag: null,               // { r0, c0, r1, c1, value, moved, snapshot }
    scheduling: false,
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const numDays = () => new Date(state.year, state.month + 1, 0).getDate();
const key = (r, c) => r + '-' + c;

function esc(s) {
    return String(s).replace(/[&<>"]/g, (m) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]
    ));
}

function teamColor(team) {
    const map = { 'ทีม A': '#F87171', 'ทีม B': '#34D399', 'ทีม C': '#FBBF24', 'ทีม D': '#60A5FA' };
    return map[team] || '#94A3B8';
}

function getShift(r, c) {
    const n = state.nurses[r];
    return n ? (n.shifts[c] || null) : null;
}

function setShift(r, c, v) {
    const n = state.nurses[r];
    if (!n) return;
    while (n.shifts.length <= c) n.shifts.push(null);
    n.shifts[c] = v;
}

function isLocked(r, c) { return state.locks.has(key(r, c)); }

function toggleLock(r, c) {
    const k = key(r, c);
    if (state.locks.has(k)) state.locks.delete(k);
    else state.locks.add(k);
}

function cycleShift(cur) {
    const i = CYCLE.indexOf(cur);
    return CYCLE[(i + 1) % CYCLE.length];
}

// นับจำนวนคนที่ลงกะ kind ในวัน c — ควบ (O) นับเป็นทั้งเช้าและบ่าย
function dayCount(c, kind) {
    let n = 0;
    for (let r = 0; r < state.nurses.length; r++) {
        const s = getShift(r, c);
        if (s === kind) n++;
        else if (s === 'O' && (kind === 'M' || kind === 'A')) n++;
    }
    return n;
}

function nurseSummary(r) {
    const D = numDays();
    let M = 0, A = 0, N = 0, O = 0, R = 0;
    for (let c = 0; c < D; c++) {
        const s = getShift(r, c);
        if (s === 'M') M++;
        else if (s === 'A') A++;
        else if (s === 'N') N++;
        else if (s === 'O') O++;
        else if (s === 'R') R++;
    }
    return { M, A, N, O, R, work: M + A + N + O };
}

// ---------------------------------------------------------------------------
// PERSISTENCE + HISTORY
// ---------------------------------------------------------------------------

function persist() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            year: state.year, month: state.month,
            nurses: state.nurses, locks: [...state.locks], config: state.config,
        }));
    } catch (e) { /* โหมดส่วนตัว / ปิด storage */ }
}

function loadPersisted() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return false;
        const o = JSON.parse(raw);
        applyDoc(o);
        return true;
    } catch (e) { return false; }
}

function applyDoc(o) {
    if (typeof o.year === 'number') state.year = o.year;
    if (typeof o.month === 'number') state.month = o.month;
    state.nurses = (o.nurses || []).map((n) => ({
        name: n.name || '',
        position: n.position || '',
        team: n.team || '',
        shifts: Array.isArray(n.shifts) ? n.shifts.slice() : [],
    }));
    state.locks = new Set(o.locks || []);
    Object.assign(state.config, o.config || {});
}

function snapshot() {
    return JSON.stringify({
        nurses: state.nurses.map((n) => ({ ...n, shifts: n.shifts.slice() })),
        locks: [...state.locks],
    });
}

function restore(s) {
    const o = JSON.parse(s);
    state.nurses = o.nurses.map((n) => ({
        name: n.name, position: n.position || '', team: n.team || '', shifts: n.shifts.slice(),
    }));
    state.locks = new Set(o.locks || []);
}

function pushHistory() {
    state.history = state.history.slice(0, state.histIndex + 1);
    state.history.push(snapshot());
    state.histIndex++;
    if (state.history.length > 120) {
        state.history.shift();
        state.histIndex--;
    }
    persist();
}

function undo() {
    if (state.histIndex <= 0) return false;
    state.histIndex--;
    restore(state.history[state.histIndex]);
    persist();
    return true;
}

function redo() {
    if (state.histIndex >= state.history.length - 1) return false;
    state.histIndex++;
    restore(state.history[state.histIndex]);
    persist();
    return true;
}

// snapshot เฉพาะกริดกะ (เบา ใช้ระหว่างลาก/จัดตาราง)
function gridSnapshot() { return state.nurses.map((n) => n.shifts.slice()); }
function restoreGrid(g) { state.nurses.forEach((n, i) => { n.shifts = (g[i] || []).slice(); }); }

// ---------------------------------------------------------------------------
// VIOLATIONS
// ---------------------------------------------------------------------------

function computeViolations() {
    const map = new Map(); // "r-c" → [message]
    const add = (r, c, msg) => {
        const k = key(r, c);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(msg);
    };
    const D = numDays();
    const cfg = state.config;

    for (let r = 0; r < state.nurses.length; r++) {
        // ดึก → เช้า
        if (cfg.nightToMorning === 'forbidden') {
            for (let c = 0; c < D - 1; c++) {
                const next = getShift(r, c + 1);
                if (getShift(r, c) === 'N' && (next === 'M' || next === 'O')) {
                    add(r, c + 1, `ลงดึกวันที่ ${c + 1} แล้วขึ้นเช้าวันที่ ${c + 2}`);
                }
            }
        }

        // ทำงานติดต่อกันเกินกำหนด
        let run = [];
        const flushWork = () => {
            if (run.length > cfg.consecutiveWorkLimit) {
                for (let i = cfg.consecutiveWorkLimit; i < run.length; i++) {
                    add(r, run[i], `ทำงานติดต่อกัน ${run.length} วัน (เกิน ${cfg.consecutiveWorkLimit})`);
                }
            }
            run = [];
        };
        for (let c = 0; c < D; c++) {
            const s = getShift(r, c);
            if (s && s !== 'R' && s !== 'V') run.push(c);
            else flushWork();
        }
        flushWork();

        // ขึ้นดึกติดกันเกินกำหนด
        let nrun = [];
        const flushNight = () => {
            if (nrun.length > cfg.consecutiveNightLimit) {
                for (let i = cfg.consecutiveNightLimit; i < nrun.length; i++) {
                    add(r, nrun[i], `ขึ้นดึกติดกัน ${nrun.length} คืน (เกิน ${cfg.consecutiveNightLimit})`);
                }
            }
            nrun = [];
        };
        for (let c = 0; c < D; c++) {
            if (getShift(r, c) === 'N') nrun.push(c);
            else flushNight();
        }
        flushNight();
    }
    return map;
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

function updateMonthTitle() {
    $('monthTitle').textContent = `${THAI_MONTHS[state.month]} ${state.year + 543}`;
}

function render() {
    updateMonthTitle();
    const D = numDays();
    const head = $('tableHead');
    const bodyEl = $('tableBody');
    const foot = $('tableFoot');

    if (state.nurses.length === 0) {
        head.innerHTML = '';
        foot.innerHTML = '';
        bodyEl.innerHTML = `<tr><td class="empty-cell" colspan="${D + 2}">
            <div class="empty-state">
                <div class="empty-state-text">ยังไม่มีพนักงาน — เริ่มด้วยการเพิ่มคน หรือโหลดตัวอย่าง</div>
                <div class="empty-state-buttons">
                    <button class="btn btn-primary" data-empty="add">เพิ่มพนักงาน</button>
                    <button class="btn btn-outline" data-empty="sample">โหลดข้อมูลตัวอย่าง</button>
                </div>
            </div></td></tr>`;
        return;
    }

    const today = new Date();
    const curMonth = today.getFullYear() === state.year && today.getMonth() === state.month;
    const viol = computeViolations();
    const filt = state.highlightShift;

    // ----- header -----
    let h = '<tr><th class="col-name">ชื่อ</th>';
    for (let c = 0; c < D; c++) {
        const dow = new Date(state.year, state.month, c + 1).getDay();
        const wknd = dow === 0 || dow === 6;
        const isToday = curMonth && today.getDate() === c + 1;
        h += `<th class="day-col${wknd ? ' wknd' : ''}${isToday ? ' today' : ''}">`
            + `<div class="dh-num">${c + 1}</div><div class="dh-dow">${THAI_DOW[dow]}</div></th>`;
    }
    h += '<th class="col-sum">สรุป</th></tr>';
    head.innerHTML = h;

    // ----- body -----
    let b = '';
    for (let r = 0; r < state.nurses.length; r++) {
        const n = state.nurses[r];
        const secondary = [n.position, n.team].filter(Boolean).join(' · ');
        b += '<tr>';
        b += `<td class="col-name">`
            + `<span class="team-bar" style="background:${teamColor(n.team)}"></span>`
            + `<span class="nm-primary">${esc(n.name)}</span>`
            + `<span class="nm-secondary">${esc(secondary)}</span></td>`;

        for (let c = 0; c < D; c++) {
            const s = getShift(r, c);
            const dow = new Date(state.year, state.month, c + 1).getDay();
            const wknd = dow === 0 || dow === 6;
            const locked = isLocked(r, c);
            const bad = viol.get(key(r, c));
            const focused = state.focused && state.focused.r === r && state.focused.c === c;

            let cls = 'shift-cell';
            if (wknd) cls += ' wknd';
            if (locked) cls += ' locked';
            if (bad) cls += ' invalid';
            if (focused) cls += ' focused';
            if (filt) {
                if (s === filt) cls += ' hl';
                else if (s) cls += ' dim';
            }

            const title = bad ? ` title="${esc(bad.join(' · '))}"` : '';
            const chip = s
                ? `<span class="chip ${SHIFTS[s].cls}">${SHIFTS[s].label}</span>`
                : '<span class="chip chip-empty"></span>';
            const lock = locked ? '<span class="lock-ico" aria-hidden="true">🔒</span>' : '';
            b += `<td class="${cls}" data-r="${r}" data-c="${c}"${title}>${chip}${lock}</td>`;
        }

        const sum = nurseSummary(r);
        b += `<td class="col-sum"><div class="sum-grid">`
            + `<span>ทำงาน ${sum.work}</span><span>ช ${sum.M}</span><span>บ ${sum.A}</span>`
            + `<span>ด ${sum.N}</span><span>OT ${sum.O}</span><span>หยุด ${sum.R}</span></div></td>`;
        b += '</tr>';
    }
    bodyEl.innerHTML = b;

    // ----- footer totals -----
    const rows = [
        ['ช', 'M', state.config.goalM],
        ['บ', 'A', state.config.goalA],
        ['ด', 'N', state.config.goalN],
    ];
    let f = '';
    for (const [lbl, kind, goal] of rows) {
        f += `<tr><td class="col-name">รวม ${lbl}</td>`;
        for (let c = 0; c < D; c++) {
            const v = dayCount(c, kind);
            f += `<td class="tot${v < goal ? ' below' : ''}">${v}</td>`;
        }
        f += '<td class="col-sum"></td></tr>';
    }
    foot.innerHTML = f;
}

// ---------------------------------------------------------------------------
// CELL INTERACTION (คลิก / ลาก / คลิกขวา / คีย์บอร์ด)
// ---------------------------------------------------------------------------

function cellFrom(e) {
    const td = e.target.closest('td.shift-cell');
    if (!td) return null;
    return { r: +td.dataset.r, c: +td.dataset.c };
}

function onCellMouseDown(e) {
    if (e.button !== 0) return;               // ปล่อยคลิกขวาให้ contextmenu
    const cell = cellFrom(e);
    if (!cell) return;
    e.preventDefault();
    state.focused = { r: cell.r, c: cell.c };

    if (e.shiftKey) {                          // Shift+คลิก = ล็อก/ปลดล็อก
        toggleLock(cell.r, cell.c);
        pushHistory();
        render();
        return;
    }
    if (isLocked(cell.r, cell.c)) { render(); return; }

    const value = cycleShift(getShift(cell.r, cell.c));
    state.drag = {
        r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c,
        value, moved: false, snapshot: gridSnapshot(),
    };
    setShift(cell.r, cell.c, value);
    render();
}

function onCellMouseOver(e) {
    if (!state.drag) return;
    const cell = cellFrom(e);
    if (!cell) return;
    const d = state.drag;
    if (cell.r === d.r1 && cell.c === d.c1) return;
    d.r1 = cell.r;
    d.c1 = cell.c;
    d.moved = true;
    applyDragRect();
    render();
}

function applyDragRect() {
    const d = state.drag;
    restoreGrid(d.snapshot);
    const r0 = Math.min(d.r0, d.r1), r1 = Math.max(d.r0, d.r1);
    const c0 = Math.min(d.c0, d.c1), c1 = Math.max(d.c0, d.c1);
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            if (!isLocked(r, c)) setShift(r, c, d.value);
        }
    }
}

function onDocMouseUp() {
    if (!state.drag) return;
    state.drag = null;
    pushHistory();
    render();
}

function onCellContextMenu(e) {
    const cell = cellFrom(e);
    if (!cell) return;
    e.preventDefault();
    const { r, c } = cell;
    state.focused = { r, c };

    const items = [];
    for (const [code, s] of Object.entries(SHIFTS)) {
        items.push({ label: s.label, fn: () => { setShift(r, c, code); pushHistory(); render(); } });
    }
    items.push({ label: 'ว่าง', fn: () => { setShift(r, c, null); pushHistory(); render(); } });
    items.push({ sep: true });
    items.push({
        label: isLocked(r, c) ? 'ปลดล็อกช่อง' : 'ล็อกช่อง',
        fn: () => { toggleLock(r, c); pushHistory(); render(); },
    });
    showContextMenu(e.clientX, e.clientY, items);
    render();
}

function showContextMenu(x, y, items) {
    const m = $('contextMenu');
    m.innerHTML = '';
    for (const it of items) {
        if (it.sep) {
            const d = document.createElement('div');
            d.className = 'cm-sep';
            m.appendChild(d);
            continue;
        }
        const btn = document.createElement('button');
        btn.textContent = it.label;
        btn.addEventListener('click', () => { hideContextMenu(); it.fn(); });
        m.appendChild(btn);
    }
    m.hidden = false;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
    m.style.top = Math.min(y, window.innerHeight - mh - 4) + 'px';
}

function hideContextMenu() { $('contextMenu').hidden = true; }

function onBodyClick(e) {
    const eb = e.target.closest('[data-empty]');
    if (!eb) return;
    if (eb.dataset.empty === 'sample') loadSample();
    else addNursePrompt();
}

// ----- keyboard -----
function onKeyDown(e) {
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (undo()) render(); return; }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); if (redo()) render(); return; }
    if (e.key === 'Escape') { hideContextMenu(); closeFeas(); return; }

    if (state.nurses.length === 0) return;
    const D = numDays();

    if (!state.focused) {
        if (e.key.startsWith('Arrow')) { state.focused = { r: 0, c: 0 }; render(); e.preventDefault(); }
        return;
    }
    let { r, c } = state.focused;

    switch (e.key) {
        case 'ArrowRight': c = Math.min(D - 1, c + 1); break;
        case 'ArrowLeft': c = Math.max(0, c - 1); break;
        case 'ArrowDown': r = Math.min(state.nurses.length - 1, r + 1); break;
        case 'ArrowUp': r = Math.max(0, r - 1); break;
        case ' ':
        case 'Spacebar':
            e.preventDefault();
            if (!isLocked(r, c)) { setShift(r, c, cycleShift(getShift(r, c))); pushHistory(); render(); }
            return;
        case 'Delete':
        case 'Backspace':
            if (!isLocked(r, c)) { setShift(r, c, null); pushHistory(); render(); }
            return;
        case 'l': case 'L':
            toggleLock(r, c); pushHistory(); render();
            return;
        default:
            return;
    }
    e.preventDefault();
    state.focused = { r, c };
    render();
    scrollCellIntoView(r, c);
}

function scrollCellIntoView(r, c) {
    const td = $('tableBody').querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function scrollDayIntoView(c) {
    const th = $('tableHead').querySelector(`.day-col:nth-child(${c + 2})`);
    if (th) th.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// SYMBOL BAR — คลิกชิปเพื่อไฮไลต์กะนั้นทั้งตาราง
// ---------------------------------------------------------------------------

function onSymbolClick(e) {
    const chip = e.target.closest('.shift-chip');
    if (!chip) return;
    const s = chip.dataset.shift;
    state.highlightShift = state.highlightShift === s ? null : s;
    document.querySelectorAll('#symbolBar .shift-chip').forEach((ch) =>
        ch.classList.toggle('active', ch.dataset.shift === state.highlightShift));
    render();
}

// ---------------------------------------------------------------------------
// MONTH NAV
// ---------------------------------------------------------------------------

function changeMonth(delta) {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    state.focused = null;
    persist();
    render();
}

// ---------------------------------------------------------------------------
// FEASIBILITY
// ---------------------------------------------------------------------------

function checkFeasibility() {
    const D = numDays();
    const cfg = state.config;
    const nP = state.nurses.length;
    const totalShiftsNeeded = (cfg.goalM + cfg.goalA + cfg.goalN) * D;

    let workDays = 0;
    for (let r = 0; r < nP; r++) {
        for (let c = 0; c < D; c++) {
            const s = getShift(r, c);
            if (s !== 'R' && s !== 'V') workDays++;
        }
    }
    const doubles = totalShiftsNeeded - workDays;

    const risky = [];
    for (let c = 0; c < D; c++) {
        let off = 0;
        for (let r = 0; r < nP; r++) {
            const s = getShift(r, c);
            if (s === 'R' || s === 'V') off++;
        }
        const avail = nP - off;
        if (avail < cfg.goalM + cfg.goalA + cfg.goalN) risky.push({ day: c, off, avail });
    }

    const viol = computeViolations();
    let nm = 0, cw = 0, cn = 0;
    for (const msgs of viol.values()) {
        for (const m of msgs) {
            if (m.includes('ขึ้นเช้า')) nm++;
            else if (m.includes('ทำงานติดต่อกัน')) cw++;
            else if (m.includes('ขึ้นดึกติดกัน')) cn++;
        }
    }
    const conflicts = [];
    if (nm) conflicts.push({ text: `ดึกต่อเช้า ${nm} จุด`, relax: () => { cfg.nightToMorning = 'allowed'; } });
    if (cw) conflicts.push({ text: `ทำงานติดกันเกินกำหนด ${cw} จุด`, relax: () => { cfg.consecutiveWorkLimit++; } });
    if (cn) conflicts.push({ text: `ขึ้นดึกติดกันเกินกำหนด ${cn} จุด`, relax: () => { cfg.consecutiveNightLimit++; } });
    for (let r = 0; r < nP; r++) {
        let rc = 0;
        for (let c = 0; c < D; c++) if (getShift(r, c) === 'R') rc++;
        if (rc > cfg.quotaDays) {
            conflicts.push({ text: `${state.nurses[r].name} หยุด ${rc} วัน (เกินโควตา ${cfg.quotaDays})`, relax: null });
        }
    }

    return { totalShiftsNeeded, workDays, doubles, risky, conflicts };
}

function openFeas() {
    const f = checkFeasibility();
    const el = $('feasBody');
    el.innerHTML = `
        <div class="feas-box">
            <div class="fb-title">ตัวเลขหลัก</div>
            <div class="fb-big"><b>${f.totalShiftsNeeded}</b><span>เวรที่ต้องเติม</span></div>
            <div class="fb-big"><b>${f.workDays}</b><span>วันทำงานที่มีจริง</span></div>
            <div class="fb-big"><b class="${f.doubles > 0 ? 'warn' : ''}">${f.doubles}</b><span>ต้องควบ (ครั้ง)</span></div>
        </div>
        <div class="feas-box">
            <div class="fb-title">วันที่ต้องระวัง</div>
            ${f.risky.length
                ? f.risky.map((d) => `<button class="fb-day" data-day="${d.day}">วันที่ ${d.day + 1} · หยุด ${d.off} · เหลือทำงาน ${d.avail}</button>`).join('')
                : '<div class="fb-none">คนพอทุกวัน</div>'}
        </div>
        <div class="feas-box">
            <div class="fb-title">กฎที่ขัดกัน</div>
            ${f.conflicts.length
                ? f.conflicts.map((c, i) => `<div class="fb-conf"><span>${esc(c.text)}</span>${c.relax ? `<button data-relax="${i}">ผ่อนกฎ</button>` : ''}</div>`).join('')
                : '<div class="fb-none">ผ่านทุกข้อ</div>'}
        </div>`;

    el.querySelectorAll('.fb-day').forEach((btn) =>
        btn.addEventListener('click', () => scrollDayIntoView(+btn.dataset.day)));
    el.querySelectorAll('[data-relax]').forEach((btn) =>
        btn.addEventListener('click', () => {
            f.conflicts[+btn.dataset.relax].relax();
            persist();
            render();
            openFeas();
        }));

    $('feasPanel').classList.add('open');
}

function closeFeas() { $('feasPanel').classList.remove('open'); }

// ---------------------------------------------------------------------------
// AUTO-SCHEDULE (simulated annealing เบา ๆ — ไม่แตะช่องที่ล็อกและช่องลา)
// ---------------------------------------------------------------------------

function penalty(actual, goal) {
    return actual < goal ? (goal - actual) * 5 : (actual - goal) * 2;
}

function score() {
    const D = numDays();
    const cfg = state.config;
    let s = 0;
    for (let c = 0; c < D; c++) {
        s += penalty(dayCount(c, 'M'), cfg.goalM);
        s += penalty(dayCount(c, 'A'), cfg.goalA);
        s += penalty(dayCount(c, 'N'), cfg.goalN);
    }
    const viol = computeViolations();
    for (const msgs of viol.values()) s += msgs.length * 8;

    const works = state.nurses.map((_, r) => nurseSummary(r).work);
    const avg = works.reduce((a, b) => a + b, 0) / (works.length || 1);
    for (const w of works) s += Math.abs(w - avg) * 0.5;
    return s;
}

function schedulableCells() {
    const D = numDays();
    const out = [];
    for (let r = 0; r < state.nurses.length; r++) {
        for (let c = 0; c < D; c++) {
            if (!isLocked(r, c) && getShift(r, c) !== 'V') out.push([r, c]);
        }
    }
    return out;
}

function startScheduling() {
    if (state.nurses.length === 0) { toast('ยังไม่มีพนักงาน'); return; }
    state.scheduling = true;
    $('autoScheduleBtn').disabled = true;
    $('schedOverlay').classList.add('open');

    const cells = schedulableCells();
    const opts = [null, 'M', 'A', 'N', 'O', 'R'];
    const maxRounds = 6000;
    let best = score();
    let bestGrid = gridSnapshot();
    let round = 0;

    function step() {
        if (!state.scheduling || round >= maxRounds) return finishScheduling(bestGrid);

        for (let i = 0; i < 250 && round < maxRounds; i++, round++) {
            const [r, c] = cells[(Math.random() * cells.length) | 0];
            const prev = getShift(r, c);
            const next = opts[(Math.random() * opts.length) | 0];
            if (next === prev) continue;

            setShift(r, c, next);
            const sc = score();
            const T = Math.max(0.5, 8 * (1 - round / maxRounds));
            const accept = sc <= best || Math.random() < Math.exp((best - sc) / T) * 0.15;
            if (accept) {
                if (sc < best) { best = sc; bestGrid = gridSnapshot(); }
            } else {
                setShift(r, c, prev);
            }
        }

        $('schedScore').textContent = best.toFixed(0);
        $('schedRound').textContent = round;
        render();
        requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function finishScheduling(grid) {
    state.scheduling = false;
    restoreGrid(grid);
    $('schedOverlay').classList.remove('open');
    $('autoScheduleBtn').disabled = false;
    pushHistory();
    render();

    const viol = computeViolations();
    let count = 0;
    for (const msgs of viol.values()) count += msgs.length;
    if (count === 0) toast('จัดเสร็จ ผ่านทุกเงื่อนไข');
    else toast(`จัดเสร็จ มีการละเมิด ${count} จุด`, openFeas);
}

// ---------------------------------------------------------------------------
// TOAST
// ---------------------------------------------------------------------------

function toast(msg, onDetail) {
    const wrap = $('toastWrap');
    const t = document.createElement('div');
    t.className = 'toast';
    t.appendChild(document.createTextNode(msg));
    if (onDetail) {
        const btn = document.createElement('button');
        btn.textContent = 'ดูรายละเอียด';
        btn.addEventListener('click', () => { onDetail(); t.remove(); });
        t.appendChild(btn);
    }
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 6000);
}

// ---------------------------------------------------------------------------
// MENU ACTIONS
// ---------------------------------------------------------------------------

function doMenuAction(action) {
    switch (action) {
        case 'save': saveFile(); break;
        case 'open': $('fileInput').click(); break;
        case 'import': importText(); break;
        case 'export-csv': exportCSV(); break;
        case 'print': window.print(); break;
        case 'sample': loadSample(); break;
        case 'clear':
            if (confirm('ล้างข้อมูลพนักงานและตารางทั้งหมด?')) {
                state.nurses = [];
                state.locks.clear();
                state.focused = null;
                pushHistory();
                render();
            }
            break;
    }
}

function csvCell(s) {
    s = String(s == null ? '' : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
    if (state.nurses.length === 0) { toast('ยังไม่มีข้อมูล'); return; }
    const D = numDays();
    const header = ['ชื่อ', 'ตำแหน่ง', 'ทีม'];
    for (let i = 1; i <= D; i++) header.push(String(i));
    const lines = [header.join(',')];
    for (const n of state.nurses) {
        const row = [csvCell(n.name), csvCell(n.position), csvCell(n.team)];
        for (let c = 0; c < D; c++) row.push(n.shifts[c] || '');
        lines.push(row.join(','));
    }
    download(`roster-${state.year + 543}-${String(state.month + 1).padStart(2, '0')}.csv`,
        '﻿' + lines.join('\r\n'), 'text/csv');
}

function saveFile() {
    download(`roster-${state.year + 543}-${String(state.month + 1).padStart(2, '0')}.json`,
        JSON.stringify({
            year: state.year, month: state.month,
            nurses: state.nurses, locks: [...state.locks], config: state.config,
        }, null, 2),
        'application/json');
}

function onFileOpen(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            applyDoc(JSON.parse(reader.result));
            state.focused = null;
            pushHistory();
            render();
            toast('เปิดงานแล้ว');
        } catch (err) {
            toast('ไฟล์ไม่ถูกต้อง');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
}

function normalizeShift(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (['ช', 'c', 'm'].includes(s)) return 'M';
    if (['บ', 'b', 'a'].includes(s)) return 'A';
    if (['ด', 'd', 'n'].includes(s)) return 'N';
    if (['o', 'ควบ'].includes(s)) return 'O';
    if (['r', 'หยุด', 'ห'].includes(s)) return 'R';
    if (['v', 'ลา'].includes(s)) return 'V';
    return null;
}

function importText() {
    const text = prompt('วางข้อมูลข้อความ\nรูปแบบ: บรรทัดชื่อ "1.ชื่อ" ตามด้วยบรรทัดกะคั่นด้วย /\nเช่น  บ/x/x/ช/ด/r/...');
    if (!text) return;
    const D = numDays();
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const nurses = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^\d+[.\s)]+(.+)$/);
        if (m && i + 1 < lines.length) {
            nurses.push({
                name: m[1].trim(),
                position: 'พยาบาลวิชาชีพ',
                team: '',
                shifts: lines[i + 1].split('/').map(normalizeShift).slice(0, D),
            });
            i += 2;
        } else {
            i += 1;
        }
    }
    if (!nurses.length) { toast('ไม่พบข้อมูลที่อ่านได้'); return; }
    state.nurses = nurses;
    state.locks.clear();
    state.focused = null;
    pushHistory();
    render();
    toast(`นำเข้า ${nurses.length} คน`);
}

// ---------------------------------------------------------------------------
// EMPTY-STATE / SAMPLE
// ---------------------------------------------------------------------------

function addNursePrompt() {
    const name = prompt('ชื่อพนักงาน');
    if (!name) return;
    state.nurses.push({ name: name.trim(), position: 'พยาบาลวิชาชีพ', team: '', shifts: [] });
    pushHistory();
    render();
}

function loadSample() {
    const names = ['สมหญิง ใจดี', 'นวลวรรณ ศรีสุข', 'พิมพ์ใจ มานะ', 'สมบูรณ์ ตั้งมั่น',
        'ธนพร แก้วงาม', 'สาครวรรณ ทองคำ', 'ปราณี ชลธาร', 'อุษา พงษ์ไพร', 'ศรีสมร บุญมาก'];
    const teams = ['ทีม A', 'ทีม B', 'ทีม C'];
    const D = numDays();
    state.nurses = names.map((name, i) => {
        const shifts = [];
        for (let c = 0; c < D; c++) {
            const rnd = Math.random();
            if (rnd < 0.11) shifts.push('R');
            else if (rnd < 0.15) shifts.push('V');
            else if (rnd < 0.34) shifts.push(['M', 'A', 'N'][(Math.random() * 3) | 0]);
            else shifts.push(null);
        }
        return { name, position: 'พยาบาลวิชาชีพ', team: teams[i % 3], shifts };
    });
    state.locks.clear();
    state.focused = null;
    pushHistory();
    render();
    toast(`โหลดตัวอย่าง ${names.length} คน`);
}

// ---------------------------------------------------------------------------
// WIRING
// ---------------------------------------------------------------------------

function setupTabs() {
    document.querySelectorAll('.tab-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-button').forEach((b) => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.tab-content').forEach((tc) =>
                tc.classList.toggle('active', tc.id === btn.dataset.tab));
        });
    });
}

function setupMenu() {
    const menuBtn = $('menuBtn');
    const menu = $('mainMenu');
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu-wrap')) menu.hidden = true;
    });
    menu.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-action]');
        if (!b) return;
        menu.hidden = true;
        doMenuAction(b.dataset.action);
    });
}

function init() {
    loadPersisted();
    render();
    pushHistory();                       // baseline สำหรับ undo

    setupTabs();
    setupMenu();

    $('prevMonth').addEventListener('click', () => changeMonth(-1));
    $('nextMonth').addEventListener('click', () => changeMonth(1));
    $('preCheckBtn').addEventListener('click', openFeas);
    $('autoScheduleBtn').addEventListener('click', startScheduling);
    $('feasClose').addEventListener('click', closeFeas);
    $('schedStop').addEventListener('click', () => { state.scheduling = false; });
    $('fileInput').addEventListener('change', onFileOpen);
    $('symbolBar').addEventListener('click', onSymbolClick);

    const body = $('tableBody');
    body.addEventListener('mousedown', onCellMouseDown);
    body.addEventListener('mouseover', onCellMouseOver);
    body.addEventListener('contextmenu', onCellContextMenu);
    body.addEventListener('click', onBodyClick);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#contextMenu')) hideContextMenu();
    });
    $('tableViewport').addEventListener('scroll', hideContextMenu);
}

document.addEventListener('DOMContentLoaded', init);
