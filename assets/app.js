/* ==========================================================================
   Holiday Tracker – Firebase (Auth + Firestore, compat SDK)
   One script for every page. Each page sets <body data-page="..."> and this
   file runs the matching init function.
   ========================================================================== */

const auth = firebase.auth();
const db = firebase.firestore();
const TS = () => firebase.firestore.FieldValue.serverTimestamp();

const DEFAULT_PW = '000000';
const page = document.body.dataset.page;

/* ---------- small helpers ---------- */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fmt = n => String(Math.round((Number(n) || 0) * 10) / 10);
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const dateGB = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

function say(id, text, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'note' + (type ? ' note--' + type : '');
}

// "Connor Dennison" -> connor.dennison@holiday.company.invalid ; a real email is used as typed
const nameToMail = n => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '@holiday.company.invalid';
const loginEmail = v => (v.includes('@') ? v.trim().toLowerCase() : nameToMail(v));

function makeInitials(name, taken) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0][0].toUpperCase();
  const last = parts[parts.length - 1];
  let ini = first + last[0].toUpperCase();
  for (let i = 1; taken.has(ini) && i < last.length; i++) ini = first + last[0].toUpperCase() + last.slice(1, i + 1).toLowerCase();
  return ini;
}

/* ---------- click delegation (no inline onclick handlers) ---------- */

const ACTIONS = {
  logout,
  resetPw,
  'cal-prev': () => changeMonth(-1),
  'cal-next': () => changeMonth(1),
  approve: el => review(el.dataset.id, 'approved'),
  reject: el => review(el.dataset.id, 'rejected'),
  'log-delete': el => deleteLog(el.dataset.id),
  'emp-edit': el => openEdit(el.dataset.id),
  'role-toggle': el => toggleRole(el.dataset.uid, el.dataset.role)
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

/* ---------- settings, rota, working-day maths ---------- */

let _settings = null;
async function getSettings() {
  if (_settings) return _settings;
  const snap = await db.doc('settings/company').get();
  _settings = snap.exists ? snap.data() : {
    holidayYearStart: '2027-01-01', holidayYearEnd: '2027-12-31',
    initialAllowanceTeams: 28, initialAllowanceFiveDay: 28, bankHolidayCount: 8,
    team1Accrual: 3, team2Accrual: 4,
    leaveTypes: ['Annual Leave', 'Sick Leave', 'Public Holiday', 'Unpaid', 'Other'],
    teams: ['5-Day Week', 'Team 1', 'Team 2']
  };
  return _settings;
}

async function getRota(from, to) {
  const snap = await db.collection('rotaDays')
    .orderBy(firebase.firestore.FieldPath.documentId()).startAt(from).endAt(to).get();
  const map = {};
  snap.docs.forEach(d => { map[d.id] = d.data(); });
  return map;
}

// Does this date count as a leave day for this team? (weekends, bank holidays,
// the shutdown and the team's own rest day never use up allowance)
function isLeaveDay(dateStr, team, rota) {
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  if (dow === 0 || dow === 6) return false;
  const r = rota[dateStr];
  if (!r) return true;
  if (r.bankHoliday || r.companyShutdown) return false;
  if (team === 'Team 1' && r.team1Off) return false;
  if (team === 'Team 2' && r.team2Off) return false;
  return true;
}

function leaveDays(a, b, team, rota) {
  const d = new Date(a + 'T12:00:00'), end = new Date(b + 'T12:00:00');
  let n = 0;
  while (d <= end) { if (isLeaveDay(iso(d), team, rota)) n++; d.setDate(d.getDate() + 1); }
  return n;
}

function longServiceDays(start, set) {
  if (!start) return 0;
  const a = new Date(start + 'T12:00:00'), b = new Date(set.holidayYearStart + 'T12:00:00');
  let y = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) y--;
  return y >= 20 ? 5 : y >= 15 ? 3 : y >= 10 ? 2 : y >= 5 ? 1 : 0;
}

function defaultsFor(team, start, set) {
  const initial = team === '5-Day Week' ? set.initialAllowanceFiveDay : set.initialAllowanceTeams;
  return {
    allowanceDays: initial - set.bankHolidayCount,
    accrualDays: team === 'Team 1' ? set.team1Accrual : team === 'Team 2' ? set.team2Accrual : 0,
    longServiceDays: longServiceDays(start, set)
  };
}

