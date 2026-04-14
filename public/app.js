'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// STATE & CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const STATUS_COLOR = {
  present:  '#10B981',
  absent:   '#EF4444',
  on_leave: '#F59E0B',
  half_day: '#3B82F6',
};

let state = {
  user:          null,
  token:         null,
  view:          'login',
  calendarDate:  new Date(),
  calendarMode:  'month',   // 'month' | 'week'
  calendarData:  {},        // { 'YYYY-MM-DD': [attendance records] }
  employees:     [],
  leaves:        [],
  settings:      {},
  dashboard:     {},
  todayRecord:   null,
  timer:         null,
  leavesTab:        'all',  // 'all' | 'mine' | 'late_early' (admin)
  lateEarlyRecords: [],
  leavesFilterDate: null,   // null = no filter; for late_early defaults to today
};

let leaveFormCount       = 0;
let clockifyLiveInterval = null;
let clockifyTimers       = {};

// ══════════════════════════════════════════════════════════════════════════════
// API LAYER
// ══════════════════════════════════════════════════════════════════════════════
async function api(method, endpoint, body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'Authorization': `Bearer ${state.token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + endpoint, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const apiGet    = (ep, qs = {}) => { const q = new URLSearchParams(qs).toString(); return api('GET', ep + (q ? '?' + q : '')); };
const apiPost   = (ep, body)    => api('POST',   ep, body);
const apiPut    = (ep, body)    => api('PUT',    ep, body);
const apiDelete = (ep)          => api('DELETE', ep);

// ══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateRange(s, e) {
  if (s === e) return fmtDate(s);
  return `${fmtDate(s)} – ${fmtDate(e)}`;
}
function fmtTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}
function fmtHours(h) {
  if (h == null || h === 0) return '—';
  const hrs = Math.floor(h);
  const min = Math.round((h - hrs) * 60);
  if (hrs === 0) return `${min}m`;
  return min > 0 ? `${hrs}h ${min}m` : `${hrs}h`;
}
function toISODate(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function todayStr() { return toISODate(new Date()); }
function initials(name = '') { return name.split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase(); }
function avatar(name, color, size = 34) {
  return `<div class="sidebar-avatar" style="width:${size}px;height:${size}px;background:${color||'#4F46E5'};font-size:${size*.33}px">${initials(name)}</div>`;
}
function getDaysInRange(start, end) {
  const days = [];
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end   + 'T12:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) days.push(toISODate(new Date(d)));
  return days;
}
function getWeekDates(date) {
  const d = new Date(date);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7)); // start from Monday
  return Array.from({length: 7}, (_, i) => { const x = new Date(monday); x.setDate(monday.getDate() + i); return x; });
}
function isWeekend(date) { const d = new Date(date); return d.getDay() === 0 || d.getDay() === 6; }
function statusLabel(s) {
  const map = { present:'Present', absent:'Absent', on_leave:'On Leave', half_day:'Half Day' };
  return map[s] || s || '—';
}
const I = k => window.ICONS[k] || '';

// ══════════════════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════════════════
function toast(msg, type = 'success', duration = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  el.innerHTML = `<span style="font-size:1.1rem">${icons[type]||'•'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════════════════════════
function openModal(html, cls = '') {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal ${cls}" id="modal-box">
        ${html}
      </div>
    </div>`;
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}
function closeModal() {
  stopClockifyLive();
  document.getElementById('modal-root').innerHTML = '';
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
function saveAuth(token, user) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('lt_token', token);
  localStorage.setItem('lt_user',  JSON.stringify(user));
}
function loadAuth() {
  const token = localStorage.getItem('lt_token');
  const user  = localStorage.getItem('lt_user');
  if (token && user) { state.token = token; state.user = JSON.parse(user); return true; }
  return false;
}
function logout() {
  state.token = null; state.user = null;
  state.calendarData = {}; state.employees = []; state.leaves = [];
  localStorage.removeItem('lt_token'); localStorage.removeItem('lt_user');
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  navigate('login');
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER ENGINE
// ══════════════════════════════════════════════════════════════════════════════
function navigate(view) {
  state.view = view;
  render();
}

function render() {
  const root = document.getElementById('root');
  if (state.view === 'login') { root.innerHTML = renderLoginPage(); bindLogin(); return; }
  root.innerHTML = renderLayout();
  renderContent();
  bindNav();
}

function renderContent() {
  switch (state.view) {
    case 'dashboard':  loadDashboard();  break;
    case 'calendar':   loadCalendar();   break;
    case 'leaves':     loadLeaves();     break;
    case 'employees':  loadEmployees();  break;
    case 'settings':   loadSettings();   break;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGIN PAGE
// ══════════════════════════════════════════════════════════════════════════════
function renderLoginPage() {
  return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="login-logo-icon">📅</div>
          <div>
            <h1>HR Tracker</h1>
            <p>Leave & Attendance System</p>
          </div>
        </div>
        <div class="login-title">Welcome back</div>
        <div class="login-subtitle">Sign in to your account</div>
        <div class="login-demo">
          <strong>Demo Credentials</strong>
          <p>
            Admin: admin@company.com / admin123<br>
            Employee: alice@company.com / password123
          </p>
        </div>
        <form id="login-form">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input class="form-control" type="email" id="login-email" value="admin@company.com" required />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input class="form-control" type="password" id="login-password" value="admin123" required />
          </div>
          <div id="login-error" style="color:#EF4444;font-size:.83rem;margin-bottom:12px;display:none"></div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="login-btn">
            Sign In
          </button>
        </form>
      </div>
    </div>`;
}
function bindLogin() {
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    btn.disabled = true; btn.textContent = 'Signing in…';
    errEl.style.display = 'none';
    try {
      const { token, user } = await apiPost('/auth/login', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      });
      saveAuth(token, user);
      navigate('dashboard');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYOUT
// ══════════════════════════════════════════════════════════════════════════════
function renderLayout() {
  const u = state.user;
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'calendar',  label: 'Calendar',  icon: 'calendar'  },
    { id: 'leaves',    label: 'Leaves',    icon: 'leave'     },
    ...(u.role === 'admin' ? [{ id: 'employees', label: 'Employees', icon: 'employees' }] : []),
    { id: 'settings',  label: 'Settings',  icon: 'settings'  },
  ];
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  return `
    <div class="app-layout" id="app-layout">
      <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">
            <div class="sidebar-logo-icon">📅</div>
            <div class="sidebar-logo-text">
              <h2>HR Tracker</h2>
              <p>Attendance System</p>
            </div>
          </div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-label">Main</div>
          ${navItems.map(item => `
            <button class="nav-item ${state.view === item.id ? 'active' : ''}" data-view="${item.id}">
              ${I(item.icon)} ${item.label}
            </button>`).join('')}
        </nav>
        <div class="sidebar-user">
          <div class="sidebar-user-info">
            <div class="sidebar-avatar" style="background:${u.avatar_color||'#4F46E5'}">${initials(u.name)}</div>
            <div>
              <div class="sidebar-user-name">${u.name}</div>
              <div class="sidebar-user-role">${u.role === 'admin' ? 'HR Admin' : u.position || 'Employee'}</div>
            </div>
          </div>
          <button class="sidebar-logout" onclick="logout()">
            ${I('logout')} Sign Out
          </button>
        </div>
      </aside>
      <div class="main-area">
        <header class="header">
          <button class="hamburger" id="hamburger" onclick="toggleSidebar()" aria-label="Menu">
            <span></span><span></span><span></span>
          </button>
          <div class="header-title" id="header-title">
            <h1>Dashboard</h1>
          </div>
          <div class="header-spacer"></div>
          <div class="header-date">${dateStr}</div>
          <div class="checkin-widget" id="checkin-widget">
            <div class="loading"><div class="spinner"></div></div>
          </div>
        </header>
        <main class="content-area" id="content">
          <div class="loading"><div class="spinner"></div> Loading…</div>
        </main>
      </div>
    </div>`;
}
function toggleSidebar() {
  document.getElementById('app-layout').classList.toggle('sidebar-open');
}
function closeSidebar() {
  document.getElementById('app-layout').classList.remove('sidebar-open');
}
function bindNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => { closeSidebar(); navigate(btn.dataset.view); });
  });
  loadCheckinWidget();
}
function setHeaderTitle(title, sub = '') {
  document.getElementById('header-title').innerHTML = `<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CHECK-IN WIDGET
// ══════════════════════════════════════════════════════════════════════════════
async function loadCheckinWidget() {
  try {
    const record = await apiGet('/attendance/today');
    state.todayRecord = record;
    renderCheckinWidget(record);
    startWidgetTimer();
  } catch (e) { /* silent */ }
}
function renderCheckinWidget(record) {
  const w = document.getElementById('checkin-widget');
  if (!w) return;
  if (!record || !record.check_in) {
    w.innerHTML = `<button class="btn btn-success btn-sm" onclick="doCheckIn()">${I('clock')} Check In</button>`;
  } else if (!record.check_out) {
    const elapsed = getElapsed(record.check_in);
    w.innerHTML = `
      <div class="checkin-status">
        <div class="checkin-time">${I('clock')} In: ${fmtTime(record.check_in)} <span id="elapsed-time">${elapsed}</span></div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="doCheckOut()">${I('logout')} Check Out</button>`;
  } else {
    w.innerHTML = `
      <div class="checkin-status" style="font-size:.8rem;color:var(--text-muted)">
        ${I('clock')} ${fmtTime(record.check_in)} – ${fmtTime(record.check_out)} · ${fmtHours(record.work_hours)}
        ${record.is_late ? '<span class="status-badge late" style="margin-left:4px">Late</span>' : ''}
        ${record.status === 'half_day' ? '<span class="status-badge half_day" style="margin-left:4px">Half Day</span>' : ''}
      </div>`;
  }
}
function getElapsed(checkInTime) {
  const [h, m] = checkInTime.split(':').map(Number);
  const checkIn = new Date(); checkIn.setHours(h, m, 0, 0);
  const diff = Date.now() - checkIn.getTime();
  const totalMin = Math.floor(diff / 60000);
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return hrs > 0 ? `(${hrs}h ${min}m)` : `(${min}m)`;
}
function startWidgetTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.todayRecord?.check_in && !state.todayRecord?.check_out) {
      const el = document.getElementById('elapsed-time');
      if (el) el.textContent = getElapsed(state.todayRecord.check_in);
    }
  }, 30000);
}
async function doCheckIn() {
  try {
    const { record, message } = await apiPost('/attendance/checkin', {});
    state.todayRecord = record;
    renderCheckinWidget(record);
    startWidgetTimer();
    toast(message || 'Checked in!', record.is_late ? 'warning' : 'success');
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'calendar') loadCalendar();
  } catch (err) { toast(err.message, 'error'); }
}
async function doCheckOut() {
  try {
    const { record, message } = await apiPost('/attendance/checkout', {});
    state.todayRecord = record;
    renderCheckinWidget(record);
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    toast(message || 'Checked out!', record.status === 'half_day' ? 'warning' : 'success');
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'calendar') loadCalendar();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  setHeaderTitle('Dashboard', 'Overview of today\'s attendance');
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;
  try {
    const data = await apiGet('/dashboard');
    state.dashboard = data;
    content.innerHTML = renderDashboard(data);
    bindDashboard();
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>Failed to load dashboard: ${err.message}</p></div>`;
  }
}
function renderDashboard(d) {
  const isAdmin = state.user.role === 'admin';
  const statCards = [
    { label: 'Total Employees',  value: d.totalEmployees, icon: '👥', cls: 'primary' },
    { label: 'Present Today',    value: d.presentToday,   icon: '✅', cls: 'success', hint: 'System check-in + Clockify live' },
    { label: 'On Leave',         value: d.onLeaveToday,   icon: '🌴', cls: 'warning' },
    { label: 'Not Checked In',   value: d.notCheckedIn,   icon: '🕐', cls: 'info'    },
    { label: 'Absent (Explicit)',value: d.absentToday,    icon: '❌', cls: 'danger'  },
    { label: 'Late Entries',     value: d.lateToday,      icon: '⏰', cls: 'orange'  },
    { label: 'Early Exits',      value: d.earlyExitToday, icon: '◀',  cls: 'purple'  },
    { label: 'Half Days',        value: d.halfDayToday,   icon: '🌓', cls: 'info'    },
    ...(isAdmin ? [{ label: 'Pending Leaves', value: d.pendingLeaves, icon: '📋', cls: 'info' }] : []),
  ];

  const activityRows = (d.recentActivity || []).length === 0
    ? `<div class="empty-state"><div class="empty-icon">📭</div><p>No activity recorded today</p></div>`
    : (d.recentActivity || []).map(r => `
        <div class="activity-item">
          <div class="activity-avatar" style="background:${r.avatar_color||'#4F46E5'}">${initials(r.name)}</div>
          <div class="activity-info">
            <div class="activity-name">${r.name}</div>
            <div class="activity-detail" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
              <span style="color:var(--text-muted)">${r.department || ''}</span>
              <span class="status-badge ${r.status}">${statusLabel(r.status)}</span>
              ${r.is_late        ? '<span class="status-badge late">Late</span>'             : ''}
              ${r.is_early_exit  ? '<span class="status-badge early_exit">Early Exit</span>' : ''}
              ${r.status === 'half_day' ? '<span class="status-badge half_day">Half Day</span>' : ''}
              ${r.clockify_live ? `<span class="clockify-badge" style="font-size:.65rem;padding:2px 6px">⏱ Clockify Live</span>` : ''}
            </div>
          </div>
          <div style="text-align:right">
            ${r.check_in ? `<div class="activity-time">${I('clock')} ${fmtTime(r.check_in)}</div>` : ''}
            ${r.work_hours ? `<div class="activity-time">${fmtHours(r.work_hours)}</div>` : ''}
          </div>
        </div>`).join('');

  const leaveQueue = (d.pendingLeaveList || []).length === 0
    ? `<div class="empty-state"><div class="empty-icon">🎉</div><p>${isAdmin ? 'No pending leave requests' : 'No recent leaves'}</p></div>`
    : (d.pendingLeaveList || []).map(l => `
        <div class="leave-queue-item">
          <div class="activity-avatar" style="background:${l.avatar_color||'#4F46E5'};width:34px;height:34px;flex-shrink:0">${initials(l.name)}</div>
          <div class="leave-queue-info">
            <div class="leave-queue-name">${l.name}</div>
            <div class="leave-queue-dates">${fmtDateRange(l.start_date, l.end_date)} · <span class="leave-type-badge ${l.leave_type}">${l.leave_type}</span></div>
            ${l.reason ? `<div class="leave-queue-reason">"${l.reason}"</div>` : ''}
          </div>
          <div class="flex flex-col gap-2" style="gap:4px">
            <span class="status-badge ${l.status}">${l.status}</span>
            ${isAdmin && l.status === 'pending' ? `
              <div class="leave-queue-actions">
                <button class="btn btn-success btn-sm" onclick="approveLeave(${l.id})">${I('check')}</button>
                <button class="btn btn-danger btn-sm"  onclick="rejectLeave(${l.id})">${I('x')}</button>
              </div>` : ''}
          </div>
        </div>`).join('');

  return `
    <div class="stats-grid">
      ${statCards.map(c => `
        <div class="stat-card ${c.cls}" title="${c.hint || ''}">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-value">${c.value}</div>
          <div class="stat-label">${c.label}</div>
          ${c.hint ? `<div style="font-size:.65rem;color:var(--text-muted);margin-top:2px">${c.hint}</div>` : ''}
        </div>`).join('')}
    </div>
    <div class="dashboard-grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Today's Attendance</div>
            <div class="card-subtitle">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="navigate('calendar')">${I('calendar')} Full Calendar</button>
        </div>
        <div class="card-body">
          <div class="activity-list">${activityRows}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${isAdmin ? 'Leave Requests' : 'My Leaves'}</div>
            ${isAdmin ? '<div class="card-subtitle">Pending approvals</div>' : ''}
          </div>
          <button class="btn btn-outline btn-sm" onclick="navigate('leaves')">${I('leave')} View All</button>
        </div>
        <div class="card-body">
          <div>${leaveQueue}</div>
        </div>
      </div>
    </div>`;
}
function bindDashboard() {
  // Buttons are using global onclick handlers
}

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════════════════════════════════════════════
async function loadCalendar() {
  setHeaderTitle('Calendar', 'Attendance overview');
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;
  try {
    await Promise.all([
      fetchCalendarData(),
      state.employees.length === 0 ? fetchEmployees() : Promise.resolve(),
    ]);
    renderCalendarView();
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>Failed to load calendar: ${err.message}</p></div>`;
  }
}
async function fetchCalendarData() {
  const d = state.calendarDate;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === (today.getMonth() + 1);

  const fetches = [apiGet('/attendance', { year, month })];
  if (isCurrentMonth && state.user?.role === 'admin') {
    fetches.push(apiGet('/clockify/live').catch(() => ({ timers: {} })));
  }
  const [records, liveData] = await Promise.all(fetches);
  if (liveData) clockifyTimers = liveData.timers || {};

  // Group by date
  const grouped = {};
  for (const r of records) {
    if (!grouped[r.date]) grouped[r.date] = [];
    grouped[r.date].push(r);
  }
  state.calendarData = grouped;
}
async function fetchEmployees() {
  const emps = await apiGet('/employees');
  state.employees = emps.filter(e => e.role === 'employee');
}
function renderCalendarView() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="calendar-toolbar">
      <div class="calendar-nav">
        <button class="btn btn-outline btn-icon" onclick="calNavPrev()">${I('chevronLeft')}</button>
        <span class="calendar-title" id="cal-title"></span>
        <button class="btn btn-outline btn-icon" onclick="calNavNext()">${I('chevronRight')}</button>
      </div>
      <button class="btn btn-outline btn-sm" onclick="calToday()">Today</button>
      <div class="view-toggle">
        <button class="view-toggle-btn ${state.calendarMode==='month'?'active':''}" onclick="setCalMode('month')">Month</button>
        <button class="view-toggle-btn ${state.calendarMode==='week'?'active':''}"  onclick="setCalMode('week')">Week</button>
      </div>
      <div class="calendar-legend">
        <div class="legend-item"><div class="legend-dot" style="background:#10B981"></div> Present</div>
        <div class="legend-item"><div class="legend-dot" style="background:#EF4444"></div> Absent</div>
        <div class="legend-item"><div class="legend-dot" style="background:#F59E0B"></div> On Leave</div>
        <div class="legend-item"><div class="legend-dot" style="background:#3B82F6"></div> Half Day</div>
        <div class="legend-item"><div class="legend-dot" style="background:#F97316"></div> Late</div>
        <div class="legend-item"><div class="legend-dot" style="background:#8B5CF6"></div> Early Exit</div>
      </div>
    </div>
    <div id="cal-body"></div>`;
  renderCalBody();
}
function renderCalBody() {
  const body = document.getElementById('cal-body');
  const titleEl = document.getElementById('cal-title');
  if (!body || !titleEl) return;
  if (state.calendarMode === 'month') {
    titleEl.textContent = `${MONTHS[state.calendarDate.getMonth()]} ${state.calendarDate.getFullYear()}`;
    body.innerHTML = renderMonthView();
  } else {
    const weekDates = getWeekDates(state.calendarDate);
    const s = weekDates[0]; const e = weekDates[6];
    titleEl.textContent = s.getMonth() === e.getMonth()
      ? `${MONTHS[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`
      : `${MONTHS[s.getMonth()]} ${s.getDate()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
    body.innerHTML = renderWeekView(weekDates);
  }
}
function calNavPrev() {
  if (state.calendarMode === 'month') {
    state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() - 1, 1);
    fetchCalendarData().then(renderCalBody);
  } else {
    const d = new Date(state.calendarDate); d.setDate(d.getDate() - 7);
    state.calendarDate = d;
    fetchCalendarData().then(renderCalBody);
  }
}
function calNavNext() {
  if (state.calendarMode === 'month') {
    state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + 1, 1);
    fetchCalendarData().then(renderCalBody);
  } else {
    const d = new Date(state.calendarDate); d.setDate(d.getDate() + 7);
    state.calendarDate = d;
    fetchCalendarData().then(renderCalBody);
  }
}
function calToday() {
  state.calendarDate = new Date();
  fetchCalendarData().then(renderCalBody);
}
function setCalMode(mode) {
  state.calendarMode = mode;
  renderCalBody();
  // re-render toolbar buttons
  document.querySelectorAll('.view-toggle-btn').forEach((btn, i) => {
    btn.className = `view-toggle-btn ${(i===0&&mode==='month')||(i===1&&mode==='week')?'active':''}`;
  });
}

// ── Month View ────────────────────────────────────────────────────────────────
function renderMonthView() {
  const year  = state.calendarDate.getFullYear();
  const month = state.calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const today = todayStr();
  const isAdmin = state.user.role === 'admin';

  // Start from Sunday before first day
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const endDate = new Date(lastDay);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

  let cells = '';
  let cur = new Date(startDate);
  while (cur <= endDate) {
    const ds = toISODate(cur);
    const isOther   = cur.getMonth() !== month;
    const isTodayD  = ds === today;
    const isWeekendD = cur.getDay() === 0 || cur.getDay() === 6;
    const records   = state.calendarData[ds] || [];
    const cls = ['calendar-cell', isOther?'other-month':'', isTodayD?'today':'', isWeekendD?'weekend':''].filter(Boolean).join(' ');

    let cellInner = '';
    if (!isOther && !isWeekendD) {
      if (isAdmin) {
        cellInner = renderAdminCellContent(ds, records);
      } else {
        cellInner = renderEmployeeCellContent(ds, records);
      }
    }

    cells += `
      <div class="${cls}" onclick="openDayModal('${ds}')" title="${DAYS_FULL[cur.getDay()]}, ${fmtDate(ds)}">
        <div class="cell-date">${cur.getDate()}</div>
        <div class="cell-content">${cellInner}</div>
      </div>`;
    cur.setDate(cur.getDate() + 1);
  }

  return `
    <div class="calendar-grid-header">
      ${DAYS.map(d => `<div class="calendar-day-header">${d}</div>`).join('')}
    </div>
    <div class="calendar-grid">${cells}</div>`;
}

function renderAdminCellContent(ds, records) {
  const isToday = ds === todayStr();
  const onLeaveIds   = new Set(records.filter(r => r.status === 'on_leave').map(r => r.user_id));
  const dbPresentIds = new Set(records.filter(r => ['present','half_day'].includes(r.status)).map(r => r.user_id));
  const absent   = records.filter(r => r.status === 'absent').length;
  const onLeave  = onLeaveIds.size;
  const halfDay  = records.filter(r => r.status === 'half_day').length;
  const late     = records.filter(r => r.is_late).length;
  const early    = records.filter(r => r.is_early_exit).length;

  // For today, include Clockify-active employees not on leave
  let presentCount;
  if (isToday) {
    const cfyActiveIds = new Set(
      Object.entries(clockifyTimers)
        .filter(([, t]) => t.running)
        .map(([uid]) => parseInt(uid))
        .filter(id => !onLeaveIds.has(id))
    );
    presentCount = new Set([...dbPresentIds, ...cfyActiveIds]).size;
  } else {
    presentCount = dbPresentIds.size;
  }

  if (presentCount === 0 && absent === 0 && onLeave === 0 && halfDay === 0) return '';
  const bits = [];
  if (presentCount > 0) bits.push(`<span class="cell-count p">${presentCount}P</span>`);
  if (absent   > 0) bits.push(`<span class="cell-count a">${absent}A</span>`);
  if (onLeave  > 0) bits.push(`<span class="cell-count l">${onLeave}L</span>`);
  if (halfDay  > 0) bits.push(`<span class="cell-count h">${halfDay}H</span>`);
  const mods = [];
  if (late  > 0) mods.push(`<span class="cell-modifier-dot late">⏰${late}</span>`);
  if (early > 0) mods.push(`<span class="cell-modifier-dot early">◀${early}</span>`);
  return `
    <div class="cell-count-row">${bits.join('')}</div>
    ${mods.length ? `<div class="cell-modifiers">${mods.join('')}</div>` : ''}`;
}

function renderEmployeeCellContent(ds, records) {
  const myRecord = records.find(r => r.user_id === state.user.id);
  if (!myRecord) {
    const today = todayStr();
    if (ds < today && !isWeekend(ds)) {
      return `<div class="cell-status-badge absent">Absent</div>`;
    }
    return '';
  }
  const mods = [];
  if (myRecord.is_late)       mods.push(`<span class="cell-modifier-dot late">Late</span>`);
  if (myRecord.is_early_exit) mods.push(`<span class="cell-modifier-dot early">Early</span>`);
  return `
    <div class="cell-my-status">
      <span class="cell-status-badge ${myRecord.status}">${statusLabel(myRecord.status)}</span>
      ${mods.length ? `<div class="cell-modifiers">${mods.join('')}</div>` : ''}
      ${myRecord.work_hours ? `<div class="cell-hours">${fmtHours(myRecord.work_hours)}</div>` : ''}
    </div>`;
}

// ── Week View ─────────────────────────────────────────────────────────────────
function renderWeekView(weekDates) {
  const today = todayStr();
  const isAdmin = state.user.role === 'admin';
  const emps = state.employees;

  const cols = weekDates.map(date => {
    const ds = toISODate(date);
    const records = state.calendarData[ds] || [];
    const isToday = ds === today;
    const isWknd  = date.getDay() === 0 || date.getDay() === 6;

    let empRows = '';
    if (isWknd) {
      empRows = `<div style="padding:8px;font-size:.72rem;color:var(--text-muted);text-align:center">Weekend</div>`;
    } else if (isAdmin) {
      if (emps.length === 0) {
        empRows = `<div style="padding:8px;font-size:.72rem;color:var(--text-muted)">No data</div>`;
      } else {
        empRows = emps.map(emp => {
          const r = records.find(x => x.user_id === emp.id);
          const status = r ? r.status : (ds < today ? 'absent' : '');
          const color  = STATUS_COLOR[status] || '#CBD5E1';
          return `
            <div class="week-emp-item" style="background:${status?color+'15':'transparent'}">
              <div class="week-emp-dot" style="background:${color}"></div>
              <div class="week-emp-name" title="${emp.name}">${emp.name.split(' ')[0]}</div>
              ${r?.is_late ? '<span style="font-size:.6rem;color:var(--orange)">⏰</span>' : ''}
              ${r?.is_early_exit ? '<span style="font-size:.6rem;color:var(--purple)">◀</span>' : ''}
            </div>`;
        }).join('');
      }
    } else {
      const r = records.find(x => x.user_id === state.user.id);
      const status = r ? r.status : (ds < today && !isWknd ? 'absent' : '');
      const color = STATUS_COLOR[status] || '#CBD5E1';
      empRows = status ? `
        <div style="padding:10px;text-align:center">
          <div class="cell-status-badge ${status}" style="display:inline-block;font-size:.78rem">${statusLabel(status)}</div>
          ${r?.check_in ? `<div style="font-size:.72rem;color:var(--text-muted);margin-top:4px">${fmtTime(r.check_in)}${r.check_out ? ' – '+fmtTime(r.check_out) : ''}</div>` : ''}
          ${r?.work_hours ? `<div style="font-size:.72rem;font-weight:600;color:var(--primary)">${fmtHours(r.work_hours)}</div>` : ''}
          ${r?.is_late ? '<span class="cell-modifier-dot late" style="display:inline-block;margin-top:4px">Late</span>' : ''}
          ${r?.is_early_exit ? '<span class="cell-modifier-dot early" style="display:inline-block;margin-top:4px">Early Exit</span>' : ''}
        </div>` : `<div style="padding:10px;text-align:center;font-size:.75rem;color:var(--text-muted)">—</div>`;
    }

    return `
      <div class="week-day-card ${isToday?'week-day-today':''}">
        <div class="week-day-header" onclick="openDayModal('${ds}')" style="cursor:pointer">
          <div class="week-day-name">${DAYS_FULL[date.getDay()]}</div>
          <div class="week-day-number" style="color:${isToday?'var(--primary)':'var(--text)'}">${date.getDate()}</div>
          <div style="font-size:.7rem;color:var(--text-muted)">${MONTHS[date.getMonth()].substring(0,3)}</div>
        </div>
        <div class="week-emp-list">${empRows}</div>
      </div>`;
  });

  return `<div class="week-grid">${cols.join('')}</div>`;
}

// ── Day Modal ─────────────────────────────────────────────────────────────────
function renderEmpRow(r, ds, showLive) {
  const st       = r.status || '';
  const isLeave  = st === 'on_leave';
  const userId   = r.user_id || r.id;

  return `
    <div class="employee-detail-item" id="emp-row-${userId}">
      <div class="activity-avatar" style="background:${r.avatar_color||'#4F46E5'};width:38px;height:38px;flex-shrink:0;font-size:.85rem">${initials(r.name)}</div>
      <div class="emp-detail-info" style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="emp-detail-name">${r.name}</div>
          ${st ? `<span class="status-badge ${st}">${statusLabel(st)}</span>` : ''}
          ${r.is_late       ? '<span class="status-badge late" style="font-size:.65rem">Late</span>'       : ''}
          ${r.is_early_exit ? '<span class="status-badge early_exit" style="font-size:.65rem">Early Exit</span>' : ''}
        </div>
        <div class="emp-detail-dept" style="margin-top:1px">${r.department || ''}</div>

        ${!r.no_record && r.check_in ? `
          <div class="emp-detail-times" style="margin-top:4px">
            <div class="emp-detail-time-item">${I('clock')} In: <strong>${fmtTime(r.check_in)}</strong></div>
            <div class="emp-detail-time-item">Out: <strong>${fmtTime(r.check_out)}</strong></div>
            ${r.work_hours ? `<div class="emp-detail-hours">${fmtHours(r.work_hours)}</div>` : ''}
          </div>` : ''}

        ${!isLeave && showLive ? `
          <div id="cfy-${userId}" style="margin-top:5px;display:flex;align-items:center;gap:6px">
            <span style="font-size:.72rem;color:var(--text-muted)">⏳ Fetching Clockify…</span>
          </div>` : ''}
        ${isLeave ? `
          <div style="margin-top:4px;font-size:.72rem;color:var(--warning);font-style:italic">On approved leave — no tracking</div>` : ''}
      </div>
    </div>`;
}

async function openDayModal(ds) {
  const records = state.calendarData[ds] || [];
  const date    = new Date(ds + 'T12:00:00');
  const dayName = DAYS_FULL[date.getDay()];
  const isAdmin = state.user.role === 'admin';
  const isWknd  = date.getDay() === 0 || date.getDay() === 6;
  const emps    = state.employees;
  const isToday = ds === todayStr();

  // For today: fetch Clockify live data FIRST so stats & rows are accurate
  if (isToday) {
    stopClockifyLive();
    try {
      const { timers } = await apiGet('/clockify/live');
      clockifyTimers = timers || {};
    } catch { clockifyTimers = {}; }
  }

  // Build sets for accurate counting
  const onLeaveIds    = new Set(records.filter(r => r.status === 'on_leave').map(r => r.user_id));
  const dbPresentIds  = new Set(records.filter(r => ['present','half_day'].includes(r.status)).map(r => r.user_id));
  const absentIds     = new Set(records.filter(r => r.status === 'absent').map(r => r.user_id));

  // Clockify-active employee IDs (not on leave)
  const cfyActiveIds = isToday
    ? new Set(Object.entries(clockifyTimers)
        .filter(([, t]) => t.running)
        .map(([uid]) => parseInt(uid))
        .filter(id => !onLeaveIds.has(id)))
    : new Set();

  const allPresentIds = new Set([...dbPresentIds, ...cfyActiveIds]);
  const present = allPresentIds.size;
  const onLeave = onLeaveIds.size;
  const absent  = absentIds.size;
  const late    = records.filter(r => r.is_late).length;

  let empRows = '';
  if (isAdmin) {
    const merged = isWknd ? records : emps.map(emp => {
      const r = records.find(x => x.user_id === emp.id);
      if (r) return { ...emp, ...r };
      // For today: mark as present if Clockify timer is running
      if (isToday && cfyActiveIds.has(emp.id)) return { ...emp, status: 'present', no_record: true };
      return { ...emp, status: ds < todayStr() ? 'absent' : '', no_record: true };
    });
    empRows = merged.length === 0
      ? `<div class="empty-state"><div class="empty-icon">📭</div><p>No records for this day</p></div>`
      : merged.map(r => renderEmpRow(r, ds, isToday)).join('');
  } else {
    const r = records.find(x => x.user_id === state.user.id);
    if (!r) {
      empRows = ds > todayStr()
        ? `<div class="empty-state"><div class="empty-icon">📅</div><p>Future date — no record yet</p></div>`
        : isWknd
          ? `<div class="empty-state"><div class="empty-icon">🏖️</div><p>Weekend</p></div>`
          : `<div class="employee-detail-item">
               <div class="emp-detail-info"><div class="emp-detail-name">${state.user.name}</div></div>
               <span class="status-badge absent">Absent</span>
             </div>`;
    } else {
      empRows = renderEmpRow({ ...state.user, ...r, user_id: state.user.id }, ds, isToday && r.status !== 'on_leave');
    }
  }

  openModal(`
    <div class="modal-header">
      <div class="modal-title">${dayName}, ${fmtDate(ds)}</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
    </div>
    <div class="modal-body">
      ${isAdmin ? `
        <div class="day-detail-header">
          <div class="day-detail-date-big">${date.getDate()}</div>
          <div class="day-detail-info">
            <div class="day-detail-day-name">${MONTHS[date.getMonth()]} ${date.getFullYear()}</div>
            <div class="day-detail-stats">
              ${present ? `<span class="status-badge present">${present} Present</span>` : ''}
              ${onLeave ? `<span class="status-badge on_leave">${onLeave} On Leave</span>` : ''}
              ${absent  ? `<span class="status-badge absent">${absent} Absent</span>`     : ''}
              ${late    ? `<span class="status-badge late">${late} Late</span>`            : ''}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="syncClockifyDay('${ds}')">${I('sync')} Sync Clockify</button>
        </div>` : ''}
      <div class="employee-detail-list">${empRows}</div>
    </div>`, 'modal-lg');

  // Timers already fetched — just start the tick interval
  if (isToday) {
    updateClockifyDom();
    clockifyLiveInterval = setInterval(tickClockifyTimers, 1000);
    // Re-fetch from Clockify every 2 minutes to stay fresh
    setTimeout(() => { if (clockifyLiveInterval) startClockifyLive(); }, 120000);
  }
}

// ── Clockify Live Timer ───────────────────────────────────────────────────────
function liveElapsed(startISO) {
  const diff = Date.now() - new Date(startISO).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateClockifyDom() {
  Object.entries(clockifyTimers).forEach(([userId, timer]) => {
    const el = document.getElementById(`cfy-${userId}`);
    if (!el) return;
    if (timer.running && timer.start) {
      el.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:5px;background:#D1FAE5;border:1px solid #6EE7B7;border-radius:6px;padding:3px 9px">
          <span style="width:7px;height:7px;border-radius:50%;background:#10B981;box-shadow:0 0 0 2px #A7F3D0;animation:pulse 1.5s infinite"></span>
          <span style="font-size:.75rem;font-weight:700;color:#065F46;font-family:monospace;letter-spacing:.04em" id="cfy-time-${userId}">${liveElapsed(timer.start)}</span>
          <span style="font-size:.68rem;color:#059669">Clockify Live</span>
        </span>
        ${timer.description ? `<span style="font-size:.7rem;color:var(--text-muted);font-style:italic">${timer.description}</span>` : ''}`;
    } else {
      el.innerHTML = `<span style="font-size:.72rem;color:var(--text-muted)">⚫ Not tracking on Clockify</span>`;
    }
  });
}

