/* Holiday Tracker – Firebase (Auth + Firestore, compat SDK) */
const auth = firebase.auth();
const db = firebase.firestore();
const TS = () => firebase.firestore.FieldValue.serverTimestamp();

const $ = id => document.getElementById(id);
const say = (id, t) => { if ($(id)) $(id).textContent = t; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// "Connor Dennison" -> connor.dennison@holiday.company.invalid ; a real email address is used as typed
const nameToMail = n => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '@holiday.company.invalid';
const loginEmail = v => v.includes('@') ? v.trim().toLowerCase() : nameToMail(v);

/* ---------- auth ---------- */
async function signIn(e) {
  e.preventDefault();
  say('message', '');
  try {
    const cred = await auth.signInWithEmailAndPassword(loginEmail($('name').value), $('pw').value);
    const snap = await db.collection('profiles').doc(cred.user.uid).get();
    if (!snap.exists) { await auth.signOut(); return say('message', 'Account not set up yet. Contact an administrator.'); }
    const p = snap.data();
    if (p.mustChangePassword) return (location.href = 'change-password.html');
    location.href = p.role === 'admin' ? 'admin.html' : 'employee.html';
  } catch (err) {
    say('message', err.code === 'auth/too-many-requests' ? 'Too many attempts. Try again later.' : 'Name or password not recognised.');
  }
}

async function resetPw() {
  const v = $('name').value;
  if (!v.includes('@')) return say('message', 'Password email reset needs your email address in the Name box. Otherwise contact an administrator.');
  try { await auth.sendPasswordResetEmail(v.trim()); say('message', 'If that account exists, a reset email has been sent.'); }
  catch (e) { say('message', 'If that account exists, a reset email has been sent.'); }
}

function currentUser() {
  return new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}

async function guard() {
  const user = await currentUser();
  if (!user) { location.href = 'index.html'; return; }
  const snap = await db.collection('profiles').doc(user.uid).get();
  if (!snap.exists) { await auth.signOut(); location.href = 'index.html'; return; }
  const p = snap.data();
  if (p.mustChangePassword && !location.pathname.endsWith('change-password.html')) { location.href = 'change-password.html'; return; }
  return { user, p };
}

async function logout() { await auth.signOut(); location.href = 'index.html'; }

async function loadChangePassword() {
  const s = await guard();
  if (!s) return;
  $('change').onsubmit = async ev => {
    ev.preventDefault();
    const a = $('pw1').value, b = $('pw2').value;
    if (a.length < 10) return say('message', 'Use at least 10 characters.');
    if (a !== b) return say('message', 'Passwords do not match.');
    try {
      await s.user.updatePassword(a);
      await db.collection('profiles').doc(s.user.uid).update({ mustChangePassword: false });
      location.href = s.p.role === 'admin' ? 'admin.html' : 'employee.html';
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') { await auth.signOut(); location.href = 'index.html'; }
      else say('message', err.message);
    }
  };
}

/* ---------- employee ---------- */
function weekdays(a, b) {
  let d = new Date(a + 'T12:00:00'), z = new Date(b + 'T12:00:00'), n = 0;
  while (d <= z) { if (d.getDay() % 6) n++; d.setDate(d.getDate() + 1); }
  return n;
}

async function loadEmployee() {
  const s = await guard();
  if (!s) return;
  if (s.p.role === 'admin') { location.href = 'admin.html'; return; }

  const q = await db.collection('employees').where('userId', '==', s.user.uid).limit(1).get();
  if (q.empty) { alert('Employee record not linked. Ask an administrator.'); return; }
  const e = { id: q.docs[0].id, ...q.docs[0].data() };
  say('hello', 'Hello, ' + e.displayName);
  $('employee').value = e.displayName;

  const snap = await db.collection('holidayRequests').where('userId', '==', s.user.uid).get();
  const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => y.startDate.localeCompare(x.startDate));
  const sum = st => reqs.filter(r => r.status === st).reduce((t, r) => t + r.days, 0);
  const total = e.allowanceDays + e.carryoverDays + e.accrualDays + e.longServiceDays;
  const available = total - sum('approved') - sum('pending');
  say('balance', available.toFixed(1));
  say('balanceNote', `Total ${total.toFixed(1)} · approved ${sum('approved').toFixed(1)} · awaiting approval ${sum('pending').toFixed(1)}`);

  $('rows').innerHTML = reqs.map(x => `<tr><td>${esc(x.startDate)} – ${esc(x.endDate)} ${x.session === 'AM' ? 'AM' : x.session === 'PM' ? 'PM' : ''}</td><td>${x.days}</td><td>${esc(x.status)}</td><td>${esc(x.reason)}${x.adminNote ? ' <small>(' + esc(x.adminNote) + ')</small>' : ''}</td></tr>`).join('');

  $('request').onsubmit = async ev => {
    ev.preventDefault();
    const a = $('start').value, b = $('end').value, k = $('kind').value;
    if (!a || !b || b < a || (k !== 'FULL' && a !== b)) return say('note', 'Check dates (half days must be one date).');
    const days = k === 'FULL' ? weekdays(a, b) : 0.5;
    if (days <= 0) return say('note', 'No working days in that range.');
    if (days > available) return say('note', `Not enough balance (${available.toFixed(1)} days available).`);
    const clash = reqs.some(r => r.status !== 'rejected' && r.startDate <= b && r.endDate >= a && (r.session === 'FULL' || k === 'FULL' || r.session === k));
    if (clash) return say('note', 'You already have a request covering those dates.');

    try {
      const ref = db.collection('holidayRequests').doc();
      const batch = db.batch();
      batch.set(ref, { employeeId: e.id, userId: s.user.uid, startDate: a, endDate: b, days, session: k, reason: $('reason').value.trim(), status: 'pending', createdAt: TS() });
      // Minimal public record for the shared calendar (initials + dates only)
      batch.set(db.collection('calendarEntries').doc(ref.id), { employeeId: e.id, initials: e.initials, startDate: a, endDate: b, session: k, status: 'pending' });
      await batch.commit();
      $('request').reset();
      say('note', 'Request sent for approval.');
      loadEmployee();
    } catch (err) { say('note', err.message); }
  };
}