function summarise(emp, reqs, logs, set) {
  const inYear = d => d >= set.holidayYearStart && d <= set.holidayYearEnd;
  const logged = sum(logs.filter(l => l.leaveType === 'Annual Leave' && inYear(l.date)), l => l.days);
  const approved = sum(reqs.filter(r => r.status === 'approved' && inYear(r.startDate)), r => r.days);
  const pending = sum(reqs.filter(r => r.status === 'pending' && inYear(r.startDate)), r => r.days);
  const sick = logs.filter(l => l.leaveType === 'Sick Leave');
  const sickDays = sum(sick, l => l.days);
  const total = emp.allowanceDays + emp.carryoverDays + emp.accrualDays + emp.longServiceDays;
  return {
    total, used: logged + approved, pending,
    available: total - logged - approved - pending,
    sickDays, bradford: sick.length * sick.length * sickDays
  };
}

const bfClass = b => (b >= 900 ? 'bf-red' : b >= 100 ? 'bf-orange' : b >= 45 ? 'bf-amber' : '');

/* ---------- auth ---------- */

function currentUser() {
  return new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}

async function guard(opts = {}) {
  const user = await currentUser();
  if (!user) { location.href = 'index.html'; return; }

  const ps = await db.collection('profiles').doc(user.uid).get();
  if (!ps.exists) { await auth.signOut(); location.href = 'index.html'; return; }
  const p = ps.data();

  if (p.mustChangePassword && page !== 'change') { location.href = 'change-password.html'; return; }
  if (opts.admin && p.role !== 'admin') { location.href = 'employee.html'; return; }

  const eq = await db.collection('employees').where('userId', '==', user.uid).limit(1).get();
  const emp = eq.empty ? null : { id: eq.docs[0].id, ...eq.docs[0].data() };

  buildNav(p, emp);
  return { user, p, emp };
}

function buildNav(p, emp) {
  const nav = $('nav');
  if (!nav) return;
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = [];
  if (p.role === 'admin') links.push(['admin.html', 'Approvals'], ['employees.html', 'Employees'], ['holiday-log.html', 'Holiday log']);
  if (p.role !== 'admin' || emp) links.push(['employee.html', 'My holidays']);
  links.push(['calendar.html', 'Calendar']);
  nav.innerHTML = links.map(([h, t]) => `<a href="${h}"${h === here ? ' aria-current="page"' : ''}>${t}</a>`).join('') +
    '<button type="button" class="ghost small" data-action="logout">Log out</button>';
  const brand = document.querySelector('.brand');
  if (brand && p.role === 'admin') brand.textContent = 'Holiday Tracker · Admin';
}

async function logout() { await auth.signOut(); location.href = 'index.html'; }

async function signIn(e) {
  e.preventDefault();
  say('message', '');
  try {
    const cred = await auth.signInWithEmailAndPassword(loginEmail($('name').value), $('pw').value);
    const snap = await db.collection('profiles').doc(cred.user.uid).get();
    if (!snap.exists) { await auth.signOut(); return say('message', 'Account not set up yet. Contact an administrator.', 'error'); }
    const p = snap.data();
    if (p.mustChangePassword) { location.href = 'change-password.html'; return; }
    location.href = p.role === 'admin' ? 'admin.html' : 'employee.html';
  } catch (err) {
    say('message', err.code === 'auth/too-many-requests' ? 'Too many attempts. Try again later.' : 'Name or password not recognised.', 'error');
  }
}

async function resetPw() {
  const v = $('name').value;
  if (!v.includes('@')) return say('message', 'To email a reset link, type your email address in the Name box. Otherwise contact an administrator.', 'error');
  try { await auth.sendPasswordResetEmail(v.trim()); } catch (_) { /* don't reveal whether the account exists */ }
  say('message', 'If that account exists, a reset email has been sent.', 'ok');
}

function initLogin() {
  $('login').onsubmit = signIn;
  if ($('setupBtn')) $('setupBtn').onclick = runSetup;
}

