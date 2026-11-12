/* ==========================================================================
   Timesheet Log – loads after app.js and reuses its helpers
   (db, auth, guard, say, esc, iso, fmt, normEmp, byName, ACTIONS, INIT …)
   ========================================================================== */

Object.assign(EXPECTED_PAGE, {
  'home.html': 'home',
  'timesheet.html': 'ts-entry',
  'timesheet-admin.html': 'ts-admin',
  'timesheet-people.html': 'ts-people'
});

Object.assign(INIT, { home: initHome, 'ts-entry': initTsEntry, 'ts-admin': initTsAdmin, 'ts-people': initTsPeople });

Object.assign(ACTIONS, {
  'ts-prev': () => tsShiftWeek(-1),
  'ts-next': () => tsShiftWeek(1),
  'ts-now': () => tsGoWeek(mondayOf(iso(new Date()))),
  'ts-add': el => tsAddJob(el.dataset.day),
  'ts-del': el => tsDelJob(el.dataset.day, Number(el.dataset.j)),
  'ts-submit': tsSubmit,
  'ts-open': el => tsOpenReview(el.dataset.uid),
  'ts-back': tsBackToList,
  'ts-approve-all': tsApproveAll,
  'ts-reopen': tsReopen,
  'ts-save-options': tsSaveOptions,
  'ts-all-on': () => tsSetAll(true),
  'ts-all-off': () => tsSetAll(false)
});

/* ---------- dates and tax-year weeks ---------- */

const DAY_MS = 864e5;
const parseDate = s => new Date(s + 'T12:00:00');
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
const mondayOf = s => addDays(s, -((parseDate(s).getDay() + 6) % 7));
const weekDates = ws => [0, 1, 2, 3, 4, 5, 6].map(n => addDays(ws, n));
const dayName = s => parseDate(s).toLocaleDateString('en-GB', { weekday: 'long' });
const shortDate = s => parseDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Week 1 of a tax year is the Monday-to-Sunday week that contains 1 April
// (an admin can override the start date for any tax year on the review page).
function week1Start(taxYear, ts) {
  const override = ts && ts.week1 && ts.week1[taxYear];
  return override || mondayOf(`${taxYear}-04-01`);
}

function weekInfo(weekStart, ts) {
  const y = Number(weekStart.slice(0, 4));
  const taxYear = weekStart >= week1Start(y, ts) ? y : y - 1;
  const weekNo = Math.round((parseDate(weekStart) - parseDate(week1Start(taxYear, ts))) / (7 * DAY_MS)) + 1;
  return { taxYear, weekNo, label: `${taxYear}/${String(taxYear + 1).slice(2)}` };
}

/* ---------- timesheet settings (drop-down options) ---------- */

const TS_DEFAULT_ASSIGNERS = ['Dan Varley', 'Darren Wilkinson', 'Dave Leigh', 'Chris Smith', 'Jack Craven'];

let _tsSettings = null;
async function getTsSettings(force) {
  if (_tsSettings && !force) return _tsSettings;
  let d = {};
  try {
    const snap = await db.doc('settings/timesheet').get();
    if (snap.exists) d = snap.data();
  } catch (err) { reportError(err, 'Could not load the timesheet settings (using the defaults)'); }
  _tsSettings = {
    assignedBy: Array.isArray(d.assignedBy) ? d.assignedBy : TS_DEFAULT_ASSIGNERS,
    vanRegs: Array.isArray(d.vanRegs) ? d.vanRegs : [],
    week1: d.week1 || {}
  };
  return _tsSettings;
}

/* ---------- the timesheet model ---------- */

const blankJob = () => ({ jobNo: '', customer: '', from: '', to: '', assignedBy: '', assignedOther: '', callOut: false, noDinner: false, approved: false });

function normDays(raw, ws) {
  const days = {};
  weekDates(ws).forEach(d => {
    const r = (raw && raw[d]) || {};
    days[d] = {
      vanReg: r.vanReg || '',
      comments: r.comments || '',
      jobs: Array.isArray(r.jobs) && r.jobs.length ? r.jobs.map(j => ({ ...blankJob(), ...j })) : [blankJob()]
    };
  });
  return days;
}