/* ---------- admin ---------- */
async function loadAdmin() {
  const s = await guard();
  if (!s) return;
  if (s.p.role !== 'admin') { location.href = 'employee.html'; return; }
  try {
    const [rs, es] = await Promise.all([
      db.collection('holidayRequests').where('status', '==', 'pending').get(),
      db.collection('employees').get()
    ]);
    const names = Object.fromEntries(es.docs.map(d => [d.id, d.data().displayName]));
    const rows = rs.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => x.startDate.localeCompare(y.startDate));
    $('pending').innerHTML = rows.length ? rows.map(x => `<tr><td>${esc(names[x.employeeId] || 'Unknown')}</td><td>${esc(x.startDate)} – ${esc(x.endDate)} ${x.session !== 'FULL' ? x.session : ''}</td><td>${x.days}</td><td>${esc(x.reason)}</td><td><button onclick="review('${x.id}','approved')">Approve</button> <button class="red" onclick="review('${x.id}','rejected')">Reject</button></td></tr>`).join('') : '<tr><td colspan="5">Nothing waiting for approval.</td></tr>';
  } catch (err) { $('pending').innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`; }
}

async function review(id, status) {
  const user = auth.currentUser;
  const upd = { status, reviewedAt: TS(), reviewedBy: user.uid };
  if (status === 'rejected') { const n = prompt('Reason (optional):'); if (n === null) return; if (n.trim()) upd.adminNote = n.trim(); }
  try {
    const batch = db.batch();
    batch.update(db.collection('holidayRequests').doc(id), upd);
    const cal = db.collection('calendarEntries').doc(id);
    if (status === 'approved') batch.update(cal, { status: 'approved' }); else batch.delete(cal);
    await batch.commit();
    say('note', 'Request ' + status);
  } catch (err) { say('note', err.message); }
  loadAdmin();
}

/* ---------- admin: employees ---------- */
async function loadEmployees() {
  const s = await guard();
  if (!s) return;
  if (s.p.role !== 'admin') { location.href = 'employee.html'; return; }
  $('newEmp').onsubmit = addEmployee;
  const snap = await db.collection('employees').get();
  const list = snap.docs.map(d => d.data()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  $('emps').innerHTML = list.map(x => `<tr><td>${esc(x.displayName)}</td><td>${esc(x.initials)}</td><td>${esc(x.team)}</td><td>${x.allowanceDays}</td><td>${x.carryoverDays}</td><td>${x.accrualDays}</td><td>${x.longServiceDays}</td></tr>`).join('');
}

async function addEmployee(ev) {
  ev.preventDefault();
  const name = $('ename').value.trim(), pw = $('epw').value;
  if (pw.length < 10) return say('note', 'Temporary password needs at least 10 characters.');
  const email = $('eemail').value.trim() ? $('eemail').value.trim().toLowerCase() : nameToMail(name);
  const initials = name.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  const num = id => parseFloat($(id).value) || 0;
  // A second app instance creates the Auth user so the admin stays signed in
  const sec = firebase.initializeApp(firebase.app().options, 'secondary' + Date.now());
  try {
    const cred = await sec.auth().createUserWithEmailAndPassword(email, pw);
    const uid = cred.user.uid;
    const batch = db.batch();
    batch.set(db.collection('profiles').doc(uid), { displayName: name, role: $('erole').value, mustChangePassword: true, createdAt: TS() });
    batch.set(db.collection('employees').doc(), {
      userId: uid, displayName: name, initials, department: $('edept').value.trim(), team: $('eteam').value,
      startDate: $('estart').value || null, allowanceDays: num('eallow'), carryoverDays: num('ecarry'),
      accrualDays: num('eaccr'), longServiceDays: num('elong'), active: true
    });
    await batch.commit();
    say('note', `Created ${name}. Login: ${email}`);
    $('newEmp').reset();
    loadEmployees();
  } catch (err) { say('note', err.message); }
  finally { try { await sec.auth().signOut(); await sec.delete(); } catch (_) {} }
}

/* ---------- calendar ---------- */
let monthDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
function month(n) { monthDate.setMonth(monthDate.getMonth() + n); draw(); }
async function loadCalendar() { const s = await guard(); if (!s) return; draw(); }

async function draw() {
  if (!$('grid')) return;
  const y = monthDate.getFullYear(), m = monthDate.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const fIso = iso(first), lIso = iso(last);
  $('month').textContent = monthDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  let entries = [], rota = {};
  try {
    const [es, rs] = await Promise.all([
      db.collection('calendarEntries').where('startDate', '<=', lIso).get(),
      db.collection('rotaDays').orderBy(firebase.firestore.FieldPath.documentId()).startAt(fIso).endAt(lIso).get()
    ]);
    entries = es.docs.map(d => d.data()).filter(x => x.endDate >= fIso);
    rs.docs.forEach(d => { rota[d.id] = d.data(); });
  } catch (err) { say('calnote', err.message); }

  let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="head">${x}</div>`).join('');
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) h += '<div></div>';
  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(y, m, d), k = iso(dt), r = rota[k] || {};
    const cls = ['day', dt.getDay() % 6 ? '' : 'off', r.bank_holiday || r.bankHoliday ? 'bank' : '', r.company_shutdown || r.companyShutdown ? 'shut' : ''].join(' ');
    const chips = entries.filter(x => x.startDate <= k && x.endDate >= k)
      .map(x => `<span class="chip ${x.status}">${esc(x.initials)}${x.session !== 'FULL' ? ' ' + x.session : ''}</span>`).join('');
    h += `<div class="${cls}"><b>${d}</b>${r.label ? `<small>${esc(r.label)}</small>` : ''}${chips}</div>`;
  }
  $('grid').innerHTML = h;
}