async function initChange() {
  const s = await guard();
  if (!s) return;
  $('change').onsubmit = async ev => {
    ev.preventDefault();
    const a = $('pw1').value, b = $('pw2').value;
    if (a.length < 10) return say('message', 'Use at least 10 characters.', 'error');
    if (a === DEFAULT_PW) return say('message', 'Choose something other than the default password.', 'error');
    if (a !== b) return say('message', 'Passwords do not match.', 'error');
    try {
      await s.user.updatePassword(a);
      await db.collection('profiles').doc(s.user.uid).update({ mustChangePassword: false });
      location.href = s.p.role === 'admin' ? 'admin.html' : 'employee.html';
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') { await auth.signOut(); location.href = 'index.html'; }
      else say('message', err.message, 'error');
    }
  };
}

/* ==========================================================================
   One-time setup: create Admin + every employee from the Excel workbook,
   the Rota, bank holidays, settings and the holiday log
   ========================================================================== */

async function authUser(secApp, email) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await secApp.auth().createUserWithEmailAndPassword(email, DEFAULT_PW);
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') return secApp.auth().signInWithEmailAndPassword(email, DEFAULT_PW);
      if (e.code === 'auth/too-many-requests' || e.code === 'auth/network-request-failed') { await sleep(3000); continue; }
      throw e;
    }
  }
  throw new Error('Gave up after repeated rate-limit errors');
}

async function runSetup() {
  const S = window.SEED;
  const btn = $('setupBtn');
  if (!S) return say('setupMsg', 'seed-data.js is missing.', 'error');
  if (!confirm(`This creates the Admin login and ${S.employees.length} employee logins (password ${DEFAULT_PW}), plus the rota, bank holidays and settings in Firestore. Continue?`)) return;

  btn.disabled = true;
  $('setupLog').innerHTML = '';
  const log = (text, cls) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    $('setupLog').appendChild(li);
    li.scrollIntoView({ block: 'nearest' });
  };

  let secApp = null;
  try {
    /* 1. Admin login + profile (first-run bootstrap allowed by the security rules) */
    log('Creating the Admin login…');
    const adminEmail = nameToMail(S.adminName);
    let cred;
    try {
      cred = await auth.createUserWithEmailAndPassword(adminEmail, DEFAULT_PW);
    } catch (e) {
      if (e.code !== 'auth/email-already-in-use') throw e;
      try { cred = await auth.signInWithEmailAndPassword(adminEmail, DEFAULT_PW); }
      catch (_) { throw new Error('Admin already exists and its password has been changed. Sign in as Admin, then add anyone missing on the Employees page.'); }
    }
    const adminUid = cred.user.uid;
    const profileRef = db.collection('profiles').doc(adminUid);

    let existing = null;
    try { const ps = await profileRef.get(); existing = ps.exists ? ps.data() : null; } catch (_) { /* treated as missing */ }
    if (!existing) {
      const b = db.batch();
      b.set(db.doc('settings/setup'), { done: true, by: adminUid, createdAt: TS() });
      b.set(profileRef, { displayName: S.adminName, role: 'admin', mustChangePassword: true, createdAt: TS() });
      await b.commit();
      log('✓ Admin profile created');
    } else if (existing.role !== 'admin') {
      throw new Error('A profile named Admin exists but is not an administrator.');
    } else {
      log('Admin profile already exists – reusing', 'skip');
    }

    /* 2. Settings, bank holidays, rota */
    await db.doc('settings/company').set({ ...S.company, updatedAt: TS() });
    log('✓ settings/company written');

    const bhBatch = db.batch();
    S.bankHolidays.forEach(([date, name]) => bhBatch.set(db.collection('bankHolidays').doc(date), { date, name }));
    await bhBatch.commit();
    log(`✓ bankHolidays: ${S.bankHolidays.length} documents`);

    for (let i = 0; i < S.rota.length; i += 400) {
      const b = db.batch();
      S.rota.slice(i, i + 400).forEach(r => b.set(db.collection('rotaDays').doc(r[0]), {
        date: r[0], day: r[1], label: r[2], bankHoliday: !!r[2],
        team1Off: !!r[3], team2Off: !!r[4], team1Accrued: r[5], team2Accrued: r[6], companyShutdown: !!r[7]
      }));
      await b.commit();
    }
    log(`✓ rotaDays: ${S.rota.length} documents (full 2027 rota)`);

    /* 3. Employees: Auth user + profile + employee record */
    const byName = {};
    (await db.collection('employees').get()).docs.forEach(d => { byName[d.data().displayName] = { id: d.id, userId: d.data().userId }; });

    secApp = firebase.initializeApp(firebase.app().options, 'seed-' + Date.now());
    let created = 0, skipped = 0, failed = 0;

    for (const e of S.employees) {
      if (byName[e.name]) { skipped++; log(`${e.name}: already set up – skipped`, 'skip'); continue; }
      try {
        const c = await authUser(secApp, nameToMail(e.name));
        const uid = c.user.uid;
        await secApp.auth().signOut();
        const b = db.batch();
        b.set(db.collection('profiles').doc(uid), { displayName: e.name, role: 'employee', mustChangePassword: true, createdAt: TS() });
        b.set(db.collection('employees').doc(uid), {
          userId: uid, displayName: e.name, initials: e.initials, department: e.department, team: e.team,
          startDate: e.start, allowanceDays: e.allowance, carryoverDays: e.carryover,
          accrualDays: e.accrual, longServiceDays: e.longService, active: true, createdAt: TS()
        });
        await b.commit();
        byName[e.name] = { id: uid, userId: uid };
        created++;
        log(`✓ ${e.name} – ${e.team}`);
        await sleep(250);
      } catch (err) {
        failed++;
        log(`✗ ${e.name}: ${err.code || err.message}`, 'err');
      }
    }

    /* 4. Holiday log entries from the workbook */
    for (const l of S.log) {
      const emp = byName[l.name];
      if (!emp) { log(`Log entry ${l.n}: ${l.name} not found – skipped`, 'err'); continue; }
      await db.collection('holidayLog').doc('excel-' + l.n).set({
        employeeId: emp.id, userId: emp.userId, employeeName: l.name,
        date: l.date, leaveType: l.type, days: l.days, notes: l.notes, createdAt: TS()
      });
    }
    log(`✓ holidayLog: ${S.log.length} entry from the workbook`);

    log(`Done. ${created} created, ${skipped} skipped, ${failed} failed. Sign in with the person’s name and password ${DEFAULT_PW}; everyone is asked to choose a new password on first login.`, 'done');
    await auth.signOut();
    if (failed === 0) btn.textContent = 'Setup complete';
    else btn.disabled = false;
  } catch (e) {
    console.error(e);
    log('Setup stopped: ' + (e.code || '') + ' ' + e.message, 'err');
    btn.disabled = false;
  } finally {
    if (secApp) { try { await secApp.delete(); } catch (_) { /* ignore */ } }
  }
}