const jobHasData = j => !!(j.jobNo || j.customer || j.from || j.to || j.assignedBy || j.callOut || j.noDinner);
const dayHasData = d => !!(d.vanReg || d.comments) || d.jobs.some(jobHasData);
const sheetHasJobs = days => Object.values(days).some(d => d.jobs.some(jobHasData));
const sheetHasAnything = days => Object.values(days).some(dayHasData);

const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Hours for one job: To minus From, in hours (15 min = 0.25, 30 = 0.5, 45 = 0.75). Past midnight counts as the next day.
function jobHours(j) {
  const a = toMin(j.from), b = toMin(j.to);
  if (a === null || b === null) return 0;
  let diff = b - a;
  if (diff < 0) diff += 1440;
  return diff / 60;
}
const fmtH = h => String(Math.round(h * 100) / 100);
const dayHours = d => sum(d.jobs, jobHours);
const sheetHours = days => sum(Object.values(days), dayHours);
const assignerName = j => (j.assignedBy === 'Other' ? j.assignedOther : j.assignedBy) || '';

const TS_STATUS = {
  none: ['Not completed', 'none'],
  partial: ['Partially complete', 'partial'],
  filled: ['Filled in', 'filled'],
  in_review: ['In review', 'in_review'],
  approved: ['Approved', 'approved']
};

function sheetState(sheet) {
  if (!sheet || !sheetHasJobs(normDays(sheet.days, sheet.weekStart))) return 'none';
  if (sheet.status === 'approved') return 'approved';
  if (sheet.status === 'in_review') return 'in_review';
  if (sheet.status === 'submitted') return 'filled';
  return 'partial';
}

const statusPill = key => `<span class="pill ${TS_STATUS[key][1]}">${TS_STATUS[key][0]}</span>`;

// Shared week navigation (employee entry page and admin review page)
const WK = { weekStart: mondayOf(iso(new Date())), onWeek: null };
function tsGoWeek(ws) { WK.weekStart = ws; if (WK.onWeek) WK.onWeek(); }
function tsShiftWeek(n) { tsGoWeek(addDays(WK.weekStart, 7 * n)); }

/* ==========================================================================
   Home page: choose Holiday Tracker or Timesheet Log
   ========================================================================== */

async function initHome() {
  const s = await guard();
  if (!s) return;
  const admin = s.p.role === 'admin';
  const timesheetAllowed = admin || !!(s.emp && s.emp.timesheetRequired);
  $('hello').textContent = 'Hello, ' + ((s.emp && s.emp.displayName) || s.p.displayName || '');

  const tile = (href, title, text, enabled, disabledText) => enabled
    ? `<a class="project" href="${href}"><h2>${title}</h2><p>${text}</p></a>`
    : `<div class="project disabled" aria-disabled="true"><h2>${title}</h2><p>${disabledText}</p></div>`;

  $('projects').innerHTML =
    tile(admin ? 'admin.html' : 'employee.html', 'Holiday Tracker',
      admin ? 'Approve holiday requests, manage employees and allowances.' : 'Request leave, check your allowance and see who is off.', true, '') +
    tile(admin ? 'timesheet-admin.html' : 'timesheet.html', 'Timesheet Log',
      admin ? 'See who has filled in their timesheet, approve jobs and manage the drop-down lists.' : 'Fill in your jobs and hours for the week.',
      timesheetAllowed, 'You are not expected to fill in a timesheet.');
}

/* ==========================================================================
   Employee: weekly timesheet with automatic saving
   ========================================================================== */

let ENT = null;

async function initTsEntry() {
  const s = await guard();
  if (!s) return;
  if (s.p.role !== 'admin' && !(s.emp && s.emp.timesheetRequired)) { location.href = 'home.html'; return; }
  if (!s.emp) { say('note', 'Your employee record is not linked yet. Ask an administrator.', 'error'); return; }

  ENT = { s, emp: s.emp, ts: await getTsSettings(), dirty: false, queue: Promise.resolve(), timer: null };
  WK.onWeek = loadEntryWeek;
  $('days').addEventListener('input', onSheetInput);
  $('days').addEventListener('change', onSheetChange);
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
  await loadEntryWeek();
}

