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
const dateGB = s => (s ? new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function say(id, text, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'note' + (type ? ' note--' + type : '');
}

// Shows a red bar at the top of the page, so a failure is never silent
function reportError(err, context) {
  console.error(context || '', err);
  let bar = $('errorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'errorBar';
    bar.className = 'banner';
    bar.setAttribute('role', 'alert');
    document.body.prepend(bar);
  }
  const hint = err && err.code === 'permission-denied'
    ? ' Firestore blocked the request: publish the latest firestore.rules in the Firebase console.' : '';
  bar.textContent = (context ? context + ': ' : '') + (err && err.message ? err.message : String(err)) + hint;
}

window.addEventListener('unhandledrejection', e => reportError(e.reason, 'Something went wrong'));

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

// Employee records can be incomplete (older imports, hand-made documents), so every
// read goes through this: missing names or figures never break a page.
function normEmp(id, d) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const name = String(d.displayName || d.name || d.fullName || '').trim();
  return {
    ...d, id, displayName: name, hasName: !!name,
    initials: d.initials || (name ? makeInitials(name, new Set()) : '?'),
    team: d.team || '5-Day Week', department: d.department || '', startDate: d.startDate || '',
    allowanceDays: num(d.allowanceDays), carryoverDays: num(d.carryoverDays),
    accrualDays: num(d.accrualDays), longServiceDays: num(d.longServiceDays)
  };
}

// Named people alphabetically, unnamed records last
const byName = (a, b) => (a.hasName === b.hasName ? a.displayName.localeCompare(b.displayName) : a.hasName ? -1 : 1);

/* ---------- click delegation (no inline onclick handlers) ---------- */