/* ==========================================================================
   Employee page – balance, request form, history
   ========================================================================== */

async function initEmployee() {
  const s = await guard();
  if (!s) return;
  if (!s.emp) {
    if (s.p.role === 'admin') { location.href = 'admin.html'; return; }
    say('note', 'Your employee record is not linked yet. Ask an administrator.', 'error');
    return;
  }
  const e = s.emp;
  const set = await getSettings();
  const rota = await getRota(set.holidayYearStart, set.holidayYearEnd);
  $('hello').textContent = 'Hello, ' + e.displayName;
  $('employee').value = e.displayName;
  $('yearInfo').textContent = `Holiday year ${dateGB(set.holidayYearStart)} – ${dateGB(set.holidayYearEnd)} · ${e.team}`;

  const [rq, lg] = await Promise.all([
    db.collection('holidayRequests').where('userId', '==', s.user.uid).get(),
    db.collection('holidayLog').where('userId', '==', s.user.uid).get()
  ]);
  const reqs = rq.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => y.startDate.localeCompare(x.startDate));
  const logs = lg.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => y.date.localeCompare(x.date));
  const t = summarise(e, reqs, logs, set);

  $('tiles').innerHTML = `
    <div class="tile primary"><div class="label">Available to book</div><div class="value">${fmt(t.available)}</div></div>
    <div class="tile"><div class="label">Total entitlement</div><div class="value">${fmt(t.total)}</div></div>
    <div class="tile"><div class="label">Used</div><div class="value">${fmt(t.used)}</div></div>
    <div class="tile"><div class="label">Awaiting approval</div><div class="value">${fmt(t.pending)}</div></div>`;
  $('breakdown').textContent = `Entitlement = annual allowance ${fmt(e.allowanceDays)} + carryover ${fmt(e.carryoverDays)} + bank holiday accrual ${fmt(e.accrualDays)} + long service ${fmt(e.longServiceDays)}. Sick days recorded: ${fmt(t.sickDays)} · Bradford Factor: ${fmt(t.bradford)}.`;

  $('rows').innerHTML = reqs.length ? reqs.map(x => `
    <tr>
      <td>${esc(dateGB(x.startDate))}${x.endDate !== x.startDate ? ' – ' + esc(dateGB(x.endDate)) : ''} ${x.session === 'AM' || x.session === 'PM' ? esc(x.session) : ''}</td>
      <td>${fmt(x.days)}</td>
      <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td>
      <td>${esc(x.reason)}${x.adminNote ? ` <small>(${esc(x.adminNote)})</small>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">No requests yet.</td></tr>';

  $('logRows').innerHTML = logs.length ? logs.map(x => `
    <tr><td>${esc(dateGB(x.date))}</td><td>${esc(x.leaveType)}</td><td>${fmt(x.days)}</td><td>${esc(x.notes)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nothing recorded.</td></tr>';

  const preview = () => {
    const a = $('start').value, b = $('end').value, k = $('kind').value;
    if (!a || !b || b < a) return say('preview', '');
    if (k !== 'FULL') $('end').value = a;
    const days = k === 'FULL' ? leaveDays(a, b, e.team, rota) : (isLeaveDay(a, e.team, rota) ? 0.5 : 0);
    say('preview', days ? `This will use ${fmt(days)} day(s) of your allowance.` : 'No working days in that range (weekend, bank holiday, shutdown or your rest day).');
  };
  ['start', 'end', 'kind'].forEach(id => { $(id).onchange = preview; });

  $('request').onsubmit = async ev => {
    ev.preventDefault();
    const k = $('kind').value;
    const a = $('start').value;
    const b = k === 'FULL' ? $('end').value : a;
    if (!a || !b || b < a) return say('note', 'Check your dates.', 'error');
    if (a < set.holidayYearStart || b > set.holidayYearEnd) return say('note', `Requests are currently open for ${dateGB(set.holidayYearStart)} – ${dateGB(set.holidayYearEnd)} only.`, 'error');
    const days = k === 'FULL' ? leaveDays(a, b, e.team, rota) : (isLeaveDay(a, e.team, rota) ? 0.5 : 0);
    if (days <= 0) return say('note', 'No working days in that range.', 'error');
    if (days > t.available) return say('note', `Not enough allowance (${fmt(t.available)} days available).`, 'error');
    const clash = reqs.some(r => r.status !== 'rejected' && r.startDate <= b && r.endDate >= a && (r.session === 'FULL' || k === 'FULL' || r.session === k));
    if (clash) return say('note', 'You already have a request covering those dates.', 'error');

    try {
      const ref = db.collection('holidayRequests').doc();
      const batch = db.batch();
      batch.set(ref, { employeeId: e.id, userId: s.user.uid, startDate: a, endDate: b, days, session: k, reason: $('reason').value.trim(), status: 'pending', createdAt: TS() });
      // Minimal public record for the shared calendar (initials + dates only)
      batch.set(db.collection('calendarEntries').doc(ref.id), { employeeId: e.id, initials: e.initials, startDate: a, endDate: b, session: k, status: 'pending' });
      await batch.commit();
      $('request').reset();
      $('employee').value = e.displayName;
      say('note', 'Request sent for approval.', 'ok');
      initEmployee();
    } catch (err) { say('note', err.message, 'error'); }
  };
}

/* ==========================================================================
   Admin – approval queue
   ========================================================================== */

async function initAdmin() {
  const s = await guard({ admin: true });
  if (!s) return;
  loadQueue();
}

async function loadQueue() {
  try {
    const [rs, es] = await Promise.all([
      db.collection('holidayRequests').where('status', '==', 'pending').get(),
      db.collection('employees').get()
    ]);
    const emp = Object.fromEntries(es.docs.map(d => [d.id, d.data()]));
    const rows = rs.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => x.startDate.localeCompare(y.startDate));
    $('pending').innerHTML = rows.length ? rows.map(x => `
      <tr>
        <td>${esc(emp[x.employeeId]?.displayName || 'Unknown')}<br><small>${esc(emp[x.employeeId]?.team || '')}</small></td>
        <td>${esc(dateGB(x.startDate))}${x.endDate !== x.startDate ? ' – ' + esc(dateGB(x.endDate)) : ''} ${x.session !== 'FULL' ? esc(x.session) : ''}</td>
        <td>${fmt(x.days)}</td>
        <td>${esc(x.reason)}</td>
        <td>
          <button type="button" class="small" data-action="approve" data-id="${esc(x.id)}">Approve</button>
          <button type="button" class="small red" data-action="reject" data-id="${esc(x.id)}">Reject</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">Nothing waiting for approval.</td></tr>';
  } catch (err) {
    $('pending').innerHTML = `<tr><td colspan="5" class="note--error">${esc(err.message)}</td></tr>`;
  }
}