async function loadEntryWeek() {
  await flushSave();
  const ws = WK.weekStart;
  const uid = ENT.s.user.uid;
  ENT.weekStart = ws;
  ENT.info = weekInfo(ws, ENT.ts);
  ENT.docId = `${uid}_${ws}`;

  let data = {};
  try {
    const snap = await db.collection('timesheets').where('userId', '==', uid).where('weekStart', '==', ws).get();
    ENT.exists = !snap.empty;
    if (!snap.empty) data = snap.docs[0].data();
  } catch (err) { reportError(err, 'Could not load your timesheet'); ENT.exists = false; }
  ENT.days = normDays(data.days, ws);
  ENT.status = data.status || 'draft';
  renderEntry();
}

function vanRegControl(day, locked) {
  const regs = ENT.ts.vanRegs;
  const dis = locked ? ' disabled' : '';
  if (!regs.length) return `<input class="cell" data-f="vanReg" value="${esc(day.vanReg)}" placeholder="Van reg" aria-label="Van reg"${dis}>`;
  const options = regs.includes(day.vanReg) || !day.vanReg ? regs : [...regs, day.vanReg];
  return `<select class="cell" data-f="vanReg" aria-label="Van reg"${dis}><option value="">Select…</option>${options.map(r => `<option${r === day.vanReg ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
}

function timeBox(label, field, value, dis) {
  const [h, m] = value ? value.split(':') : ['', ''];
  return `<div class="tbox"><span class="tlabel">${label}</span><span class="t">
      <input type="number" class="th" data-f="${field}" data-part="h" min="-1" max="24" step="1" placeholder="HH" value="${h}" aria-label="${label} hour"${dis}>
      <span>:</span>
      <input type="number" class="tm" data-f="${field}" data-part="m" min="-15" max="60" step="15" placeholder="MM" value="${m}" aria-label="${label} minutes"${dis}>
    </span></div>`;
}

function assignedControl(job, dis) {
  const names = ENT.ts.assignedBy;
  const known = names.includes(job.assignedBy) || job.assignedBy === 'Other' || !job.assignedBy;
  const options = known ? names : [...names, job.assignedBy];
  return `<select class="cell" data-f="assignedBy" aria-label="Assigned by"${dis}>
      <option value="">Select…</option>
      ${options.map(n => `<option${n === job.assignedBy ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      <option value="Other"${job.assignedBy === 'Other' ? ' selected' : ''}>Other</option>
    </select>
    ${job.assignedBy === 'Other' ? `<input class="cell other" data-f="assignedOther" value="${esc(job.assignedOther)}" placeholder="Type a name" aria-label="Other name"${dis}>` : ''}`;
}

function entryRows(date, day, locked) {
  const n = day.jobs.length;
  const dis = locked ? ' disabled' : '';
  return day.jobs.map((j, i) => {
    const last = i === n - 1;
    const dateCell = i === 0
      ? `<td class="daycell" rowspan="${n}"><b>${dayName(date)}</b><br>${shortDate(date)}<br><small class="muted" data-dayhours="${date}"></small></td>` : '';
    const dayCells = i === 0
      ? `<td rowspan="${n}">${vanRegControl(day, locked)}</td>
         <td rowspan="${n}"><textarea class="cell" rows="2" data-f="comments" aria-label="Extra comments"${dis}>${esc(day.comments)}</textarea></td>` : '';
    const controls = locked ? '' : `${last ? `<button type="button" class="small ghost plus" data-action="ts-add" data-day="${date}" aria-label="Add another job on ${dayName(date)}">+</button>` : ''}${i > 0 ? `<button type="button" class="small ghost del" data-action="ts-del" data-day="${date}" data-j="${i}" aria-label="Remove this job">×</button>` : ''}`;
    return `
      <tr class="${i === 0 ? 'first' : ''}" data-day="${date}" data-j="${i}">
        ${dateCell}
        <td><input class="cell" data-f="jobNo" value="${esc(j.jobNo)}" placeholder="Job no." aria-label="Job number"${dis}><div class="rowtools">${controls}</div></td>
        <td><input class="cell" data-f="customer" value="${esc(j.customer)}" placeholder="Customer" aria-label="Customer"${dis}></td>
        <td class="timecell">${timeBox('From', 'from', j.from, dis)}${timeBox('To', 'to', j.to, dis)}</td>
        <td>${assignedControl(j, dis)}</td>
        <td class="chk"><input type="checkbox" data-f="callOut"${j.callOut ? ' checked' : ''} aria-label="Call out"${dis}></td>
        <td class="chk"><input type="checkbox" data-f="noDinner"${j.noDinner ? ' checked' : ''} aria-label="No dinner"${dis}></td>
        ${dayCells}
      </tr>`;
  }).join('');
}

const ENTRY_NOTES = {
  draft: 'Draft – your entries are saved automatically as you type. Press Save & submit when the week is done.',
  submitted: 'Submitted – waiting for approval. You can still make changes until it is opened for review (changing it asks you to submit again).',
  in_review: 'This timesheet is being reviewed, so it is locked. Ask an administrator if something needs changing.',
  approved: 'This timesheet has been approved and is locked.'
};

function renderEntry() {
  const ws = ENT.weekStart, info = ENT.info;
  const locked = ENT.status === 'in_review' || ENT.status === 'approved';
  ENT.locked = locked;
  const today = mondayOf(iso(new Date()));

  $('weekTitle').textContent = `Week ${info.weekNo} · ${dateGB(ws)} – ${dateGB(addDays(ws, 6))}`;
  $('weekSub').textContent = `Tax year ${info.label}${ws === today ? ' · this week' : ''}`;
  $('weekNext').disabled = ws >= today;

  $('days').innerHTML = weekDates(ws).map(d => entryRows(d, ENT.days[d], locked)).join('');
  const key = ENT.status === 'submitted' ? 'filled' : ENT.status === 'in_review' ? 'in_review' : ENT.status === 'approved' ? 'approved' : (sheetHasJobs(ENT.days) ? 'partial' : 'none');
  $('sheetStatus').innerHTML = statusPill(key);
  $('sheetNote').textContent = ENTRY_NOTES[ENT.status] || ENTRY_NOTES.draft;
  $('submitBtn').hidden = locked;
  say('note', '');
  refreshTotals();
}

function refreshTotals() {
  weekDates(ENT.weekStart).forEach(d => {
    const el = document.querySelector(`[data-dayhours="${d}"]`);
    if (el) { const h = dayHours(ENT.days[d]); el.textContent = h ? fmtH(h) + ' h' : ''; }
  });
  $('weekTotal').textContent = fmtH(sheetHours(ENT.days)) + ' h';
}

/* ---- editing: every change is written to the model, then saved ---- */

function fieldTarget(el) {
  const tr = el.closest('tr[data-day]');
  if (!tr || ENT.locked) return null;
  const day = ENT.days[tr.dataset.day];
  const f = el.dataset.f;
  if (f === 'vanReg' || f === 'comments') return { obj: day, f };
  return { obj: day.jobs[Number(tr.dataset.j)], f };
}

function touchSheet() {
  if (ENT.status === 'submitted') {
    ENT.status = 'draft';
    $('sheetNote').textContent = ENTRY_NOTES.draft;
    $('sheetStatus').innerHTML = statusPill('partial');
  }
}

function onSheetInput(ev) {
  const el = ev.target.closest('[data-f]');
  if (!el || el.type === 'number' || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  const t = fieldTarget(el);
  if (!t) return;
  t.obj[t.f] = el.value;
  touchSheet();
  scheduleSave(false);
}

function onSheetChange(ev) {
  const el = ev.target.closest('[data-f]');
  if (!el) return;
  const t = fieldTarget(el);
  if (!t) return;

  if (el.type === 'number') {
    // Spinner for HH and MM: wraps round (23 -> 00, 45 -> 00) and snaps minutes to 15
    const box = el.closest('.t');
    const hEl = box.querySelector('.th'), mEl = box.querySelector('.tm');
    let h = hEl.value === '' ? null : Number(hEl.value);
    let m = mEl.value === '' ? null : Number(mEl.value);
    if (h === null && m === null) { t.obj[t.f] = ''; }
    else {
      h = ((Math.round(h ?? 0) % 24) + 24) % 24;
      m = (((Math.round((m ?? 0) / 15) * 15) % 60) + 60) % 60;
      hEl.value = String(h).padStart(2, '0');
      mEl.value = String(m).padStart(2, '0');
      t.obj[t.f] = `${hEl.value}:${mEl.value}`;
    }
  } else if (el.type === 'checkbox') {
    t.obj[t.f] = el.checked;
  } else {
    t.obj[t.f] = el.value;
    if (t.f === 'assignedBy') { renderEntry(); }   // shows or hides the "Other" name box
  }
  touchSheet();
  refreshTotals();
  scheduleSave(true);
}

function tsAddJob(date) {
  if (ENT.locked) return;
  ENT.days[date].jobs.push(blankJob());
  touchSheet();
  renderEntry();
  scheduleSave(true);
  const rows = document.querySelectorAll(`tr[data-day="${date}"] [data-f="jobNo"]`);
  if (rows.length) rows[rows.length - 1].focus();
}

function tsDelJob(date, index) {
  if (ENT.locked) return;
  const job = ENT.days[date].jobs[index];
  if (jobHasData(job) && !confirm('Remove this job row?')) return;
  ENT.days[date].jobs.splice(index, 1);
  if (!ENT.days[date].jobs.length) ENT.days[date].jobs.push(blankJob());
  touchSheet();
  renderEntry();
  scheduleSave(true);
}

/* ---- saving ---- */

function scheduleSave(immediate) {
  if (ENT.locked) return;
  ENT.dirty = true;
  say('saveInd', 'Saving…');
  clearTimeout(ENT.timer);
  ENT.timer = setTimeout(() => saveNow(), immediate ? 0 : 600);
}

function flushSave() {
  if (!ENT || !ENT.dirty) return Promise.resolve();
  clearTimeout(ENT.timer);
  return saveNow();
}

function saveNow(submit) {
  ENT.queue = ENT.queue.then(() => doSave(submit)).catch(() => {});
  return ENT.queue;
}

async function doSave(submit) {
  if (!ENT.dirty && !submit) return;
  ENT.dirty = false;
  if (!ENT.exists && !sheetHasAnything(ENT.days)) { say('saveInd', ''); return; }
  const payload = {
    userId: ENT.s.user.uid, employeeId: ENT.emp.id, employeeName: ENT.emp.displayName,
    weekStart: ENT.weekStart, weekNo: ENT.info.weekNo, taxYear: ENT.info.label,
    days: ENT.days, status: ENT.status, updatedAt: TS()
  };
  if (!ENT.exists) payload.createdAt = TS();
  if (submit) payload.submittedAt = TS();
  try {
    await db.collection('timesheets').doc(ENT.docId).set(payload, { merge: true });
    ENT.exists = true;
    say('saveInd', 'All changes saved at ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '.', 'ok');
    return true;
  } catch (err) {
    ENT.dirty = true;
    say('saveInd', 'Not saved yet: ' + (err.code || err.message) + (err.code === 'permission-denied' ? ' (the timesheet may have been locked for review)' : ''), 'error');
    return false;
  }
}

function validateSheet() {
  if (!sheetHasJobs(ENT.days)) return 'Enter at least one job before submitting.';
  for (const d of weekDates(ENT.weekStart)) {
    const jobs = ENT.days[d].jobs;
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (!jobHasData(j)) continue;
      const where = `${dayName(d)} ${shortDate(d)}, job ${i + 1}`;
      if (!j.jobNo.trim()) return `${where}: enter the job number.`;
      if (!j.customer.trim()) return `${where}: enter the customer.`;
      if (!j.from || !j.to) return `${where}: enter both the From and To times.`;
      if (toMin(j.from) === toMin(j.to)) return `${where}: From and To are the same time.`;
      if (!j.assignedBy) return `${where}: choose who assigned the job.`;
      if (j.assignedBy === 'Other' && !j.assignedOther.trim()) return `${where}: type the name of who assigned the job.`;
    }
  }
  return '';
}

async function tsSubmit() {
  if (ENT.locked) return;
  const problem = validateSheet();
  if (problem) return say('note', problem, 'error');
  if (!confirm(`Submit week ${ENT.info.weekNo} for approval?`)) return;
  clearTimeout(ENT.timer);
  ENT.status = 'submitted';
  ENT.dirty = true;
  const saved = await saveNow(true);
  if (saved === false) { ENT.status = 'draft'; return say('note', 'Could not submit. Check the message next to the Save button.', 'error'); }
  renderEntry();
  say('note', 'Submitted for approval.', 'ok');
}

/* ==========================================================================
   Admin: who has filled in a timesheet, review and approve
   ========================================================================== */

let ADM = null;

async function initTsAdmin() {
  const s = await guard({ admin: true });
  if (!s) return;
  ADM = { s, ts: await getTsSettings(), people: [], sheets: {}, cur: null };
  WK.onWeek = renderAdminWeek;
  $('reviewRows').addEventListener('change', onApproveChange);
  await renderAdminWeek();
}

async function renderAdminWeek() {
  ADM.cur = null;
  $('reviewView').hidden = true;
  $('listView').hidden = false;
  const ws = WK.weekStart;
  const info = weekInfo(ws, ADM.ts);
  $('weekTitle').textContent = `Week ${info.weekNo} · ${dateGB(ws)} – ${dateGB(addDays(ws, 6))}`;
  $('weekSub').textContent = `Tax year ${info.label}`;
  fillOptionsForm();

  try {
    const [es, ss] = await Promise.all([
      db.collection('employees').get(),
      db.collection('timesheets').where('weekStart', '==', ws).get()
    ]);
    ADM.people = es.docs.map(d => normEmp(d.id, d.data())).filter(x => x.hasName && x.timesheetRequired).sort(byName);
    ADM.sheets = Object.fromEntries(ss.docs.map(d => [d.data().userId, { id: d.id, ...d.data() }]));
  } catch (err) {
    $('sheetRows').innerHTML = `<tr><td colspan="5" class="note--error">Could not load the timesheets: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Timesheets');
    return;
  }

  const counts = { none: 0, partial: 0, filled: 0, in_review: 0, approved: 0 };
  $('sheetRows').innerHTML = ADM.people.map(p => {
    const sh = ADM.sheets[p.userId];
    const key = sheetState(sh);
    counts[key]++;
    const hours = sh ? sheetHours(normDays(sh.days, sh.weekStart)) : 0;
    return `
      <tr>
        <td><b>${esc(p.displayName)}</b><br><small>${esc(p.team)}</small></td>
        <td>${statusPill(key)}</td>
        <td class="num">${hours ? fmtH(hours) : '–'}</td>
        <td>${sh && sh.updatedAt ? 'Saved' : ''}</td>
        <td><button type="button" class="small" data-action="ts-open" data-uid="${esc(p.userId)}"${key === 'none' ? ' disabled' : ''}>${key === 'approved' ? 'View' : 'Open'}</button></td>
      </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nobody is set to fill in timesheets yet. Use "Who fills in timesheets" to choose people.</td></tr>';

  $('summary').innerHTML = Object.keys(counts).map(k => `<span>${statusPill(k)} ${counts[k]}</span>`).join(' ');
}

function adminJobs(days) { return Object.values(days).flatMap(d => d.jobs.filter(jobHasData)); }

async function tsOpenReview(uid) {
  const person = ADM.people.find(p => p.userId === uid);
  const doc = ADM.sheets[uid];
  if (!person || !doc) return;
  const days = normDays(doc.days, doc.weekStart);
  let status = doc.status;
  try {
    // Opening a submitted timesheet starts the review: employee edits are locked and old ticks are cleared
    if (status === 'submitted') {
      Object.values(days).forEach(d => d.jobs.forEach(j => { j.approved = false; }));
      status = 'in_review';
      await db.collection('timesheets').doc(doc.id).update({ days, status, reviewedBy: ADM.s.user.uid, reviewedAt: TS() });
    }
  } catch (err) { reportError(err, 'Starting the review'); return; }
  ADM.cur = { person, id: doc.id, weekStart: doc.weekStart, days, status };
  $('listView').hidden = true;
  $('reviewView').hidden = false;
  renderReview();
}

function renderReview() {
  const c = ADM.cur;
  const draft = c.status === 'draft';
  $('reviewTitle').textContent = `${c.person.displayName} – week ${weekInfo(c.weekStart, ADM.ts).weekNo}`;
  $('reviewStatus').innerHTML = statusPill(draft ? 'partial' : c.status === 'approved' ? 'approved' : c.status === 'in_review' ? 'in_review' : 'filled');
  $('reviewNote').textContent = draft
    ? 'Not submitted yet, so jobs cannot be approved. You can see what has been entered so far.'
    : c.status === 'approved' ? 'Every job is approved.' : 'Tick each job to approve its time. When every job is ticked the timesheet becomes Approved.';

  $('reviewRows').innerHTML = weekDates(c.weekStart).map(date => {
    const day = c.days[date];
    const n = day.jobs.length;
    return day.jobs.map((j, i) => {
      const dateCell = i === 0
        ? `<td class="daycell" rowspan="${n}"><b>${dayName(date)}</b><br>${shortDate(date)}<br><small class="muted">${dayHours(day) ? fmtH(dayHours(day)) + ' h' : ''}</small></td>` : '';
      const dayCells = i === 0
        ? `<td rowspan="${n}">${esc(day.vanReg)}</td><td rowspan="${n}">${esc(day.comments)}</td>` : '';
      const has = jobHasData(j);
      return `
        <tr class="${i === 0 ? 'first' : ''}">
          ${dateCell}
          <td>${esc(j.jobNo)}</td>
          <td>${esc(j.customer)}</td>
          <td class="timecell">${esc(j.from)}${j.from || j.to ? ' – ' : ''}${esc(j.to)}</td>
          <td class="num"><b>${has ? fmtH(jobHours(j)) : ''}</b></td>
          <td>${esc(assignerName(j))}</td>
          <td class="chk">${j.callOut ? '✓' : ''}</td>
          <td class="chk">${j.noDinner ? '✓' : ''}</td>
          ${dayCells}
          <td class="chk">${has ? `<input type="checkbox" data-day="${date}" data-j="${i}"${j.approved ? ' checked' : ''}${draft ? ' disabled' : ''} aria-label="Approve this job">` : ''}</td>
        </tr>`;
    }).join('');
  }).join('');
  $('reviewTotal').textContent = fmtH(sheetHours(c.days)) + ' h';
  $('approveAll').disabled = draft;
  $('reopenBtn').disabled = draft;
}

async function onApproveChange(ev) {
  const el = ev.target.closest('input[type=checkbox][data-day]');
  if (!el || !ADM.cur) return;
  ADM.cur.days[el.dataset.day].jobs[Number(el.dataset.j)].approved = el.checked;
  await tsSaveReview();
}

function tsApproveAll() {
  if (!ADM.cur) return;
  adminJobs(ADM.cur.days).forEach(j => { j.approved = true; });
  tsSaveReview();
}

async function tsSaveReview() {
  const c = ADM.cur;
  const jobs = adminJobs(c.days);
  const status = jobs.length && jobs.every(j => j.approved) ? 'approved' : 'in_review';
  try {
    await db.collection('timesheets').doc(c.id).update({ days: c.days, status, reviewedBy: ADM.s.user.uid, reviewedAt: TS() });
    c.status = status;
    renderReview();
    say('reviewMsg', status === 'approved' ? 'All jobs approved. This timesheet is now Approved.' : 'Saved. Still in review.', 'ok');
  } catch (err) { say('reviewMsg', 'Could not save: ' + (err.code || err.message), 'error'); reportError(err, 'Approving'); }
}

async function tsReopen() {
  const c = ADM.cur;
  if (!c || !confirm('Send this timesheet back to the employee to edit? Approvals will be cleared.')) return;
  Object.values(c.days).forEach(d => d.jobs.forEach(j => { j.approved = false; }));
  try {
    await db.collection('timesheets').doc(c.id).update({ days: c.days, status: 'draft', reviewedBy: ADM.s.user.uid, reviewedAt: TS() });
    await renderAdminWeek();
  } catch (err) { say('reviewMsg', 'Could not reopen: ' + (err.code || err.message), 'error'); }
}

function tsBackToList() { renderAdminWeek(); }

/* ---- drop-down options and week numbering (admin page) ---- */

function fillOptionsForm() {
  $('optAssigned').value = ADM.ts.assignedBy.join('\n');
  $('optVans').value = ADM.ts.vanRegs.join('\n');
  const info = weekInfo(WK.weekStart, ADM.ts);
  $('w1label').textContent = `Week 1 of the ${info.label} tax year starts on`;
  $('w1date').value = (ADM.ts.week1 && ADM.ts.week1[info.taxYear]) || '';
  $('w1hint').textContent = `Leave blank to use the week containing 1 April (${dateGB(mondayOf(`${info.taxYear}-04-01`))}).`;
}

async function tsSaveOptions() {
  const lines = id => [...new Set($(id).value.split('\n').map(x => x.trim()).filter(Boolean))];
  const info = weekInfo(WK.weekStart, ADM.ts);
  const week1 = { ...ADM.ts.week1, [info.taxYear]: $('w1date').value };
  try {
    await db.doc('settings/timesheet').set({ assignedBy: lines('optAssigned'), vanRegs: lines('optVans'), week1, updatedAt: TS() }, { merge: true });
    ADM.ts = await getTsSettings(true);
    say('optNote', 'Saved. Employees will see the new options straight away.', 'ok');
    await renderAdminWeek();
  } catch (err) { say('optNote', 'Could not save: ' + (err.code || err.message), 'error'); reportError(err, 'Saving options'); }
}

/* ==========================================================================
   Admin: choose who is expected to fill in timesheets
   ========================================================================== */

let PEOPLE = [];

async function initTsPeople() {
  const s = await guard({ admin: true });
  if (!s) return;
  $('peopleRows').addEventListener('change', async ev => {
    const el = ev.target.closest('input[type=checkbox][data-id]');
    if (!el) return;
    try {
      await db.collection('employees').doc(el.dataset.id).update({ timesheetRequired: el.checked });
      const p = PEOPLE.find(x => x.id === el.dataset.id);
      if (p) p.timesheetRequired = el.checked;
      updatePeopleCount('Saved.');
    } catch (err) { el.checked = !el.checked; say('peopleNote', 'Could not save: ' + (err.code || err.message), 'error'); reportError(err, 'Timesheet list'); }
  });
  await renderPeople();
}

function updatePeopleCount(msg) {
  const n = PEOPLE.filter(p => p.timesheetRequired).length;
  $('peopleCount').textContent = `${n} of ${PEOPLE.length} employees will fill in timesheets`;
  if (msg) say('peopleNote', msg, 'ok');
}

async function renderPeople() {
  try {
    const es = await db.collection('employees').get();
    PEOPLE = es.docs.map(d => normEmp(d.id, d.data())).filter(x => x.hasName).sort(byName);
  } catch (err) {
    $('peopleRows').innerHTML = `<tr><td colspan="4" class="note--error">Could not load employees: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Employees');
    return;
  }
  $('peopleRows').innerHTML = PEOPLE.map(p => `
    <tr>
      <td><b>${esc(p.displayName)}</b></td>
      <td>${esc(p.team)}</td>
      <td>${esc(p.department)}</td>
      <td class="chk"><input type="checkbox" data-id="${esc(p.id)}"${p.timesheetRequired ? ' checked' : ''} aria-label="Timesheet expected from ${esc(p.displayName)}"></td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">No employees found.</td></tr>';
  updatePeopleCount('');
}

async function tsSetAll(on) {
  try {
    for (let i = 0; i < PEOPLE.length; i += 400) {
      const batch = db.batch();
      PEOPLE.slice(i, i + 400).forEach(p => batch.update(db.collection('employees').doc(p.id), { timesheetRequired: on }));
      await batch.commit();
    }
    await renderPeople();
    updatePeopleCount(on ? 'Everyone is now expected to fill in a timesheet.' : 'Nobody is expected to fill in a timesheet.');
  } catch (err) { say('peopleNote', 'Could not save: ' + (err.code || err.message), 'error'); reportError(err, 'Timesheet list'); }
}