const ACTIONS = {
  logout,
  resetPw,
  'cal-prev': () => changeMonth(-1),
  'cal-next': () => changeMonth(1),
  'cal-goto': el => gotoMonth(el.dataset.date),
  approve: el => review(el.dataset.id, 'approved'),
  reject: el => review(el.dataset.id, 'rejected'),
  'log-delete': el => deleteLog(el.dataset.id),
  'role-toggle': el => toggleRole(el.dataset.uid, el.dataset.role),
  'emp-remove': el => removeEmployee(el.dataset.id),
  'save-employees': saveEmployees,
  'sync-names': syncNamesClicked
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

/* ---------- settings, rota, working-day maths ---------- */

const DEFAULT_SETTINGS = {
  holidayYearStart: '2027-01-01', holidayYearEnd: '2027-12-31',
  initialAllowanceTeams: 28, initialAllowanceFiveDay: 28, bankHolidayCount: 8,
  team1Accrual: 3, team2Accrual: 4,
  leaveTypes: ['Annual Leave', 'Sick Leave', 'Public Holiday', 'Unpaid', 'Other'],
  teams: ['5-Day Week', 'Team 1', 'Team 2']
};

let _settings = null;
async function getSettings() {
  if (_settings) return _settings;
  try {
    const snap = await db.doc('settings/company').get();
    _settings = { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
    return _settings;
  } catch (err) {
    reportError(err, 'Could not load the company settings (using defaults)');
    return DEFAULT_SETTINGS;
  }
}

async function getRota(from, to) {
  const snap = await db.collection('rotaDays')
    .orderBy(firebase.firestore.FieldPath.documentId()).startAt(from).endAt(to).get();
  const map = {};
  snap.docs.forEach(d => { map[d.id] = d.data(); });
  return map;
}

async function getRotaSafe(set) {
  try { return await getRota(set.holidayYearStart, set.holidayYearEnd); }
  catch (err) { reportError(err, 'Could not load the rota'); return {}; }
}

// Christmas shutdown periods: two boxes entered by an admin on the Employees page
function getShutdowns(set) {
  if (Array.isArray(set.shutdowns)) return set.shutdowns;
  return [
    { label: 'Christmas shutdown 2026–2027', start: '', end: '' },
    { label: 'Christmas shutdown 2027–2028', start: set.shutdownStart || '', end: set.shutdownEnd || '' }
  ];
}

function inShutdown(dateStr, set) {
  return getShutdowns(set).some(s => s.start && s.end && dateStr >= s.start && dateStr <= s.end);
}

function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  return dow === 0 || dow === 6;
}

// A day this team would normally work (not a weekend, bank holiday or their rest day)
function isWorkingDay(dateStr, team, rota) {
  if (isWeekend(dateStr)) return false;
  const r = rota[dateStr];
  if (!r) return true;
  if (r.bankHoliday) return false;
  if (team === 'Team 1' && r.team1Off) return false;
  if (team === 'Team 2' && r.team2Off) return false;
  return true;
}

// A day an employee can book as leave: a working day that is not in a shutdown
function isLeaveDay(dateStr, team, rota, set) {
  return isWorkingDay(dateStr, team, rota) && !inShutdown(dateStr, set);
}

function leaveDays(a, b, team, rota, set) {
  const d = new Date(a + 'T12:00:00'), end = new Date(b + 'T12:00:00');
  let n = 0;
  while (d <= end) { if (isLeaveDay(iso(d), team, rota, set)) n++; d.setDate(d.getDate() + 1); }
  return n;
}

// Working days inside the holiday year that fall in a shutdown: these come off everyone's allowance
function shutdownDays(team, set, rota) {
  const days = new Set();
  getShutdowns(set).forEach(s => {
    if (!s.start || !s.end) return;
    const d = new Date(s.start + 'T12:00:00'), end = new Date(s.end + 'T12:00:00');
    while (d <= end) {
      const k = iso(d);
      if (k >= set.holidayYearStart && k <= set.holidayYearEnd && isWorkingDay(k, team, rota)) days.add(k);
      d.setDate(d.getDate() + 1);
    }
  });
  return days.size;
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

// Days taken off the allowance by a request (a birthday day is not deducted)
const deducted = r => (r.deduct !== undefined ? r.deduct : r.days);

function summarise(emp, reqs, logs, set, rota) {
  const inYear = d => d >= set.holidayYearStart && d <= set.holidayYearEnd;
  const logged = sum(logs.filter(l => l.leaveType === 'Annual Leave' && inYear(l.date)), l => l.days);
  const approved = sum(reqs.filter(r => r.status === 'approved' && inYear(r.startDate)), deducted);
  const pending = sum(reqs.filter(r => r.status === 'pending' && inYear(r.startDate)), deducted);
  const shutdown = shutdownDays(emp.team, set, rota || {});
  const sick = logs.filter(l => l.leaveType === 'Sick Leave');
  const sickDays = sum(sick, l => l.days);
  const total = emp.allowanceDays + emp.carryoverDays + emp.accrualDays + emp.longServiceDays;
  return {
    total, booked: logged + approved, shutdown, used: logged + approved + shutdown, pending,
    available: total - logged - approved - shutdown - pending,
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
  const emp = eq.empty ? null : normEmp(eq.docs[0].id, eq.docs[0].data());

  buildNav(p, emp);
  if (p.role === 'admin') keepNameListFresh();
  return { user, p, emp };
}

// Admins refresh the public sign-in name list once per browser session
function keepNameListFresh() {
  try {
    if (sessionStorage.getItem('namesSynced')) return;
    syncDirectory()
      .then(() => sessionStorage.setItem('namesSynced', '1'))
      .catch(err => console.warn('Sign-in name list not refreshed:', err.message));
  } catch (_) { /* storage unavailable */ }
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

async function logout() {
  // Never let a slow sign-out leave the page hanging
  try { await Promise.race([auth.signOut(), sleep(3000)]); } catch (_) { /* ignore */ }
  location.replace('index.html');
}

// The sign-in dropdown: a listed name, or "use my email" for people with a real login email
function needsEmail() {
  const sel = $('who');
  const opt = sel.options[sel.selectedIndex];
  return sel.value === '__other' || (opt && opt.dataset.email === '1');
}

function loginValue() { return needsEmail() ? $('name').value : $('who').value; }

function toggleOther() {
  const typed = needsEmail();
  $('otherWrap').hidden = !typed;
  $('name').required = typed;
  $('nameLabel').textContent = $('who').value === '__other' ? 'Your name or email address' : 'Your login email address';
}

async function signIn(e) {
  e.preventDefault();
  say('message', '');
  const who = loginValue().trim();
  if (!who) return say('message', 'Please choose your name.', 'error');
  try {
    const cred = await auth.signInWithEmailAndPassword(loginEmail(who), $('pw').value);
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
  const v = needsEmail() ? $('name').value.trim() : '';
  if (!v.includes('@')) return say('message', 'To email a reset link, choose "use my email" in the list and type your email address. Otherwise contact an administrator.', 'error');
  try { await auth.sendPasswordResetEmail(v); } catch (_) { /* don't reveal whether the account exists */ }
  say('message', 'If that account exists, a reset email has been sent.', 'ok');
}

// Public list of names for the sign-in dropdown (loginDirectory holds display names only)
async function loadLoginNames() {
  const sel = $('who');
  const other = '<option value="__other">My name isn\u2019t listed / use my email</option>';
  try {
    const snap = await db.collection('loginDirectory').get();
    const people = snap.docs.map(d => d.data()).filter(x => x.displayName)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    sel.innerHTML = '<option value="">Select your name…</option>' +
      people.map(x => `<option${x.emailLogin ? ' data-email="1"' : ''}>${esc(x.displayName)}</option>`).join('') + other;
    if (!people.length) {
      sel.value = '__other';
      say('message', 'The name list has not been set up yet. Type your name below; an administrator can fill the list from the Employees page.');
    }
  } catch (err) {
    sel.innerHTML = other;
    sel.value = '__other';
    say('message', 'Could not load the list of names (' + (err.code || err.message) + '). Type your name instead.', 'error');
  }
  toggleOther();
}

function initLogin() {
  $('login').onsubmit = signIn;
  $('who').onchange = toggleOther;
  if ($('setupBtn')) $('setupBtn').onclick = runSetup;
  loadLoginNames();
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

/* ---------- login directory (names for the sign-in dropdown) ---------- */

// Mirrors every profile's display name into loginDirectory. Existing flags are kept.
async function syncDirectory() {
  const [ps, ds] = await Promise.all([db.collection('profiles').get(), db.collection('loginDirectory').get()]);
  const want = new Map(ps.docs.filter(d => d.data().displayName).map(d => [d.id, d.data().displayName]));
  const have = new Map(ds.docs.map(d => [d.id, d.data().displayName]));
  const batch = db.batch();
  let changes = 0;
  want.forEach((name, id) => {
    if (have.get(id) !== name) { batch.set(db.collection('loginDirectory').doc(id), { displayName: name }, { merge: true }); changes++; }
  });
  have.forEach((_, id) => {
    if (!want.has(id)) { batch.delete(db.collection('loginDirectory').doc(id)); changes++; }
  });
  if (changes) await batch.commit();
  return changes;
}

async function syncNamesClicked() {
  say('empNote', 'Updating the sign-in list…');
  try {
    const n = await syncDirectory();
    say('empNote', n ? `Sign-in list updated (${n} changes).` : 'Sign-in list is already up to date.', 'ok');
  } catch (err) {
    say('empNote', 'Could not update the sign-in list: ' + (err.code || err.message), 'error');
    reportError(err, 'Sign-in list');
  }
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
    const settingsRef = db.doc('settings/company');
    if ((await settingsRef.get()).exists) {
      log('settings/company already exists – kept as it is', 'skip');
    } else {
      await settingsRef.set({
        ...S.company,
        shutdowns: [
          { label: 'Christmas shutdown 2026–2027', start: '', end: '' },
          { label: 'Christmas shutdown 2027–2028', start: S.company.shutdownStart, end: S.company.shutdownEnd }
        ],
        updatedAt: TS()
      });
      log('✓ settings/company written');
    }

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

    await syncDirectory();
    log('✓ loginDirectory: sign-in dropdown list written');

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
   Employee page – balance, request form (with birthday day), history
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
  const rota = await getRotaSafe(set);
  const year = Number(set.holidayYearStart.slice(0, 4));
  $('hello').textContent = 'Hello, ' + e.displayName;
  $('employee').value = e.displayName;
  $('yearInfo').textContent = `Holiday year ${dateGB(set.holidayYearStart)} – ${dateGB(set.holidayYearEnd)} · ${e.team}`;

  const [rq, lg, bd] = await Promise.all([
    db.collection('holidayRequests').where('userId', '==', s.user.uid).get(),
    db.collection('holidayLog').where('userId', '==', s.user.uid).get(),
    db.collection('birthdayUse').where('userId', '==', s.user.uid).get()
  ]);
  const reqs = rq.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => String(y.startDate || '').localeCompare(String(x.startDate || '')));
  const logs = lg.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
  const birthdayUsed = bd.docs.map(d => d.data()).find(b => b.year === year);
  const t = summarise(e, reqs, logs, set, rota);

  $('tiles').innerHTML = `
    <div class="tile primary"><div class="label">Available to book</div><div class="value">${fmt(t.available)}</div></div>
    <div class="tile"><div class="label">Total entitlement</div><div class="value">${fmt(t.total)}</div></div>
    <div class="tile"><div class="label">Used (incl. shutdown)</div><div class="value">${fmt(t.used)}</div></div>
    <div class="tile"><div class="label">Awaiting approval</div><div class="value">${fmt(t.pending)}</div></div>
    <div class="tile"><div class="label">Company shutdown</div><div class="value">${fmt(t.shutdown)}</div></div>`;
  $('breakdown').textContent = `Entitlement = annual allowance ${fmt(e.allowanceDays)} + carryover ${fmt(e.carryoverDays)} + bank holiday accrual ${fmt(e.accrualDays)} + long service ${fmt(e.longServiceDays)}. Used = ${fmt(t.booked)} booked + ${fmt(t.shutdown)} company shutdown. Sick days recorded: ${fmt(t.sickDays)} · Bradford Factor: ${fmt(t.bradford)}.`;

  $('rows').innerHTML = reqs.length ? reqs.map(x => `
    <tr>
      <td>${esc(dateGB(x.startDate))}${x.endDate !== x.startDate ? ' – ' + esc(dateGB(x.endDate)) : ''} ${x.session === 'AM' || x.session === 'PM' ? esc(x.session) : ''}</td>
      <td>${fmt(x.days)}${x.birthday ? ' <small>(incl. birthday day)</small>' : ''}</td>
      <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td>
      <td>${esc(x.reason)}${x.adminNote ? ` <small>(${esc(x.adminNote)})</small>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">No requests yet.</td></tr>';

  $('logRows').innerHTML = logs.length ? logs.map(x => `
    <tr><td>${esc(dateGB(x.date))}</td><td>${esc(x.leaveType)}</td><td>${fmt(x.days)}</td><td>${esc(x.notes)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nothing recorded.</td></tr>';

  /* birthday day: once per holiday year, greyed out when used */
  const cb = $('birthday');
  cb.checked = false;
  if (birthdayUsed) {
    const used = reqs.find(x => x.id === birthdayUsed.requestId);
    cb.disabled = true;
    $('birthdayLabel').classList.add('disabled');
    say('birthdayNote', `Your ${year} birthday day has already been used${used ? ' (' + dateGB(used.startDate) + ')' : ''}.`);
  } else {
    cb.disabled = false;
    $('birthdayLabel').classList.remove('disabled');
    say('birthdayNote', `Once a year. It is an extra day, so it does not come off your allowance.`);
  }

  const calc = () => {
    const a = $('start').value, k = $('kind').value;
    const b = k === 'FULL' ? $('end').value : a;
    if (k !== 'FULL') $('end').value = a;
    const days = !a || !b || b < a ? 0 : k === 'FULL' ? leaveDays(a, b, e.team, rota, set) : (isLeaveDay(a, e.team, rota, set) ? 0.5 : 0);
    return { a, b, k, days, deduct: days - (cb.checked ? 1 : 0) };
  };

  const preview = () => {
    const c = calc();
    if (!c.a || !$('end').value) return say('preview', '');
    if (!c.days) return say('preview', 'No bookable days in that range (weekend, bank holiday, company shutdown or your rest day).');
    say('preview', cb.checked
      ? `${fmt(c.days)} day(s) requested; the birthday day covers 1, so ${fmt(Math.max(c.deduct, 0))} day(s) come off your allowance.`
      : `This will use ${fmt(c.days)} day(s) of your allowance.`);
  };
  ['start', 'end', 'kind', 'birthday'].forEach(id => { $(id).onchange = preview; });

  $('request').onsubmit = async ev => {
    ev.preventDefault();
    const c = calc();
    if (!c.a || !c.b || c.b < c.a) return say('note', 'Check your dates.', 'error');
    if (c.a < set.holidayYearStart || c.b > set.holidayYearEnd) return say('note', `Requests are currently open for ${dateGB(set.holidayYearStart)} – ${dateGB(set.holidayYearEnd)} only.`, 'error');
    if (c.days <= 0) return say('note', 'No bookable days in that range.', 'error');
    if (cb.checked && (c.k !== 'FULL' || c.days < 1)) return say('note', 'Your birthday day must be part of a full-day request.', 'error');
    if (c.deduct > t.available) return say('note', `Not enough allowance (${fmt(t.available)} days available).`, 'error');
    const clash = reqs.some(r => r.status !== 'rejected' && r.startDate <= c.b && r.endDate >= c.a && (r.session === 'FULL' || c.k === 'FULL' || r.session === c.k));
    if (clash) return say('note', 'You already have a request covering those dates.', 'error');

    try {
      const ref = db.collection('holidayRequests').doc();
      const batch = db.batch();
      const data = {
        employeeId: e.id, userId: s.user.uid, startDate: c.a, endDate: c.b, days: c.days, deduct: c.deduct,
        session: c.k, birthday: cb.checked, reason: $('reason').value.trim(), status: 'pending', createdAt: TS()
      };
      if (cb.checked) {
        data.birthdayKey = `${s.user.uid}_${year}`;
        batch.set(db.collection('birthdayUse').doc(data.birthdayKey), { userId: s.user.uid, employeeId: e.id, year, requestId: ref.id, createdAt: TS() });
      }
      batch.set(ref, data);
      // Minimal public record for the shared calendar (initials + dates only)
      batch.set(db.collection('calendarEntries').doc(ref.id), { employeeId: e.id, initials: e.initials, startDate: c.a, endDate: c.b, session: c.k, status: 'pending' });
      await batch.commit();
      $('request').reset();
      $('employee').value = e.displayName;
      say('note', 'Request sent for approval.', 'ok');
      initEmployee();
    } catch (err) { say('note', err.message, 'error'); }
  };
}

/* ==========================================================================
   Admin – approval queue + calendar
   ========================================================================== */

let NAMES = {};

async function initAdmin() {
  const s = await guard({ admin: true });
  if (!s) return;
  await setupCalendar();
  await loadQueue();
  draw();
}

async function loadQueue() {
  try {
    const [rs, es, cs] = await Promise.all([
      db.collection('holidayRequests').where('status', '==', 'pending').get(),
      db.collection('employees').get(),
      db.collection('calendarEntries').get()
    ]);
    const emp = Object.fromEntries(es.docs.map(d => [d.id, normEmp(d.id, d.data())]));
    NAMES = Object.fromEntries(Object.values(emp).filter(x => x.hasName).map(x => [x.id, x.displayName]));
    const entries = cs.docs.map(d => ({ id: d.id, ...d.data() }));
    const rows = rs.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => String(x.startDate || '').localeCompare(String(y.startDate || '')));

    $('pending').innerHTML = rows.length ? rows.map(x => {
      const others = entries.filter(en => en.id !== x.id && en.startDate <= x.endDate && en.endDate >= x.startDate)
        .map(en => `${esc(NAMES[en.employeeId] || en.initials)}${en.status === 'pending' ? ' <small>(pending)</small>' : ''}`);
      return `
      <tr>
        <td>${esc(emp[x.employeeId]?.displayName || 'Unknown')}<br><small>${esc(emp[x.employeeId]?.team || '')}</small></td>
        <td>
          <button type="button" class="linkbtn" data-action="cal-goto" data-date="${esc(x.startDate)}">${esc(dateGB(x.startDate))}${x.endDate !== x.startDate ? ' – ' + esc(dateGB(x.endDate)) : ''}</button>
          ${x.session !== 'FULL' ? esc(x.session) : ''}
        </td>
        <td>${fmt(x.days)}${x.birthday ? '<br><small>incl. birthday day</small>' : ''}</td>
        <td>${esc(x.reason)}</td>
        <td>${others.length ? others.join('<br>') : '<small>Nobody else</small>'}</td>
        <td>
          <button type="button" class="small" data-action="approve" data-id="${esc(x.id)}">Approve</button>
          <button type="button" class="small red" data-action="reject" data-id="${esc(x.id)}">Reject</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">Nothing waiting for approval.</td></tr>';
  } catch (err) {
    $('pending').innerHTML = `<tr><td colspan="6" class="note--error">Could not load the queue: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Approval queue');
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
    const reqSnap = await db.collection('holidayRequests').doc(id).get();
    const req = reqSnap.data() || {};
    const batch = db.batch();
    batch.update(db.collection('holidayRequests').doc(id), upd);
    const cal = db.collection('calendarEntries').doc(id);
    if (status === 'approved') batch.update(cal, { status: 'approved' }); else batch.delete(cal);
    // A rejected request frees the employee's birthday day again
    if (status === 'rejected' && req.birthdayKey) batch.delete(db.collection('birthdayUse').doc(req.birthdayKey));
    await batch.commit();
    say('note', 'Request ' + status + '.', 'ok');
  } catch (err) { say('note', err.message, 'error'); }
  await loadQueue();
  draw();
}

/* ==========================================================================
   Admin – employees (editable table, Christmas shutdown dates)
   ========================================================================== */

let EMPS = [];

async function initEmployees() {
  const s = await guard({ admin: true });
  if (!s) return;
  const set = await getSettings();
  window._me = s.user.uid;
  $('eteam').innerHTML = set.teams.map(t => `<option>${esc(t)}</option>`).join('');
  $('newEmp').onsubmit = addEmployee;
  $('shutdownForm').onsubmit = saveShutdowns;
  ['s1start', 's1end', 's2start', 's2end'].forEach(id => { $(id).onchange = previewShutdown; });
  $('emps').addEventListener('input', onCellEdit);
  $('emps').addEventListener('change', onCellEdit);
  await safeRender();
}

function fillShutdownForm(set) {
  const [a, b] = getShutdowns(set);
  $('s1label').textContent = a.label;
  $('s2label').textContent = b.label;
  $('s1start').value = a.start || ''; $('s1end').value = a.end || '';
  $('s2start').value = b.start || ''; $('s2end').value = b.end || '';
}

function shutdownFromForm(set) {
  const [a, b] = getShutdowns(set);
  return [
    { label: a.label, start: $('s1start').value, end: $('s1end').value },
    { label: b.label, start: $('s2start').value, end: $('s2end').value }
  ];
}

let ROTA_CACHE = {};

function previewShutdown() {
  const set = { ...(_settings || DEFAULT_SETTINGS), shutdowns: shutdownFromForm(_settings || DEFAULT_SETTINGS) };
  const per = team => shutdownDays(team, set, ROTA_CACHE);
  say('shutdownInfo', `Days taken off the ${set.holidayYearStart.slice(0, 4)} allowance: 5-Day Week ${fmt(per('5-Day Week'))}, Team 1 ${fmt(per('Team 1'))}, Team 2 ${fmt(per('Team 2'))} (weekends, bank holidays and rest days are not counted).`);
}

async function saveShutdowns(ev) {
  ev.preventDefault();
  const set = await getSettings();
  const list = shutdownFromForm(set);
  for (const s of list) {
    if (!!s.start !== !!s.end) return say('shutdownNote', `${s.label}: enter both a start and an end date, or leave both blank.`, 'error');
    if (s.start && s.end < s.start) return say('shutdownNote', `${s.label}: the end date is before the start date.`, 'error');
  }
  try {
    await db.doc('settings/company').set({ shutdowns: list, updatedAt: TS() }, { merge: true });
    _settings = null;
    say('shutdownNote', 'Shutdown dates saved. Every employee’s balance now includes them.', 'ok');
  } catch (err) { say('shutdownNote', err.message, 'error'); reportError(err, 'Saving shutdown dates'); return; }
  await safeRender();
}

// Wraps renderEmployees so a failure shows a message instead of leaving "Loading employees…" forever
async function safeRender() {
  try { await renderEmployees(); }
  catch (err) {
    $('emps').innerHTML = `<tr><td colspan="16" class="note--error">Could not show the employees: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Employees table');
  }
}

async function removeEmployee(id) {
  if (!confirm('Remove this employee record? This only deletes the record shown here (it has no name), not a sign-in account.')) return;
  try { await db.collection('employees').doc(id).delete(); await safeRender(); }
  catch (err) { reportError(err, 'Removing the record'); }
}

async function renderEmployees() {
  const set = await getSettings();
  let es, rs, ls, ps, bs;
  try {
    [es, rs, ls, ps, bs] = await Promise.all([
      db.collection('employees').get(),
      db.collection('holidayRequests').get(),
      db.collection('holidayLog').get(),
      db.collection('profiles').get(),
      db.collection('birthdayUse').get()
    ]);
  } catch (err) {
    $('emps').innerHTML = `<tr><td colspan="16" class="note--error">Could not load employees: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Employees');
    return;
  }
  const rota = await getRotaSafe(set);
  ROTA_CACHE = rota;
  fillShutdownForm(set);
  previewShutdown();

  EMPS = es.docs.map(d => normEmp(d.id, d.data())).sort(byName);
  const reqs = rs.docs.map(d => d.data());
  const logs = ls.docs.map(d => d.data());
  const roles = Object.fromEntries(ps.docs.map(d => [d.id, d.data().role]));
  const year = Number(set.holidayYearStart.slice(0, 4));
  const birthdayUsers = new Set(bs.docs.map(d => d.data()).filter(b => b.year === year).map(b => b.userId));
  const num = (field, v) => `<td><input class="cell num" type="number" step="0.5" min="0" data-field="${field}" value="${esc(v)}" aria-label="${field}"></td>`;

  const unnamed = EMPS.filter(x => !x.hasName).length;
  $('empCount').textContent = `${EMPS.length} records` + (unnamed ? ` · ${unnamed} without a name` : '');
  $('emps').innerHTML = EMPS.map(x => {
    const t = summarise(x, reqs.filter(r => r.employeeId === x.id), logs.filter(l => l.employeeId === x.id), set, rota);
    const role = roles[x.userId] || 'employee';
    const self = x.userId === window._me;
    return `
      <tr data-id="${esc(x.id)}">
        <td>${x.hasName ? `<b>${esc(x.displayName)}</b> <small>${esc(x.initials)}</small>` : `<b class="note--error">(no name)</b> <small>${esc(x.id)}</small>`}${role === 'admin' ? ' <span class="pill admin">admin</span>' : ''}</td>
        <td><select class="cell" data-field="team" aria-label="Team">${set.teams.map(tm => `<option${tm === x.team ? ' selected' : ''}>${esc(tm)}</option>`).join('')}</select></td>
        <td><input class="cell" data-field="department" value="${esc(x.department)}" aria-label="Department"></td>
        <td><input class="cell" type="date" data-field="startDate" value="${esc(x.startDate)}" aria-label="Start date"></td>
        ${num('allowanceDays', x.allowanceDays)}
        ${num('carryoverDays', x.carryoverDays)}
        ${num('accrualDays', x.accrualDays)}
        ${num('longServiceDays', x.longServiceDays)}
        <td class="num"><b>${fmt(t.total)}</b></td>
        <td class="num">${fmt(t.shutdown)}</td>
        <td class="num">${fmt(t.used)}</td>
        <td class="num"><b>${fmt(t.available)}</b></td>
        <td class="num">${fmt(t.sickDays)}</td>
        <td class="num ${bfClass(t.bradford)}">${fmt(t.bradford)}</td>
        <td>${birthdayUsers.has(x.userId) ? 'Used' : '–'}</td>
        <td>
          <button type="button" class="small ghost" data-action="role-toggle" data-uid="${esc(x.userId)}" data-role="${role === 'admin' ? 'employee' : 'admin'}"${self || !x.userId ? ' disabled' : ''}>${role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
          ${x.hasName ? '' : `<button type="button" class="small red" data-action="emp-remove" data-id="${esc(x.id)}">Remove record</button>`}
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="16" class="empty">No employees found in the employees collection.</td></tr>';
  updateSaveBar();
}

function dirtyRows() { return Array.from($('emps').querySelectorAll('tr.dirty')); }

function updateSaveBar() {
  const n = dirtyRows().length;
  $('saveAll').disabled = n === 0;
  say('empNote', n ? `${n} unsaved ${n === 1 ? 'change' : 'changes'}.` : '');
}

// Editing the team or start date refills the figures the workbook calculated from them
function onCellEdit(ev) {
  const el = ev.target.closest('[data-field]');
  const row = ev.target.closest('tr[data-id]');
  if (!el || !row) return;
  const set = _settings || DEFAULT_SETTINGS;
  const field = el.dataset.field;
  const get = f => row.querySelector(`[data-field="${f}"]`);
  if (ev.type === 'change' && field === 'startDate') get('longServiceDays').value = longServiceDays(el.value, set);
  if (ev.type === 'change' && field === 'team') {
    const d = defaultsFor(el.value, get('startDate').value, set);
    get('allowanceDays').value = d.allowanceDays;
    get('accrualDays').value = d.accrualDays;
  }
  row.classList.add('dirty');
  updateSaveBar();
}

async function saveEmployees() {
  const rows = dirtyRows();
  if (!rows.length) return;
  const batch = db.batch();
  for (const row of rows) {
    const v = f => row.querySelector(`[data-field="${f}"]`).value;
    const nums = ['allowanceDays', 'carryoverDays', 'accrualDays', 'longServiceDays'];
    const upd = { department: v('department').trim(), team: v('team'), startDate: v('startDate') || null };
    for (const f of nums) {
      const n = parseFloat(v(f));
      if (Number.isNaN(n) || n < 0) return say('empNote', 'Allowance figures must be numbers of 0 or more.', 'error');
      upd[f] = n;
    }
    batch.update(db.collection('employees').doc(row.dataset.id), upd);
  }
  $('saveAll').disabled = true;
  say('empNote', 'Saving…');
  try {
    await batch.commit();
    await safeRender();
    say('empNote', `Saved ${rows.length} ${rows.length === 1 ? 'employee' : 'employees'}.`, 'ok');
  } catch (err) {
    $('saveAll').disabled = false;
    say('empNote', 'Could not save: ' + (err.code || err.message), 'error');
    reportError(err, 'Saving employees');
  }
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
    batch.set(db.collection('loginDirectory').doc(uid), { displayName: name, emailLogin: !!$('eemail').value.trim() });
    await batch.commit();
    say('addNote', `Created ${name}. Login: ${email}`, 'ok');
    $('newEmp').reset();
    $('epw').value = DEFAULT_PW;
    safeRender();
  } catch (err) { say('addNote', err.message, 'error'); }
  finally { try { await sec.auth().signOut(); await sec.delete(); } catch (_) { /* ignore */ } }
}

async function toggleRole(uid, role) {
  if (!uid || !confirm(`Change this account to "${role}"?`)) return;
  try { await db.collection('profiles').doc(uid).update({ role }); await safeRender(); }
  catch (err) { reportError(err, 'Changing role'); }
}

/* ==========================================================================
   Admin – holiday log (the Excel "Holiday Log" quick-entry sheet)
   ========================================================================== */

let LOGS = [];

async function initLog() {
  const s = await guard({ admin: true });
  if (!s) return;
  const set = await getSettings();
  $('ltype').innerHTML = set.leaveTypes.map(t => `<option>${esc(t)}</option>`).join('');
  $('lfilter').onchange = renderLog;
  $('logForm').onsubmit = addLog;

  try {
    const es = await db.collection('employees').get();
    EMPS = es.docs.map(d => normEmp(d.id, d.data())).filter(x => x.hasName).sort(byName);
  } catch (err) {
    reportError(err, 'Could not load the employee list');
    $('lemp').innerHTML = '<option value="">Employees could not be loaded</option>';
    return;
  }
  const opts = EMPS.map(x => `<option value="${esc(x.id)}">${esc(x.displayName)}</option>`).join('');
  $('lemp').innerHTML = opts || '<option value="">No employees found</option>';
  $('lfilter').innerHTML = '<option value="">All employees</option>' + opts;
  await loadLog();
}

async function loadLog() {
  try {
    const snap = await db.collection('holidayLog').get();
    LOGS = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    renderLog();
  } catch (err) {
    $('logRows').innerHTML = `<tr><td colspan="6" class="note--error">Could not load the log: ${esc(err.message)}</td></tr>`;
    reportError(err, 'Holiday log');
  }
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
   Calendar – approved/pending leave + the rota + shutdown (also used on the approvals page)
   ========================================================================== */

let monthDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

async function setupCalendar() {
  const set = await getSettings();
  const today = iso(new Date());
  if (today < set.holidayYearStart || today > set.holidayYearEnd) {
    const [y, m] = set.holidayYearStart.split('-').map(Number);
    monthDate = new Date(y, m - 1, 1);
  }
}

async function initCalendar() {
  const s = await guard();
  if (!s) return;
  await setupCalendar();
  try {
    const bh = await db.collection('bankHolidays').orderBy(firebase.firestore.FieldPath.documentId()).get();
    $('bhRows').innerHTML = bh.docs.map(d => `<tr><td>${esc(dateGB(d.id))}</td><td>${esc(d.data().name)}</td></tr>`).join('')
      || '<tr><td colspan="2" class="empty">None loaded.</td></tr>';
  } catch (err) { reportError(err, 'Bank holidays'); }
  draw();
}

function changeMonth(n) { monthDate.setMonth(monthDate.getMonth() + n); draw(); }

function gotoMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  monthDate = new Date(y, m - 1, 1);
  draw();
  $('grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function draw() {
  const set = await getSettings();
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
  } catch (err) { say('calnote', 'Could not load the calendar: ' + (err.code || err.message), 'error'); }

  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="head">${x}</div>`).join('');
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) html += '<div class="day blank"></div>';

  for (let d = 1; d <= last.getDate(); d++) {
    const k = iso(new Date(y, m, d)), r = rota[k] || {};
    const shut = inShutdown(k, set);
    const cls = ['day', isWeekend(k) ? 'off' : '', r.bankHoliday ? 'bank' : '', shut ? 'shut' : ''].filter(Boolean).join(' ');

    let tags = '';
    if (!isWeekend(k) && !r.bankHoliday && !shut) {
      if (r.team1Off) tags += '<span class="tag t1">T1 off</span>';
      if (r.team2Off) tags += '<span class="tag t2">T2 off</span>';
    }
    if (r.bankHoliday && r.team1Accrued) tags += '<span class="tag accrue">+1 T1</span>';
    if (r.bankHoliday && r.team2Accrued) tags += '<span class="tag accrue">+1 T2</span>';
    if (shut) tags += '<span class="tag">Shutdown</span>';

    const chips = entries.filter(x => x.startDate <= k && x.endDate >= k)
      .map(x => `<span class="chip ${esc(x.status)}" title="${esc(NAMES[x.employeeId] || x.initials)}">${esc(x.initials)}${x.session !== 'FULL' ? ' ' + esc(x.session) : ''}</span>`).join('');

    html += `<div class="${cls}"><b>${d}</b>${r.bankHoliday ? `<small>${esc(r.label)}</small>` : ''}<div>${tags}</div><div>${chips}</div></div>`;
  }
  $('grid').innerHTML = html;
}

/* ---------- start ---------- */

const EXPECTED_PAGE = {
  'index.html': 'login', 'change-password.html': 'change', 'employee.html': 'employee',
  'calendar.html': 'calendar', 'admin.html': 'admin', 'employees.html': 'employees', 'holiday-log.html': 'log'
};

function fileMismatch() {
  const file = location.pathname.split('/').pop() || 'index.html';
  if (!EXPECTED_PAGE[file] || EXPECTED_PAGE[file] === page) return false;
  const bar = document.createElement('div');
  bar.className = 'banner';
  bar.textContent = `Wrong page content: ${file} should contain the "${EXPECTED_PAGE[file]}" page but contains "${page || 'unknown'}". Re-upload the correct ${file} from the project folder.`;
  document.body.prepend(bar);
  return true;
}

const INIT = { login: initLogin, change: initChange, employee: initEmployee, admin: initAdmin, employees: initEmployees, log: initLog, calendar: initCalendar };
if (!fileMismatch() && INIT[page]) INIT[page]();