function tickClockifyTimers() {
  Object.entries(clockifyTimers).forEach(([userId, timer]) => {
    if (!timer.running || !timer.start) return;
    const el = document.getElementById(`cfy-time-${userId}`);
    if (el) el.textContent = liveElapsed(timer.start);
  });
}

async function startClockifyLive() {
  stopClockifyLive();
  try {
    const { timers } = await apiGet('/clockify/live');
    clockifyTimers = timers || {};
    updateClockifyDom();
    // Tick every second for the running counters
    clockifyLiveInterval = setInterval(tickClockifyTimers, 1000);
    // Refresh from Clockify API every 2 minutes
    setTimeout(() => { if (clockifyLiveInterval) startClockifyLive(); }, 120000);
  } catch { /* silent */ }
}

function stopClockifyLive() {
  if (clockifyLiveInterval) { clearInterval(clockifyLiveInterval); clockifyLiveInterval = null; }
  clockifyTimers = {};
}

async function syncClockifyDay(ds) {
  try {
    toast('Syncing Clockify data…', 'info');
    const result = await apiPost('/clockify/sync', { date: ds });
    toast(`Synced ${result.synced} users from Clockify`, 'success');
    await fetchCalendarData();
    closeModal();
    openDayModal(ds);
  } catch (err) { toast('Clockify sync: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// LEAVES
// ══════════════════════════════════════════════════════════════════════════════
async function loadLeaves() {
  setHeaderTitle('Leave Management', 'Apply and manage leaves');
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;
  try {
    // Default late-early filter to today on first load
    if (!state.leavesFilterDate) state.leavesFilterDate = todayStr();
    const [leaves, lateEarly] = await Promise.all([
      apiGet('/leaves'),
      apiGet('/attendance/late-early', { date: state.leavesFilterDate }),
    ]);
    state.leaves = leaves;
    state.lateEarlyRecords = lateEarly;
    renderLeavesView();
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}
function renderLeavesView() {
  const content = document.getElementById('content');
  const isAdmin = state.user.role === 'admin';
  const allLeaves = state.leaves;
  const myLeaves  = allLeaves.filter(l => l.user_id === state.user.id);

  const leaveTypeOpts = ['casual','sick','annual','maternity','paternity','bereavement','unpaid'].map(t =>
    `<option value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('');

  // ── Late / Early Exit tab content ──────────────────────────────────────────
  const leRecords = state.lateEarlyRecords || [];
  const leItems = leRecords.length === 0
    ? `<div class="empty-state"><div class="empty-icon">✅</div><p>No late arrivals or early exits recorded</p></div>`
    : leRecords.map(r => `
      <div class="leave-card" style="cursor:pointer" onclick='openEditLateEarlyModal(${JSON.stringify(r)})'>
        <div style="width:36px;height:36px;border-radius:50%;background:${r.avatar_color||'#4F46E5'};display:flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:700;color:#fff;flex-shrink:0">${initials(r.name)}</div>
        <div class="leave-card-left">
          <div class="flex items-center gap-2" style="flex-wrap:wrap">
            <div class="leave-card-name">${r.name}</div>
            ${r.is_late       ? `<span class="status-badge late">⏰ Late Come</span>` : ''}
            ${r.is_early_exit ? `<span class="status-badge early_exit">◀ Early Exit</span>` : ''}
            <span class="status-badge ${r.status}">${statusLabel(r.status)}</span>
          </div>
          <div class="leave-card-dates">${I('calendar')} ${fmtDate(r.date)}</div>
          <div style="margin-top:5px;display:flex;gap:14px;flex-wrap:wrap">
            ${r.is_late && r.check_in
              ? `<span style="font-size:.78rem;color:var(--text-muted)">${I('clock')} Arrived: <strong style="color:var(--orange)">${fmtTime(r.check_in)}</strong></span>`
              : ''}
            ${r.is_early_exit && r.check_out
              ? `<span style="font-size:.78rem;color:var(--text-muted)">Left: <strong style="color:var(--purple)">${fmtTime(r.check_out)}</strong></span>`
              : ''}
            ${r.work_hours
              ? `<span style="font-size:.78rem;color:var(--text-muted)">Hours: <strong>${fmtHours(r.work_hours)}</strong></span>`
              : ''}
          </div>
          <div style="font-size:.72rem;color:var(--text-muted);margin-top:3px">${r.department || ''}</div>
        </div>
        <div style="flex-shrink:0;align-self:center">
          <span style="font-size:.72rem;color:var(--text-muted);padding:4px 8px;border:1px solid var(--border);border-radius:6px">${I('edit')} Edit</span>
        </div>
      </div>`).join('');


  const pendingCount = allLeaves.filter(l => l.status === 'pending').length;

  // Date filter: for late_early, filter by exact date; for leaves, filter by date within range
  const fd = state.leavesFilterDate;
  const filteredLeaveItems = (() => {
    let src = isAdmin && state.leavesTab === 'all' ? allLeaves : myLeaves;
    if (fd) src = src.filter(l => l.start_date <= fd && l.end_date >= fd);
    if (!src.length) return `<div class="empty-state"><div class="empty-icon">📭</div><p>No leave records for this date</p></div>`;
    return src.map(l => `
      <div class="leave-card">
        <div style="width:36px;height:36px;border-radius:50%;background:${l.avatar_color||'#4F46E5'};display:flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:700;color:#fff;flex-shrink:0">${initials(l.name)}</div>
        <div class="leave-card-left">
          <div class="flex items-center gap-2" style="flex-wrap:wrap">
            <div class="leave-card-name">${l.name}</div>
            <span class="leave-type-badge ${l.leave_type}">${l.leave_type}</span>
            ${l.leave_time === 'half'
              ? `<span style="font-size:.7rem;font-weight:600;padding:2px 7px;border-radius:99px;background:#EDE9FE;color:#7C3AED">${l.half_type === 'second_half' ? '🌙 Second Half' : '☀️ First Half'}</span>`
              : `<span style="font-size:.7rem;font-weight:600;padding:2px 7px;border-radius:99px;background:#F1F5F9;color:#475569">Full Day</span>`}
            <span class="status-badge ${l.status}">${l.status}</span>
          </div>
          <div class="leave-card-dates">${I('calendar')} ${fmtDateRange(l.start_date, l.end_date)}</div>
          ${l.reason ? `<div class="leave-card-reason">"${l.reason}"</div>` : ''}
          ${l.approver_name ? `<div class="text-sm text-muted" style="margin-top:2px">By: ${l.approver_name}</div>` : ''}
          <div class="leave-card-actions">
            ${isAdmin && l.status === 'pending' ? `
              <button class="btn btn-success btn-sm" onclick="approveLeave(${l.id})">${I('check')} Approve</button>
              <button class="btn btn-danger btn-sm"  onclick="rejectLeave(${l.id})">${I('x')} Reject</button>` : ''}
            ${l.status === 'pending' && l.user_id === state.user.id ? `
              <button class="btn btn-outline btn-sm" onclick="cancelLeave(${l.id})">${I('x')} Cancel</button>` : ''}
          </div>
        </div>
        <div style="flex-shrink:0;align-self:center">
          <span class="btn btn-outline btn-sm" style="cursor:pointer" onclick='openEditLeaveModal(${JSON.stringify(l)})'>${I('edit')} Edit</span>
        </div>
      </div>`).join('');
  })();

  const activeListItems = state.leavesTab === 'late_early' ? leItems : filteredLeaveItems;

  const filterLabel = state.leavesTab === 'late_early'
    ? 'Filter by Date'
    : 'Filter by Date (leaves covering this date)';

  content.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Leave Management</div><div class="page-subtitle">Track and manage employee leaves</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-outline" onclick="openLateEarlyModal()">${I('clock')} Late / Early Exit</button>
        <button class="btn btn-primary" onclick="openApplyLeaveModal()">${I('plus')} Apply Leave</button>
      </div>
    </div>
    <div class="leaves-layout">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <label style="font-size:.8rem;font-weight:600;color:var(--text-muted);white-space:nowrap">${I('calendar')} ${filterLabel}:</label>
          <input type="date" class="form-control" style="width:auto;padding:5px 10px;font-size:.82rem"
            value="${fd || ''}" onchange="onLeavesDateFilter(this.value)">
          ${fd ? `<button class="btn btn-ghost btn-sm" onclick="onLeavesDateFilter('')">${I('x')} Clear</button>` : ''}
        </div>
        <div class="tab-bar">
          ${isAdmin ? `<button class="tab-btn ${state.leavesTab==='all'?'active':''}" onclick="setLeavesTab('all')">
            All Leaves ${pendingCount ? `<span class="nav-badge" style="position:static;margin-left:4px">${pendingCount}</span>` : ''}
          </button>` : ''}
          <button class="tab-btn ${state.leavesTab==='mine'?'active':''}" onclick="setLeavesTab('mine')">My Leaves</button>
          <button class="tab-btn ${state.leavesTab==='late_early'?'active':''}" onclick="setLeavesTab('late_early')">
            ⏰ Late / Early Exit ${leRecords.length ? `<span class="nav-badge" style="position:static;margin-left:4px">${leRecords.length}</span>` : ''}
          </button>
        </div>
        <div class="leave-list" id="leave-list">${activeListItems}</div>
      </div>
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Quick Apply</div></div>
          <div class="card-body">
            <form class="apply-leave-form" id="quick-leave-form" onsubmit="submitQuickLeave(event)">
              ${isAdmin ? `
              <div class="form-group">
                <label class="form-label">Employee</label>
                <select class="form-control" id="ql-emp" required>
                  <option value="">Select employee…</option>
                  ${state.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('')}
                </select>
              </div>` : ''}
              <div class="form-group">
                <label class="form-label">Leave Type</label>
                <select class="form-control" id="ql-type">${leaveTypeOpts}</select>
              </div>
              <div class="form-group">
                <label class="form-label">Leave Time</label>
                <select class="form-control" id="ql-leavetime" onchange="onQLLeaveTimeChange()">
                  <option value="full">Full Leave</option>
                  <option value="half">Half Leave</option>
                </select>
              </div>
              <div class="form-group" id="ql-halftype-row" style="display:none">
                <label class="form-label">Which Half?</label>
                <select class="form-control" id="ql-halftype">
                  <option value="first_half">First Half &nbsp;(Morning)</option>
                  <option value="second_half">Second Half (Afternoon)</option>
                </select>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Start Date</label>
                  <input type="date" class="form-control" id="ql-start" min="${todayStr()}" required />
                </div>
                <div class="form-group">
                  <label class="form-label">End Date</label>
                  <input type="date" class="form-control" id="ql-end" min="${todayStr()}" required />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Reason</label>
                <textarea class="form-control" id="ql-reason" rows="2" placeholder="Optional reason…"></textarea>
              </div>
              <button type="submit" class="btn btn-primary btn-full">Submit Request</button>
            </form>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">Leave Summary</div></div>
          <div class="card-body">
            ${renderLeaveSummary(myLeaves)}
          </div>
        </div>
      </div>
    </div>`;
}
async function setLeavesTab(tab) {
  state.leavesTab = tab;
  // When switching to late_early, default date to today if not set
  if (tab === 'late_early' && !state.leavesFilterDate) state.leavesFilterDate = todayStr();
  if (tab === 'late_early') {
    try {
      const qs = state.leavesFilterDate ? { date: state.leavesFilterDate } : {};
      state.lateEarlyRecords = await apiGet('/attendance/late-early', qs);
    } catch { /* keep existing */ }
  }
  renderLeavesView();
}

async function onLeavesDateFilter(val) {
  state.leavesFilterDate = val || null;
  if (state.leavesTab === 'late_early') {
    try {
      const qs = val ? { date: val } : {};
      state.lateEarlyRecords = await apiGet('/attendance/late-early', qs);
    } catch { /* keep existing */ }
  }
  renderLeavesView();
}
function renderLeaveSummary(myLeaves) {
  const types = ['casual','sick','annual','maternity','paternity'];
  const rows = types.map(t => {
    const approved = myLeaves.filter(l => l.leave_type === t && l.status === 'approved').length;
    const pending  = myLeaves.filter(l => l.leave_type === t && l.status === 'pending').length;
    return `
      <div class="flex items-center justify-between" style="padding:6px 0;border-bottom:1px solid var(--border-light)">
        <span class="leave-type-badge ${t}" style="font-size:.72rem">${t}</span>
        <div class="flex gap-2">
          ${approved ? `<span class="status-badge approved">${approved} approved</span>` : ''}
          ${pending  ? `<span class="status-badge pending">${pending} pending</span>`    : ''}
          ${!approved && !pending ? `<span style="font-size:.78rem;color:var(--text-muted)">None</span>` : ''}
        </div>
      </div>`;
  });
  return rows.join('');
}
async function submitQuickLeave(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const isAdmin = state.user.role === 'admin';
    const empEl   = document.getElementById('ql-emp');
    if (isAdmin && empEl && !empEl.value) { toast('Please select an employee', 'warning'); btn.disabled = false; return; }
    const leave_time = document.getElementById('ql-leavetime')?.value || 'full';
    const body = {
      leave_type: document.getElementById('ql-type').value,
      start_date: document.getElementById('ql-start').value,
      end_date:   document.getElementById('ql-end').value,
      reason:     document.getElementById('ql-reason').value,
      leave_time,
      half_type:  leave_time === 'half' ? (document.getElementById('ql-halftype')?.value || 'first_half') : null,
    };
    if (isAdmin && empEl?.value) body.user_id = parseInt(empEl.value);
    await apiPost('/leaves', body);
    toast('Leave request submitted!', 'success');
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    renderLeavesView();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}
async function approveLeave(id) {
  try {
    await apiPut(`/leaves/${id}/approve`, {});
    toast('Leave approved', 'success');
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    if (state.view === 'leaves') renderLeavesView();
    if (state.view === 'dashboard') loadDashboard();
  } catch (err) { toast(err.message, 'error'); }
}
async function rejectLeave(id) {
  try {
    await apiPut(`/leaves/${id}/reject`, {});
    toast('Leave rejected', 'warning');
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    if (state.view === 'leaves') renderLeavesView();
    if (state.view === 'dashboard') loadDashboard();
  } catch (err) { toast(err.message, 'error'); }
}
async function cancelLeave(id) {
  try {
    await apiDelete(`/leaves/${id}`);
    toast('Leave cancelled', 'info');
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteLeave(id) {
  if (!confirm('Delete this leave record? This cannot be undone.')) return;
  try {
    await apiDelete(`/leaves/${id}`);
    toast('Leave deleted', 'success');
    closeModal();
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}
function onLeaveTimeChange(index) {
  const val     = document.getElementById(`lf-leavetime-${index}`)?.value;
  const halfRow = document.getElementById(`lf-halftype-row-${index}`);
  if (halfRow) halfRow.style.display = val === 'half' ? 'block' : 'none';
}

function onQLLeaveTimeChange() {
  const val     = document.getElementById('ql-leavetime')?.value;
  const halfRow = document.getElementById('ql-halftype-row');
  if (halfRow) halfRow.style.display = val === 'half' ? 'block' : 'none';
}

function leaveTypeOptions() {
  return ['casual','sick','annual','maternity','paternity','bereavement','unpaid']
    .map(t => `<option value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('');
}

function empOptions() {
  return state.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
}

function renderLeaveFormCard(index) {
  const isAdmin = state.user.role === 'admin';
  return `
    <div class="leave-form-card" id="leave-form-${index}" style="background:var(--bg);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:.83rem;font-weight:700;color:var(--primary)">
          ${index === 0 ? 'Leave Request' : `Leave Request #${index + 1}`}
        </div>
        ${index > 0 ? `<button class="btn btn-ghost btn-sm" onclick="removeLeaveForm(${index})" style="color:var(--danger);padding:4px 8px">${I('x')} Remove</button>` : ''}
      </div>
      ${isAdmin ? `
        <div class="form-group">
          <label class="form-label">Employee</label>
          <select class="form-control" id="lf-emp-${index}" required>
            <option value="">Select employee…</option>
            ${empOptions()}
          </select>
        </div>` : ''}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Leave Type</label>
          <select class="form-control" id="lf-type-${index}">${leaveTypeOptions()}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Leave Time</label>
          <select class="form-control" id="lf-leavetime-${index}" onchange="onLeaveTimeChange(${index})">
            <option value="full">Full Leave</option>
            <option value="half">Half Leave</option>
          </select>
        </div>
      </div>
      <div class="form-group" id="lf-halftype-row-${index}" style="display:none">
        <label class="form-label">Which Half?</label>
        <select class="form-control" id="lf-halftype-${index}">
          <option value="first_half">First Half &nbsp;(Morning — till lunch)</option>
          <option value="second_half">Second Half (Afternoon — post lunch)</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Start Date</label>
          <input type="date" class="form-control" id="lf-start-${index}" min="${todayStr()}" required />
        </div>
        <div class="form-group">
          <label class="form-label">End Date</label>
          <input type="date" class="form-control" id="lf-end-${index}" min="${todayStr()}" required />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Reason</label>
        <textarea class="form-control" id="lf-reason-${index}" rows="2" placeholder="Optional reason…"></textarea>
      </div>
    </div>`;
}

function openApplyLeaveModal() {
  leaveFormCount = 0;
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Apply for Leave</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
    </div>
    <div class="modal-body" style="padding-bottom:8px">
      <div id="leave-forms-container">
        ${renderLeaveFormCard(0)}
      </div>
      <button class="btn btn-outline btn-sm" style="margin-top:4px;margin-bottom:8px" onclick="addAnotherLeaveForm()">
        ${I('plus')} Add Another
      </button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAllLeaves()">Submit All Requests</button>
    </div>`, 'modal-lg');
}

function addAnotherLeaveForm() {
  leaveFormCount++;
  const container = document.getElementById('leave-forms-container');
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = renderLeaveFormCard(leaveFormCount);
  container.appendChild(div.firstElementChild);
}

function removeLeaveForm(index) {
  document.getElementById(`leave-form-${index}`)?.remove();
}

async function submitAllLeaves() {
  const isAdmin = state.user.role === 'admin';
  const forms   = document.querySelectorAll('.leave-form-card');
  if (!forms.length) return;

  const requests = [];
  for (const form of forms) {
    const idx        = form.id.replace('leave-form-', '');
    const start_date = document.getElementById(`lf-start-${idx}`)?.value;
    const end_date   = document.getElementById(`lf-end-${idx}`)?.value;
    const empEl      = document.getElementById(`lf-emp-${idx}`);

    if (!start_date || !end_date) { toast('Fill in all start and end dates', 'warning'); return; }
    if (isAdmin && empEl && !empEl.value) { toast('Select an employee for each request', 'warning'); return; }

    const leave_time = document.getElementById(`lf-leavetime-${idx}`)?.value || 'full';
    const body = {
      leave_type: document.getElementById(`lf-type-${idx}`)?.value || 'casual',
      start_date,
      end_date,
      reason:     document.getElementById(`lf-reason-${idx}`)?.value || '',
      leave_time,
      half_type:  leave_time === 'half' ? (document.getElementById(`lf-halftype-${idx}`)?.value || 'first_half') : null,
    };
    if (isAdmin && empEl?.value) body.user_id = parseInt(empEl.value);
    requests.push(body);
  }

  try {
    await Promise.all(requests.map(r => apiPost('/leaves', r)));
    const empName = requests.length === 1 && state.user.role === 'admin'
      ? state.employees.find(e => e.id === requests[0].user_id)?.name || ''
      : '';
    toast(`${requests.length} leave request${requests.length > 1 ? 's' : ''} submitted!${empName ? ' for ' + empName : ''}`, 'success');
    closeModal();
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// LATE COME / EARLY EXIT FORM
// ══════════════════════════════════════════════════════════════════════════════
function onLateSelectChange() {
  const val = document.getElementById('le-late-select')?.value;
  const row = document.getElementById('le-late-time-row');
  if (row) row.style.display = val === 'yes' ? 'block' : 'none';
}
function onEarlySelectChange() {
  const val = document.getElementById('le-early-select')?.value;
  const row = document.getElementById('le-early-time-row');
  if (row) row.style.display = val === 'yes' ? 'block' : 'none';
}

// ── Edit Leave Modal ──────────────────────────────────────────────────────────
function openEditLeaveModal(l) {
  const isAdmin = state.user.role === 'admin';
  const canEdit = l.status !== 'approved' || isAdmin;
  const leaveTypeOpts = ['casual','sick','annual','maternity','paternity','bereavement','unpaid'].map(t =>
    `<option value="${t}" ${l.leave_type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('');

  openModal(`
    <div class="modal-header">
      <div class="modal-title">${I('edit')} Edit Leave</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-danger btn-sm" onclick="deleteLeave(${l.id})">${I('trash')} Delete</button>
        <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
      </div>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <input class="form-control" value="${l.name}" disabled style="background:var(--bg-secondary);color:var(--text-muted)">
      </div>
      <div class="form-group">
        <label class="form-label">Leave Type</label>
        <select class="form-control" id="el-type" ${!canEdit?'disabled':''}>${leaveTypeOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Leave Time</label>
        <select class="form-control" id="el-leavetime" onchange="onEditLeaveTimeChange()" ${!canEdit?'disabled':''}>
          <option value="full" ${l.leave_time!=='half'?'selected':''}>Full Leave</option>
          <option value="half" ${l.leave_time==='half'?'selected':''}>Half Leave</option>
        </select>
      </div>
      <div class="form-group" id="el-halftype-row" style="display:${l.leave_time==='half'?'block':'none'}">
        <label class="form-label">Which Half?</label>
        <select class="form-control" id="el-halftype" ${!canEdit?'disabled':''}>
          <option value="first_half"  ${l.half_type!=='second_half'?'selected':''}>☀️ First Half (Morning)</option>
          <option value="second_half" ${l.half_type==='second_half'?'selected':''}>🌙 Second Half (Afternoon)</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Start Date</label>
          <input type="date" class="form-control" id="el-start" value="${l.start_date}" ${!canEdit?'disabled':''}>
        </div>
        <div class="form-group">
          <label class="form-label">End Date</label>
          <input type="date" class="form-control" id="el-end" value="${l.end_date}" ${!canEdit?'disabled':''}>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Reason</label>
        <textarea class="form-control" id="el-reason" rows="2" ${!canEdit?'disabled':''}>${l.reason||''}</textarea>
      </div>
      ${!canEdit ? `<div style="font-size:.78rem;color:var(--warning);margin-top:4px">⚠️ Approved leave — only admin can edit</div>` : ''}
      <div style="margin-top:6px">
        <span class="status-badge ${l.status}">${l.status}</span>
        ${l.approver_name ? `<span style="font-size:.75rem;color:var(--text-muted);margin-left:6px">By: ${l.approver_name}</span>` : ''}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      ${canEdit ? `<button class="btn btn-primary" onclick="submitEditLeave(${l.id})">Save Changes</button>` : ''}
    </div>`, 'modal-md');
}

function onEditLeaveTimeChange() {
  const val = document.getElementById('el-leavetime')?.value;
  const row = document.getElementById('el-halftype-row');
  if (row) row.style.display = val === 'half' ? 'block' : 'none';
}

async function submitEditLeave(id) {
  const start_date = document.getElementById('el-start')?.value;
  const end_date   = document.getElementById('el-end')?.value;
  if (!start_date || !end_date) return toast('Fill in start and end dates', 'warning');
  if (start_date > end_date)    return toast('Start date must be before end date', 'warning');

  const leave_time = document.getElementById('el-leavetime')?.value || 'full';
  try {
    await apiPut(`/leaves/${id}`, {
      start_date,
      end_date,
      leave_type: document.getElementById('el-type')?.value,
      reason:     document.getElementById('el-reason')?.value || '',
      leave_time,
      half_type:  leave_time === 'half' ? (document.getElementById('el-halftype')?.value || 'first_half') : null,
    });
    toast('Leave updated successfully', 'success');
    closeModal();
    const leaves = await apiGet('/leaves');
    state.leaves = leaves;
    renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}

function openLateEarlyModal() {
  const empOptions = state.employees.map(e => `<option value="${e.id}">${e.name} — ${e.department || ''}</option>`).join('');
  openModal(`
    <div class="modal-header">
      <div class="modal-title">${I('clock')} Record Late Come / Early Exit</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Employee <span style="color:var(--danger)">*</span></label>
        <select class="form-control" id="le-emp">
          <option value="">— Select Employee —</option>
          ${empOptions}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Date <span style="color:var(--danger)">*</span></label>
        <input type="date" class="form-control" id="le-date" value="${todayStr()}" max="${todayStr()}">
      </div>

      <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
        <div class="form-label" style="font-weight:600;margin-bottom:8px;color:var(--orange)">⏰ Late Come</div>
        <div class="form-group" style="margin-bottom:6px">
          <select class="form-control" id="le-late-select" onchange="onLateSelectChange()">
            <option value="none">None (No late entry)</option>
            <option value="yes">Late Come</option>
          </select>
        </div>
        <div class="form-group" id="le-late-time-row" style="display:none;margin-bottom:0">
          <label class="form-label" style="font-size:.78rem">Arrival Time</label>
          <input type="time" class="form-control" id="le-late-time" placeholder="HH:MM">
        </div>
      </div>

      <div style="border:1px solid var(--border);border-radius:10px;padding:14px">
        <div class="form-label" style="font-weight:600;margin-bottom:8px;color:var(--purple)">◀ Early Exit</div>
        <div class="form-group" style="margin-bottom:6px">
          <select class="form-control" id="le-early-select" onchange="onEarlySelectChange()">
            <option value="none">None (No early exit)</option>
            <option value="yes">Early Exit</option>
          </select>
        </div>
        <div class="form-group" id="le-early-time-row" style="display:none;margin-bottom:0">
          <label class="form-label" style="font-size:.78rem">Exit Time</label>
          <input type="time" class="form-control" id="le-early-time" placeholder="HH:MM">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitLateEarly()">Save Record</button>
    </div>`, 'modal-md');
}

async function submitLateEarly() {
  const user_id    = document.getElementById('le-emp')?.value;
  const date       = document.getElementById('le-date')?.value;
  const late_come  = document.getElementById('le-late-select')?.value  || 'none';
  const late_time  = document.getElementById('le-late-time')?.value;
  const early_exit = document.getElementById('le-early-select')?.value || 'none';
  const early_time = document.getElementById('le-early-time')?.value;

  if (!user_id) return toast('Please select an employee', 'warning');
  if (!date)    return toast('Please select a date', 'warning');
  if (late_come  === 'yes' && !late_time)  return toast('Enter the late arrival time', 'warning');
  if (early_exit === 'yes' && !early_time) return toast('Enter the early exit time', 'warning');
  if (late_come === 'none' && early_exit === 'none') return toast('Select at least one — Late Come or Early Exit', 'warning');

  try {
    await apiPost('/attendance/late-early', {
      user_id:         parseInt(user_id),
      date,
      late_come,
      late_come_time:  late_come  === 'yes' ? late_time  : null,
      early_exit,
      early_exit_time: early_exit === 'yes' ? early_time : null,
    });
    const empName = state.employees.find(e => e.id === parseInt(user_id))?.name || '';
    toast(`Late/Early exit recorded for ${empName}`, 'success');
    closeModal();
    // Refresh both calendar and late/early list
    const [, lateEarly] = await Promise.all([fetchCalendarData(), apiGet('/attendance/late-early')]);
    state.lateEarlyRecords = lateEarly;
    // If already on the leaves view, re-render to show the new record
    if (state.view === 'leaves') renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}

function openEditLateEarlyModal(r) {
  const isLate  = !!r.is_late;
  const isEarly = !!r.is_early_exit;
  // Convert HH:MM:SS → HH:MM for time inputs
  const toInputTime = t => t ? t.slice(0, 5) : '';

  openModal(`
    <div class="modal-header" style="position:relative">
      <div class="modal-title">${I('edit')} Edit Late / Early Exit</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-danger btn-sm" onclick="deleteLateEarlyRecord(${r.id})">${I('trash')} Delete</button>
        <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
      </div>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <input class="form-control" value="${r.name}" disabled style="background:var(--bg-secondary);color:var(--text-muted)">
      </div>
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-control" value="${r.date}" disabled style="background:var(--bg-secondary);color:var(--text-muted)">
      </div>

      <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
        <div class="form-label" style="font-weight:600;margin-bottom:8px;color:var(--orange)">⏰ Late Come</div>
        <div class="form-group" style="margin-bottom:6px">
          <select class="form-control" id="le-edit-late-select" onchange="onEditLateSelectChange()">
            <option value="none" ${!isLate ? 'selected' : ''}>None (No late entry)</option>
            <option value="yes"  ${isLate  ? 'selected' : ''}>Late Come</option>
          </select>
        </div>
        <div class="form-group" id="le-edit-late-time-row" style="display:${isLate ? 'block' : 'none'};margin-bottom:0">
          <label class="form-label" style="font-size:.78rem">Arrival Time</label>
          <input type="time" class="form-control" id="le-edit-late-time" value="${toInputTime(r.check_in)}">
        </div>
      </div>

      <div style="border:1px solid var(--border);border-radius:10px;padding:14px">
        <div class="form-label" style="font-weight:600;margin-bottom:8px;color:var(--purple)">◀ Early Exit</div>
        <div class="form-group" style="margin-bottom:6px">
          <select class="form-control" id="le-edit-early-select" onchange="onEditEarlySelectChange()">
            <option value="none" ${!isEarly ? 'selected' : ''}>None (No early exit)</option>
            <option value="yes"  ${isEarly  ? 'selected' : ''}>Early Exit</option>
          </select>
        </div>
        <div class="form-group" id="le-edit-early-time-row" style="display:${isEarly ? 'block' : 'none'};margin-bottom:0">
          <label class="form-label" style="font-size:.78rem">Exit Time</label>
          <input type="time" class="form-control" id="le-edit-early-time" value="${toInputTime(r.check_out)}">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditLateEarly(${r.id})">Save Changes</button>
    </div>`, 'modal-md');
}

function onEditLateSelectChange() {
  const val = document.getElementById('le-edit-late-select')?.value;
  const row = document.getElementById('le-edit-late-time-row');
  if (row) row.style.display = val === 'yes' ? 'block' : 'none';
}
function onEditEarlySelectChange() {
  const val = document.getElementById('le-edit-early-select')?.value;
  const row = document.getElementById('le-edit-early-time-row');
  if (row) row.style.display = val === 'yes' ? 'block' : 'none';
}

async function submitEditLateEarly(id) {
  const late_come  = document.getElementById('le-edit-late-select')?.value  || 'none';
  const late_time  = document.getElementById('le-edit-late-time')?.value;
  const early_exit = document.getElementById('le-edit-early-select')?.value || 'none';
  const early_time = document.getElementById('le-edit-early-time')?.value;

  if (late_come  === 'yes' && !late_time)  return toast('Enter the late arrival time', 'warning');
  if (early_exit === 'yes' && !early_time) return toast('Enter the early exit time', 'warning');
  if (late_come === 'none' && early_exit === 'none') return toast('Select at least one — Late Come or Early Exit', 'warning');

  try {
    await apiPut(`/attendance/late-early/${id}`, {
      late_come,
      late_come_time:  late_come  === 'yes' ? late_time  : null,
      early_exit,
      early_exit_time: early_exit === 'yes' ? early_time : null,
    });
    toast('Record updated', 'success');
    closeModal();
    const [, lateEarly] = await Promise.all([fetchCalendarData(), apiGet('/attendance/late-early')]);
    state.lateEarlyRecords = lateEarly;
    if (state.view === 'leaves') renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteLateEarlyRecord(id) {
  if (!confirm('Remove this late/early exit record?')) return;
  try {
    await apiDelete(`/attendance/late-early/${id}`);
    toast('Record deleted', 'success');
    closeModal();
    const [, lateEarly] = await Promise.all([fetchCalendarData(), apiGet('/attendance/late-early')]);
    state.lateEarlyRecords = lateEarly;
    if (state.view === 'leaves') renderLeavesView();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYEES
// ══════════════════════════════════════════════════════════════════════════════
async function loadEmployees() {
  setHeaderTitle('Employees', 'Manage team members');
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;
  try {
    await fetchEmployees();
    const allUsers = await apiGet('/employees');
    renderEmployeesView(allUsers);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}
function renderEmployeesView(users) {
  const content = document.getElementById('content');
  const COLORS = ['#4F46E5','#10B981','#F59E0B','#EF4444','#8B5CF6','#F97316','#06B6D4','#EC4899'];
  content.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Team Members</div><div class="page-subtitle">${users.length} total members</div></div>
      <button class="btn btn-primary" onclick="openAddEmployeeModal()">${I('plus')} Add Employee</button>
    </div>
    <div class="employees-grid">
      ${users.map(u => `
        <div class="employee-card">
          <div class="employee-card-header">
            <div class="employee-avatar-lg" style="background:${u.avatar_color||'#4F46E5'}">${initials(u.name)}</div>
            <div>
              <div class="employee-name">${u.name}</div>
              <div class="employee-position">${u.position}</div>
              <span class="employee-role-badge ${u.role}">${u.role}</span>
            </div>
          </div>
          <div>
            <div class="employee-dept">🏢 ${u.department}</div>
            <div class="employee-email">✉ ${u.email}</div>
          </div>
          <div class="employee-card-actions">
            <button class="btn btn-outline btn-sm" onclick='openEditEmployeeModal(${JSON.stringify(u)})'>${I('edit')} Edit</button>
            ${u.id !== state.user.id ? `<button class="btn btn-danger btn-sm" onclick="deleteEmployee(${u.id},'${u.name}')">${I('trash')}</button>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
}
function openAddEmployeeModal() {
  const colors = ['#4F46E5','#10B981','#F59E0B','#EF4444','#8B5CF6','#F97316','#06B6D4','#EC4899'];
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Add Employee</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Full Name</label>
          <input class="form-control" id="emp-name" placeholder="John Doe" required />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-control" type="email" id="emp-email" placeholder="john@company.com" required />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input class="form-control" type="password" id="emp-password" placeholder="Min 6 characters" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Department</label>
          <input class="form-control" id="emp-dept" placeholder="Engineering" />
        </div>
        <div class="form-group">
          <label class="form-label">Position</label>
          <input class="form-control" id="emp-pos" placeholder="Developer" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-control" id="emp-role">
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Avatar Color</label>
          <select class="form-control" id="emp-color">
            ${colors.map(c => `<option value="${c}" style="background:${c};color:#fff">${c}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddEmployee()">Add Employee</button>
    </div>`);
}
async function submitAddEmployee() {
  try {
    await apiPost('/employees', {
      name:         document.getElementById('emp-name').value,
      email:        document.getElementById('emp-email').value,
      password:     document.getElementById('emp-password').value,
      department:   document.getElementById('emp-dept').value || 'General',
      position:     document.getElementById('emp-pos').value  || 'Staff',
      role:         document.getElementById('emp-role').value,
      avatar_color: document.getElementById('emp-color').value,
    });
    toast('Employee added!', 'success');
    closeModal();
    loadEmployees();
  } catch (err) { toast(err.message, 'error'); }
}
function openEditEmployeeModal(u) {
  const colors = ['#4F46E5','#10B981','#F59E0B','#EF4444','#8B5CF6','#F97316','#06B6D4','#EC4899'];
  openModal(`
    <div class="modal-header">
      <div class="modal-title">Edit Employee</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()">${I('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Full Name</label>
          <input class="form-control" id="ee-name" value="${u.name}" required />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-control" type="email" id="ee-email" value="${u.email}" required />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">New Password (leave blank to keep current)</label>
        <input class="form-control" type="password" id="ee-password" placeholder="Leave blank to keep" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Department</label>
          <input class="form-control" id="ee-dept" value="${u.department||''}" />
        </div>
        <div class="form-group">
          <label class="form-label">Position</label>
          <input class="form-control" id="ee-pos" value="${u.position||''}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-control" id="ee-role">
            <option value="employee" ${u.role==='employee'?'selected':''}>Employee</option>
            <option value="admin"    ${u.role==='admin'   ?'selected':''}>Admin</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Avatar Color</label>
          <select class="form-control" id="ee-color">
            ${colors.map(c => `<option value="${c}" ${c===u.avatar_color?'selected':''} style="background:${c};color:#fff">${c}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditEmployee(${u.id})">Save Changes</button>
    </div>`);
}
async function submitEditEmployee(id) {
  try {
    const body = {
      name:         document.getElementById('ee-name').value,
      email:        document.getElementById('ee-email').value,
      department:   document.getElementById('ee-dept').value,
      position:     document.getElementById('ee-pos').value,
      role:         document.getElementById('ee-role').value,
      avatar_color: document.getElementById('ee-color').value,
    };
    const pw = document.getElementById('ee-password').value;
    if (pw) body.password = pw;
    await apiPut(`/employees/${id}`, body);
    toast('Employee updated!', 'success');
    closeModal();
    loadEmployees();
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteEmployee(id, name) {
  if (!confirm(`Delete ${name}? This will also remove all their attendance records.`)) return;
  try {
    await apiDelete(`/employees/${id}`);
    toast(`${name} deleted`, 'warning');
    loadEmployees();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════════
async function loadSettings() {
  setHeaderTitle('Settings', 'Configure work schedule and integrations');
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;
  try {
    const { schedule, clockify } = await apiGet('/settings');
    state.settings = { schedule, clockify };
    renderSettingsView(schedule, clockify);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}
function renderSettingsView(s, c) {
  const content = document.getElementById('content');
  const isAdmin = state.user.role === 'admin';
  const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const workDays = (s.work_days || '1,2,3,4,5').split(',').map(Number);

  content.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Settings</div></div>
    </div>
    <div class="settings-grid">
      <!-- Work Schedule -->
      <div class="card">
        <div class="card-header"><div class="card-title">🕒 Work Schedule</div></div>
        <div class="card-body">
          <div class="settings-section">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Work Start Time</label>
                <input type="time" class="form-control" id="s-start" value="${s.start_time}" ${!isAdmin?'disabled':''} />
              </div>
              <div class="form-group">
                <label class="form-label">Work End Time</label>
                <input type="time" class="form-control" id="s-end" value="${s.end_time}" ${!isAdmin?'disabled':''} />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Late Entry Threshold</label>
                <input type="time" class="form-control" id="s-late" value="${s.late_threshold}" ${!isAdmin?'disabled':''} />
                <div class="form-hint">Check-in after this time = Late</div>
              </div>
              <div class="form-group">
                <label class="form-label">Early Exit Threshold</label>
                <input type="time" class="form-control" id="s-early" value="${s.early_exit_threshold}" ${!isAdmin?'disabled':''} />
                <div class="form-hint">Check-out before this time = Early Exit</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Half Day Threshold (hours)</label>
              <input type="number" class="form-control" id="s-halfday" value="${s.half_day_hours}" step="0.5" min="1" max="8" ${!isAdmin?'disabled':''} />
              <div class="form-hint">Work hours below this = Half Day</div>
            </div>
            <div class="form-group">
              <label class="form-label">Working Days</label>
              <div class="flex gap-2" style="flex-wrap:wrap">
                ${dayLabels.map((d,i) => `
                  <label style="display:flex;align-items:center;gap:4px;font-size:.83rem;cursor:pointer">
                    <input type="checkbox" id="wd-${i}" ${workDays.includes(i)?'checked':''} ${!isAdmin?'disabled':''} />
                    ${d}
                  </label>`).join('')}
              </div>
            </div>
            ${isAdmin ? `
              <button class="btn btn-primary" onclick="saveScheduleSettings()">Save Schedule</button>` : `
              <div style="font-size:.8rem;color:var(--text-muted)">Only admins can modify schedule settings.</div>`}
          </div>
        </div>
      </div>

      <!-- Clockify Integration -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⏱ Clockify Integration</div>
          <div class="clockify-badge">${I('clock')} Clockify</div>
        </div>
        <div class="card-body">
          <div class="settings-section">
            <div style="background:var(--info-light);border:1px solid var(--info);border-radius:var(--radius-sm);padding:12px;font-size:.83rem;color:var(--info);margin-bottom:16px">
              ${I('info')} Connect your Clockify workspace to automatically sync work hours.
              Get your API key from <strong>clockify.me → Profile Settings → API</strong>
            </div>
            <div class="form-group">
              <label class="form-label">Clockify API Key</label>
              <input class="form-control" type="password" id="c-apikey" placeholder="${c?.api_key ? '••••••••••' : 'Enter your API key'}" ${!isAdmin?'disabled':''} />
            </div>
            <div class="form-group">
              <label class="form-label">Workspace ID</label>
              <input class="form-control" id="c-wsid" value="${c?.workspace_id||''}" placeholder="Enter workspace ID" ${!isAdmin?'disabled':''} />
              <div class="form-hint">Found in Clockify URL: clockify.me/workspaces/<strong>[ID]</strong>/settings</div>
            </div>
            ${c?.last_synced ? `<div class="text-sm text-muted">Last synced: ${new Date(c.last_synced).toLocaleString()}</div>` : ''}
            ${isAdmin ? `
              <div class="flex gap-2" style="flex-wrap:wrap">
                <button class="btn btn-primary" onclick="saveClockifySettings()">${I('check')} Save Config</button>
                <button class="btn btn-outline" onclick="testClockifyConnection()">${I('sync')} Test Connection</button>
                <button class="btn btn-outline" onclick="syncClockifyToday()">${I('sync')} Sync Today</button>
              </div>` : `
              <div style="font-size:.8rem;color:var(--text-muted)">Only admins can configure Clockify.</div>`}
          </div>
        </div>
      </div>

      <!-- Status Legend -->
      <div class="card">
        <div class="card-header"><div class="card-title">🎨 Status Legend</div></div>
        <div class="card-body">
          <div style="display:flex;flex-direction:column;gap:10px">
            ${[
              { label:'Present',    color:'#10B981', desc:'Full day attendance' },
              { label:'Absent',     color:'#EF4444', desc:'Not present, no leave applied' },
              { label:'On Leave',   color:'#F59E0B', desc:'Approved leave' },
              { label:'Half Day',   color:'#3B82F6', desc:`Work hours below ${s.half_day_hours}h threshold` },
              { label:'Late Entry', color:'#F97316', desc:`Check-in after ${s.late_threshold}` },
              { label:'Early Exit', color:'#8B5CF6', desc:`Check-out before ${s.early_exit_threshold}` },
            ].map(item => `
              <div class="flex items-center gap-2">
                <div style="width:14px;height:14px;border-radius:50%;background:${item.color};flex-shrink:0"></div>
                <div>
                  <strong style="font-size:.85rem">${item.label}</strong>
                  <span style="font-size:.8rem;color:var(--text-muted);margin-left:6px">${item.desc}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <!-- Profile -->
      <div class="card">
        <div class="card-header"><div class="card-title">👤 My Profile</div></div>
        <div class="card-body">
          <div class="flex items-center gap-3" style="margin-bottom:16px">
            <div style="width:56px;height:56px;border-radius:50%;background:${state.user.avatar_color||'#4F46E5'};display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:800;color:#fff">${initials(state.user.name)}</div>
            <div>
              <div style="font-size:1rem;font-weight:700">${state.user.name}</div>
              <div style="font-size:.8rem;color:var(--text-muted)">${state.user.email}</div>
              <span class="employee-role-badge ${state.user.role}" style="margin-top:4px;display:inline-block">${state.user.role}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:.875rem">
            <div><strong>Department:</strong> ${state.user.department || '—'}</div>
            <div><strong>Position:</strong>   ${state.user.position   || '—'}</div>
          </div>
        </div>
      </div>
    </div>`;
}
async function saveScheduleSettings() {
  const workDays = [0,1,2,3,4,5,6].filter(i => document.getElementById(`wd-${i}`)?.checked).join(',');
  try {
    await apiPut('/settings', {
      start_time:            document.getElementById('s-start').value,
      end_time:              document.getElementById('s-end').value,
      late_threshold:        document.getElementById('s-late').value,
      early_exit_threshold:  document.getElementById('s-early').value,
      half_day_hours:        parseFloat(document.getElementById('s-halfday').value),
      work_days:             workDays,
    });
    toast('Work schedule saved!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
async function saveClockifySettings() {
  const key  = document.getElementById('c-apikey').value;
  const wsid = document.getElementById('c-wsid').value;
  if (!key && !wsid) return toast('Enter API key and Workspace ID', 'warning');
  try {
    await apiPut('/settings/clockify', { api_key: key, workspace_id: wsid });
    toast('Clockify settings saved!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
async function testClockifyConnection() {
  try {
    await saveClockifySettings();
    const workspaces = await apiGet('/clockify/workspaces');
    toast(`Connected! Found ${workspaces.length} workspace(s)`, 'success');
  } catch (err) { toast('Connection failed: ' + err.message, 'error'); }
}
async function syncClockifyToday() {
  try {
    toast('Syncing Clockify data for today…', 'info');
    const result = await apiPost('/clockify/sync', { date: todayStr() });
    toast(`Synced ${result.synced} users from Clockify`, 'success');
  } catch (err) { toast('Sync failed: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
async function init() {
  if (loadAuth()) {
    // Verify token is still valid
    try {
      const me = await apiGet('/auth/me');
      state.user = { ...state.user, ...me };
      navigate('dashboard');
    } catch {
      logout();
    }
  } else {
    navigate('login');
  }
}

// Expose globals for onclick handlers
window.doCheckIn          = doCheckIn;
window.doCheckOut         = doCheckOut;
window.navigate           = navigate;
window.logout             = logout;
window.closeModal         = closeModal;
window.openDayModal       = openDayModal;
window.calNavPrev         = calNavPrev;
window.calNavNext         = calNavNext;
window.calToday           = calToday;
window.setCalMode         = setCalMode;
window.syncClockifyDay    = syncClockifyDay;
window.stopClockifyLive   = stopClockifyLive;
window.openApplyLeaveModal   = openApplyLeaveModal;
window.onLeaveTimeChange     = onLeaveTimeChange;
window.onQLLeaveTimeChange   = onQLLeaveTimeChange;
window.openEditLeaveModal    = openEditLeaveModal;
window.submitEditLeave       = submitEditLeave;
window.onEditLeaveTimeChange = onEditLeaveTimeChange;
window.onLeavesDateFilter    = onLeavesDateFilter;
window.deleteLeave           = deleteLeave;
window.openLateEarlyModal     = openLateEarlyModal;
window.submitLateEarly        = submitLateEarly;
window.onLateSelectChange     = onLateSelectChange;
window.onEarlySelectChange    = onEarlySelectChange;
window.openEditLateEarlyModal = openEditLateEarlyModal;
window.submitEditLateEarly    = submitEditLateEarly;
window.deleteLateEarlyRecord  = deleteLateEarlyRecord;
window.onEditLateSelectChange = onEditLateSelectChange;
window.onEditEarlySelectChange = onEditEarlySelectChange;
window.addAnotherLeaveForm = addAnotherLeaveForm;
window.removeLeaveForm     = removeLeaveForm;
window.submitAllLeaves     = submitAllLeaves;
window.submitQuickLeave    = submitQuickLeave;
window.setLeavesTab       = setLeavesTab;
window.approveLeave       = approveLeave;
window.rejectLeave        = rejectLeave;
window.cancelLeave        = cancelLeave;
window.openAddEmployeeModal  = openAddEmployeeModal;
window.submitAddEmployee     = submitAddEmployee;
window.openEditEmployeeModal = openEditEmployeeModal;
window.submitEditEmployee    = submitEditEmployee;
window.deleteEmployee        = deleteEmployee;
window.saveScheduleSettings  = saveScheduleSettings;
window.saveClockifySettings  = saveClockifySettings;
window.testClockifyConnection = testClockifyConnection;
window.syncClockifyToday     = syncClockifyToday;

// Boot
init();