async function review(id, status) {
  const upd = { status, reviewedAt: TS(), reviewedBy: auth.currentUser.uid };
  if (status === 'rejected') {
    const n = prompt('Reason (optional):');
    if (n === null) return;
    if (n.trim()) upd.adminNote = n.trim();
  }
  try {
    const batch = db.batch();
    batch.update(db.collection('holidayRequests').doc(id), upd);
    const cal = db.collection('calendarEntries').doc(id);
    if (status === 'approved') batch.update(cal, { status: 'approved' }); else batch.delete(cal);
    await batch.commit();
    say('note', 'Request ' + status + '.', 'ok');
  } catch (err) { say('note', err.message, 'error'); }
  loadQueue();
}

/* ==========================================================================
   Admin – employees
   ========================================================================== */

let EMPS = [];

async function initEmployees() {
  const s = await guard({ admin: true });
  if (!s) return;
  const set = await getSettings();
  window._me = s.user.uid;
  const teamOptions = set.teams.map(t => `<option>${esc(t)}</option>`).join('');
  $('eteam').innerHTML = teamOptions;
  $('xteam').innerHTML = teamOptions;
  $('newEmp').onsubmit = addEmployee;
  $('editForm').onsubmit = saveEdit;
  $('editCancel').onclick = () => $('editDlg').close();
  await renderEmployees();
}

async function renderEmployees() {
  const set = await getSettings();
  const [es, rs, ls, ps] = await Promise.all([
    db.collection('employees').get(),
    db.collection('holidayRequests').get(),
    db.collection('holidayLog').get(),
    db.collection('profiles').get()
  ]);
  EMPS = es.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const reqs = rs.docs.map(d => d.data());
  const logs = ls.docs.map(d => d.data());
  const roles = Object.fromEntries(ps.docs.map(d => [d.id, d.data().role]));

  $('empCount').textContent = `${EMPS.length} employees`;
  $('emps').innerHTML = EMPS.map(x => {
    const t = summarise(x, reqs.filter(r => r.employeeId === x.id), logs.filter(l => l.employeeId === x.id), set);
    const role = roles[x.userId] || 'employee';
    const self = x.userId === window._me;
    return `
      <tr>
        <td><b>${esc(x.displayName)}</b> <small>${esc(x.initials)}</small>${role === 'admin' ? ' <span class="pill admin">admin</span>' : ''}</td>
        <td>${esc(x.team)}</td>
        <td>${esc(x.department)}</td>
        <td>${esc(dateGB(x.startDate))}</td>
        <td class="num">${fmt(x.allowanceDays)}</td>
        <td class="num">${fmt(x.carryoverDays)}</td>
        <td class="num">${fmt(x.accrualDays)}</td>
        <td class="num">${fmt(x.longServiceDays)}</td>
        <td class="num"><b>${fmt(t.total)}</b></td>
        <td class="num">${fmt(t.used)}</td>
        <td class="num"><b>${fmt(t.available)}</b></td>
        <td class="num">${fmt(t.sickDays)}</td>
        <td class="num ${bfClass(t.bradford)}">${fmt(t.bradford)}</td>
        <td>
          <button type="button" class="small ghost" data-action="emp-edit" data-id="${esc(x.id)}">Edit</button>
          <button type="button" class="small ghost" data-action="role-toggle" data-uid="${esc(x.userId)}" data-role="${role === 'admin' ? 'employee' : 'admin'}"${self ? ' disabled' : ''}>${role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="14" class="empty">No employees yet – run the setup on the sign-in page.</td></tr>';
}

async function addEmployee(ev) {
  ev.preventDefault();
  const set = await getSettings();
  const name = $('ename').value.trim();
  const pw = $('epw').value;
  if (pw.length < 6) return say('note', 'The temporary password needs at least 6 characters.', 'error');
  const email = $('eemail').value.trim() ? $('eemail').value.trim().toLowerCase() : nameToMail(name);
  const team = $('eteam').value, start = $('estart').value || null;
  const d = defaultsFor(team, start, set);
  const num = (id, fallback) => ($(id).value === '' ? fallback : parseFloat($(id).value));
  const initials = makeInitials(name, new Set(EMPS.map(x => x.initials)));

  const sec = firebase.initializeApp(firebase.app().options, 'secondary-' + Date.now());
  try {
    const cred = await sec.auth().createUserWithEmailAndPassword(email, pw);
    const uid = cred.user.uid;
    const batch = db.batch();
    batch.set(db.collection('profiles').doc(uid), { displayName: name, role: $('erole').value, mustChangePassword: true, createdAt: TS() });
    batch.set(db.collection('employees').doc(uid), {
      userId: uid, displayName: name, initials, department: $('edept').value.trim(), team, startDate: start,
      allowanceDays: num('eallow', d.allowanceDays), carryoverDays: num('ecarry', 0),
      accrualDays: num('eaccr', d.accrualDays), longServiceDays: num('elong', d.longServiceDays),
      active: true, createdAt: TS()
    });
    await batch.commit();
    say('note', `Created ${name}. Login: ${email}`, 'ok');
    $('newEmp').reset();
    $('epw').value = DEFAULT_PW;
    renderEmployees();
  } catch (err) { say('note', err.message, 'error'); }
  finally { try { await sec.auth().signOut(); await sec.delete(); } catch (_) { /* ignore */ } }
}

function openEdit(id) {
  const x = EMPS.find(e => e.id === id);
  if (!x) return;
  $('editName').textContent = x.displayName;
  $('editId').value = id;
  $('xdept').value = x.department || '';
  $('xteam').value = x.team;
  $('xstart').value = x.startDate || '';
  $('xallow').value = x.allowanceDays;
  $('xcarry').value = x.carryoverDays;
  $('xaccr').value = x.accrualDays;
  $('xlong').value = x.longServiceDays;
  $('editDlg').showModal();
}

async function saveEdit(ev) {
  ev.preventDefault();
  const n = id => parseFloat($(id).value) || 0;
  try {
    await db.collection('employees').doc($('editId').value).update({
      department: $('xdept').value.trim(), team: $('xteam').value, startDate: $('xstart').value || null,
      allowanceDays: n('xallow'), carryoverDays: n('xcarry'), accrualDays: n('xaccr'), longServiceDays: n('xlong')
    });
    $('editDlg').close();
    renderEmployees();
  } catch (err) { alert(err.message); }
}

async function toggleRole(uid, role) {
  if (!uid || !confirm(`Change this account to "${role}"?`)) return;
  try { await db.collection('profiles').doc(uid).update({ role }); renderEmployees(); }
  catch (err) { alert(err.message); }
}

/* ==========================================================================
   Admin – holiday log (the Excel "Holiday Log" quick-entry sheet)
   ========================================================================== */

let LOGS = [];

async function initLog() {
  const s = await guard({ admin: true });
  if (!s) return;
  const set = await getSettings();
  const es = await db.collection('employees').get();
  EMPS = es.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const opts = EMPS.map(x => `<option value="${esc(x.id)}">${esc(x.displayName)}</option>`).join('');
  $('lemp').innerHTML = opts;
  $('lfilter').innerHTML = '<option value="">All employees</option>' + opts;
  $('ltype').innerHTML = set.leaveTypes.map(t => `<option>${esc(t)}</option>`).join('');
  $('lfilter').onchange = renderLog;
  $('logForm').onsubmit = addLog;
  await loadLog();
}

async function loadLog() {
  const snap = await db.collection('holidayLog').get();
  LOGS = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.date.localeCompare(a.date));
  renderLog();
}

function renderLog() {
  const f = $('lfilter').value;
  const rows = LOGS.filter(l => !f || l.employeeId === f);
  $('logRows').innerHTML = rows.length ? rows.map(l => `
    <tr>
      <td>${esc(dateGB(l.date))}</td><td>${esc(l.employeeName)}</td><td>${esc(l.leaveType)}</td>
      <td>${fmt(l.days)}</td><td>${esc(l.notes)}</td>
      <td><button type="button" class="small red" data-action="log-delete" data-id="${esc(l.id)}">Delete</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No entries.</td></tr>';
}

async function addLog(ev) {
  ev.preventDefault();
  const emp = EMPS.find(x => x.id === $('lemp').value);
  const days = parseFloat($('ldays').value);
  if (!emp || !$('ldate').value || !(days > 0)) return say('note', 'Choose an employee, date and number of days.', 'error');
  try {
    await db.collection('holidayLog').add({
      employeeId: emp.id, userId: emp.userId, employeeName: emp.displayName,
      date: $('ldate').value, leaveType: $('ltype').value, days, notes: $('lnotes').value.trim(), createdAt: TS()
    });
    $('ldate').value = ''; $('lnotes').value = ''; $('ldays').value = '1';
    say('note', 'Entry added.', 'ok');
    loadLog();
  } catch (err) { say('note', err.message, 'error'); }
}

async function deleteLog(id) {
  if (!confirm('Delete this entry?')) return;
  try { await db.collection('holidayLog').doc(id).delete(); loadLog(); }
  catch (err) { say('note', err.message, 'error'); }
}

/* ==========================================================================
   Calendar – approved/pending leave + the 2027 rota
   ========================================================================== */

let monthDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

async function initCalendar() {
  const s = await guard();
  if (!s) return;
  const set = await getSettings();
  const today = iso(new Date());
  if (today < set.holidayYearStart || today > set.holidayYearEnd) {
    const [y, m] = set.holidayYearStart.split('-').map(Number);
    monthDate = new Date(y, m - 1, 1);
  }
  const bh = await db.collection('bankHolidays').orderBy(firebase.firestore.FieldPath.documentId()).get();
  $('bhRows').innerHTML = bh.docs.map(d => `<tr><td>${esc(dateGB(d.id))}</td><td>${esc(d.data().name)}</td></tr>`).join('')
    || '<tr><td colspan="2" class="empty">None loaded.</td></tr>';
  draw();
}

function changeMonth(n) { monthDate.setMonth(monthDate.getMonth() + n); draw(); }

async function draw() {
  const y = monthDate.getFullYear(), m = monthDate.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const fIso = iso(first), lIso = iso(last);
  $('month').textContent = monthDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  let entries = [], rota = {};
  try {
    const [es, r] = await Promise.all([
      db.collection('calendarEntries').where('startDate', '<=', lIso).get(),
      getRota(fIso, lIso)
    ]);
    entries = es.docs.map(d => d.data()).filter(x => x.endDate >= fIso);
    rota = r;
    say('calnote', '');
  } catch (err) { say('calnote', err.message, 'error'); }

  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="head">${x}</div>`).join('');
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) html += '<div class="day blank"></div>';

  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(y, m, d), k = iso(dt), r = rota[k] || {};
    const weekend = dt.getDay() === 0 || dt.getDay() === 6;
    const cls = ['day', weekend ? 'off' : '', r.bankHoliday ? 'bank' : '', r.companyShutdown ? 'shut' : ''].filter(Boolean).join(' ');

    let tags = '';
    if (!weekend && !r.bankHoliday && !r.companyShutdown) {
      if (r.team1Off) tags += '<span class="tag t1">T1 off</span>';
      if (r.team2Off) tags += '<span class="tag t2">T2 off</span>';
    }
    if (r.bankHoliday && r.team1Accrued) tags += '<span class="tag accrue">+1 T1</span>';
    if (r.bankHoliday && r.team2Accrued) tags += '<span class="tag accrue">+1 T2</span>';
    if (r.companyShutdown) tags += '<span class="tag">Shutdown</span>';

    const chips = entries.filter(x => x.startDate <= k && x.endDate >= k)
      .map(x => `<span class="chip ${esc(x.status)}">${esc(x.initials)}${x.session !== 'FULL' ? ' ' + esc(x.session) : ''}</span>`).join('');

    html += `<div class="${cls}"><b>${d}</b>${r.bankHoliday ? `<small>${esc(r.label)}</small>` : ''}<div>${tags}</div><div>${chips}</div></div>`;
  }
  $('grid').innerHTML = html;
}

/* ---------- start ---------- */

const INIT = { login: initLogin, change: initChange, employee: initEmployee, admin: initAdmin, employees: initEmployees, log: initLog, calendar: initCalendar };
if (INIT[page]) INIT[page]();
