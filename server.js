require('dotenv').config();
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const axios    = require('axios');
const path     = require('path');
const { supabase, seed } = require('./db');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'leave-tracker-secret-2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
// Flatten Supabase join: { ...record, users: { name, ... } } → { ...record, name, ... }
function flat(records, joinKey = 'users') {
  return (records || []).map(r => {
    const joined = r[joinKey] || {};
    const copy   = { ...r, ...joined };
    delete copy[joinKey];
    return copy;
  });
}
function flatOne(record, joinKey = 'users') {
  if (!record) return null;
  const joined = record[joinKey] || {};
  const copy   = { ...record, ...joined };
  delete copy[joinKey];
  return copy;
}
async function getSettings() {
  const { data } = await supabase.from('work_schedule').select('*').limit(1).single();
  return data;
}
function toMinutes(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}
function isWorkingDay(dateStr, settings) {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  return (settings.work_days || '1,2,3,4,5').split(',').map(Number).includes(day);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user } = await supabase.from('users').select('*')
      .eq('email', email.toLowerCase().trim()).maybeSingle();

    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '24h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, position: user.position, avatar_color: user.avatar_color } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { data } = await supabase.from('users')
    .select('id, name, email, role, department, position, avatar_color').eq('id', req.user.id).single();
  res.json(data);
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const realToday = new Date().toISOString().split('T')[0];
    const today     = req.query.date || realToday;   // use date filter if provided
    const isToday   = today === realToday;

    // ── 1. Get all employees (never include admin) ───────────────────────────
    const { data: allEmployees } = await supabase.from('users')
      .select('id, name, avatar_color, department, clockify_user_id').eq('role', 'employee');
    const totalEmployees = allEmployees.length;
    const empIds         = allEmployees.map(e => e.id);

    // ── 2. Selected date attendance — employees only ─────────────────────────
    const { data: todayRaw } = await supabase.from('attendance')
      .select('*, users(name, avatar_color, department)')
      .eq('date', today).in('user_id', empIds);
    const todayRecords = flat(todayRaw);

    // ── 3. Clockify live — only meaningful for today ──────────────────────────
    const clockifyActiveIds = new Set();
    if (isToday) {
      try {
        const { data: config } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
        if (config?.api_key && config.api_key !== '' && config?.workspace_id) {
          await Promise.all(allEmployees.filter(e => e.clockify_user_id).map(async emp => {
            try {
              const resp = await axios.get(
                `https://api.clockify.me/api/v1/workspaces/${config.workspace_id}/user/${emp.clockify_user_id}/time-entries`,
                { headers: { 'X-Api-Key': config.api_key }, params: { 'in-progress': true, 'page-size': 1 } }
              );
              if ((resp.data || []).some(e => !e.timeInterval?.end)) clockifyActiveIds.add(emp.id);
            } catch { /* individual failure is ok */ }
          }));
        }
      } catch { /* Clockify unavailable — degrade gracefully */ }
    }

    // ── 4. Calculate stats ────────────────────────────────────────────────────
    const onLeaveIds    = new Set(todayRecords.filter(r => r.status === 'on_leave').map(r => r.user_id));
    const onLeaveToday  = onLeaveIds.size;
    const presentToday  = Math.max(0, totalEmployees - onLeaveToday);
    const onClockify    = isToday ? [...clockifyActiveIds].filter(id => !onLeaveIds.has(id)).length : null;
    const notOnClockify = isToday ? Math.max(0, presentToday - onClockify) : null;
    const lateToday      = todayRecords.filter(r => r.is_late).length;
    const earlyExitToday = todayRecords.filter(r => r.is_early_exit).length;
    const halfDayToday   = todayRecords.filter(r => r.status === 'half_day').length;
    const wfhToday       = todayRecords.filter(r => r.status === 'wfh').length;

    // ── 5. Activity for selected date ─────────────────────────────────────────
    const activityMap = new Map();
    for (const r of todayRecords) {
      activityMap.set(r.user_id, { ...r, clockify_live: clockifyActiveIds.has(r.user_id) });
    }
    if (isToday) {
      for (const id of clockifyActiveIds) {
        if (!activityMap.has(id) && !onLeaveIds.has(id)) {
          const emp = allEmployees.find(e => e.id === id);
          if (emp) activityMap.set(id, { user_id: emp.id, name: emp.name, avatar_color: emp.avatar_color, department: emp.department, status: 'present', check_in: null, clockify_live: true });
        }
      }
    }
    const recentActivity = [...activityMap.values()].slice(0, 15);

    // ── 6. Pending leaves ────────────────────────────────────────────────────
    const { count: pendingLeaves } = await supabase.from('leaves')
      .select('*', { count: 'exact', head: true }).eq('status', 'pending');

    let pendingLeaveList;
    if (req.user.role === 'admin') {
      const { data: plRaw } = await supabase.from('leaves')
        .select('*, users(name, email, department, avatar_color)')
        .eq('status', 'pending').order('created_at', { ascending: false }).limit(5);
      pendingLeaveList = flat(plRaw);
    } else {
      const { data: plRaw } = await supabase.from('leaves')
        .select('*, users(name)').eq('user_id', req.user.id)
        .order('created_at', { ascending: false }).limit(5);
      pendingLeaveList = flat(plRaw);
    }

    const { data: myToday } = await supabase.from('attendance')
      .select('*').eq('user_id', req.user.id).eq('date', today).maybeSingle();

    res.json({ totalEmployees, presentToday, onLeaveToday, onClockify, notOnClockify, lateToday, earlyExitToday, halfDayToday, wfhToday, pendingLeaves, recentActivity, pendingLeaveList, myToday, today, isToday });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Employees ────────────────────────────────────────────────────────────────
app.get('/api/employees', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('users')
      .select('id, name, email, role, department, position, avatar_color, created_at')
      .order('name');
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, department, position, avatar_color } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
    const hashed = bcrypt.hashSync(password, 10);
    const { data, error } = await supabase.from('users')
      .insert({ name, email: email.toLowerCase(), password: hashed, role: role||'employee', department: department||'General', position: position||'Staff', avatar_color: avatar_color||'#4F46E5' })
      .select('id, name, email, role, department, position, avatar_color').single();
    if (error?.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/employees/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, role, department, position, avatar_color, password } = req.body;
    const update = { name, email, role, department, position, avatar_color };
    if (password) update.password = bcrypt.hashSync(password, 10);
    const { data } = await supabase.from('users').update(update).eq('id', req.params.id)
      .select('id, name, email, role, department, position, avatar_color').single();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/employees/:id', auth, adminOnly, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    await supabase.from('users').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Attendance ───────────────────────────────────────────────────────────────
app.get('/api/attendance', auth, async (req, res) => {
  try {
    const { year, month, date, userId } = req.query;

    let query = supabase.from('attendance')
      .select('*, users!inner(name, email, avatar_color, department, position)')
      .eq('users.role', 'employee')
      .order('date', { ascending: true });

    if (req.user.role !== 'admin') {
      query = query.eq('user_id', req.user.id);
    } else if (userId && userId !== 'all') {
      query = query.eq('user_id', parseInt(userId));
    }

    if (date) {
      query = query.eq('date', date);
    } else if (year && month) {
      query = query.like('date', `${year}-${String(month).padStart(2,'0')}-%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(flat(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from('attendance')
      .select('*').eq('user_id', req.user.id).eq('date', today).maybeSingle();
    res.json(data || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/checkin', auth, async (req, res) => {
  try {
    const today   = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().substring(0, 5);
    const settings = await getSettings();

    const { data: existing } = await supabase.from('attendance')
      .select('*').eq('user_id', req.user.id).eq('date', today).maybeSingle();

    if (existing?.check_in) return res.status(400).json({ error: 'Already checked in today' });

    const is_late = toMinutes(timeStr) > toMinutes(settings.late_threshold);

    let record;
    if (existing) {
      const { data } = await supabase.from('attendance')
        .update({ check_in: timeStr, status: 'present', is_late })
        .eq('id', existing.id).select().single();
      record = data;
    } else {
      const { data } = await supabase.from('attendance')
        .insert({ user_id: req.user.id, date: today, check_in: timeStr, status: 'present', is_late })
        .select().single();
      record = data;
    }
    res.json({ record, message: is_late ? 'Checked in (Late)' : 'Checked in successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/checkout', auth, async (req, res) => {
  try {
    const today   = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().substring(0, 5);
    const settings = await getSettings();

    const { data: record } = await supabase.from('attendance')
      .select('*').eq('user_id', req.user.id).eq('date', today).maybeSingle();

    if (!record?.check_in) return res.status(400).json({ error: 'You have not checked in today' });
    if (record.check_out)  return res.status(400).json({ error: 'Already checked out today' });

    const workHours    = Math.max(0, (toMinutes(timeStr) - toMinutes(record.check_in)) / 60);
    const is_early_exit = toMinutes(timeStr) < toMinutes(settings.early_exit_threshold);
    const status       = workHours < settings.half_day_hours ? 'half_day' : 'present';

    const { data: updated } = await supabase.from('attendance')
      .update({ check_out: timeStr, work_hours: Math.round(workHours * 100) / 100, status, is_early_exit })
      .eq('id', record.id).select().single();

    const msgs = [];
    if (is_early_exit)        msgs.push('Early exit noted');
    if (status === 'half_day') msgs.push('Half day recorded');
    res.json({ record: updated, message: msgs.length ? msgs.join(', ') : 'Checked out successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/attendance/:id', auth, adminOnly, async (req, res) => {
  try {
    const { check_in, check_out, status, is_late, is_early_exit, notes } = req.body;
    const work_hours = check_in && check_out
      ? Math.max(0, (toMinutes(check_out) - toMinutes(check_in)) / 60) : 0;
    const { data } = await supabase.from('attendance')
      .update({ check_in, check_out, status, is_late: !!is_late, is_early_exit: !!is_early_exit, work_hours: Math.round(work_hours * 100) / 100, notes })
      .eq('id', req.params.id).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/mark-absent', auth, adminOnly, async (req, res) => {
  try {
    const { user_id, date } = req.body;
    await supabase.from('attendance')
      .upsert({ user_id, date, status: 'absent' }, { onConflict: 'user_id,date' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark late come / early exit for an employee on a given date
app.post('/api/attendance/late-early', auth, adminOnly, async (req, res) => {
  try {
    const { user_id, date, late_come, late_come_time, early_exit, early_exit_time } = req.body;
    if (!user_id || !date) return res.status(400).json({ error: 'user_id and date are required' });

    // Fetch existing record for the day
    const { data: existing } = await supabase.from('attendance')
      .select('*').eq('user_id', user_id).eq('date', date).maybeSingle();

    const updates = {};
    if (late_come === 'yes' && late_come_time)  { updates.is_late      = true;  updates.check_in  = late_come_time;  }
    if (late_come === 'none')                    { updates.is_late      = false; }
    if (early_exit === 'yes' && early_exit_time){ updates.is_early_exit = true;  updates.check_out = early_exit_time; }
    if (early_exit === 'none')                   { updates.is_early_exit = false; }

    // Recalculate work hours if both times known
    const ci = updates.check_in  || existing?.check_in;
    const co = updates.check_out || existing?.check_out;
    if (ci && co) {
      const work_hours = Math.max(0, (toMinutes(co) - toMinutes(ci)) / 60);
      updates.work_hours = Math.round(work_hours * 100) / 100;
    }

    if (existing) {
      await supabase.from('attendance').update(updates).eq('id', existing.id);
    } else {
      // No record yet — create one with status present
      await supabase.from('attendance').insert({
        user_id, date,
        status: 'present',
        is_late:       updates.is_late      ?? false,
        is_early_exit: updates.is_early_exit ?? false,
        check_in:      updates.check_in  || null,
        check_out:     updates.check_out || null,
        work_hours:    updates.work_hours || 0,
      });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Return attendance records where is_late or is_early_exit, joined with user info
app.get('/api/attendance/late-early', auth, async (req, res) => {
  try {
    // Scope to employees only (never show admin in this list)
    const { data: empRows } = await supabase.from('users').select('id').eq('role', 'employee');
    const empIds = (empRows || []).map(e => e.id);

    let query = supabase.from('attendance')
      .select('*, users(name, email, avatar_color, department)')
      .or('is_late.eq.true,is_early_exit.eq.true')
      .in('user_id', empIds)
      .order('date', { ascending: false });

    // Optional date filter
    if (req.query.date) query = query.eq('date', req.query.date);

    // Employees see only their own records
    if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const result = (data || []).map(r => ({ ...r, ...r.users, users: undefined }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update late/early flags on an existing attendance record
app.put('/api/attendance/late-early/:id', auth, adminOnly, async (req, res) => {
  try {
    const { late_come, late_come_time, early_exit, early_exit_time } = req.body;

    const { data: existing, error: fetchErr } = await supabase.from('attendance')
      .select('*').eq('id', req.params.id).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Record not found' });

    const updates = {};
    if (late_come === 'yes' && late_come_time)   { updates.is_late       = true;  updates.check_in  = late_come_time;  }
    if (late_come === 'none')                     { updates.is_late       = false; updates.check_in  = null; }
    if (early_exit === 'yes' && early_exit_time) { updates.is_early_exit = true;  updates.check_out = early_exit_time; }
    if (early_exit === 'none')                   { updates.is_early_exit = false; updates.check_out = null; }

    const ci = updates.check_in  ?? existing.check_in;
    const co = updates.check_out ?? existing.check_out;
    if (ci && co) updates.work_hours = Math.round(Math.max(0, (toMinutes(co) - toMinutes(ci)) / 60) * 100) / 100;

    await supabase.from('attendance').update(updates).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear late/early flags from an attendance record
app.delete('/api/attendance/late-early/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('attendance')
      .select('*').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    await supabase.from('attendance')
      .update({ is_late: false, is_early_exit: false, check_in: null, check_out: null })
      .eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Leaves ───────────────────────────────────────────────────────────────────
app.get('/api/leaves', auth, async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    let query = supabase.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email, avatar_color, department), approver:users!leaves_approved_by_fkey(name)')
      .order('created_at', { ascending: false });

    if (req.user.role !== 'admin') {
      query = query.eq('user_id', req.user.id);
    } else if (userId) {
      query = query.eq('user_id', parseInt(userId));
    }
    if (year && month) {
      const ym = `${year}-${String(month).padStart(2,'0')}`;
      query = query.lte('start_date', `${ym}-31`).gte('end_date', `${ym}-01`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const result = (data || []).map(l => ({
      ...l,
      ...l.users,
      approver_name: l.approver?.name,
      users:    undefined,
      approver: undefined,
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leaves', auth, async (req, res) => {
  try {
    const { start_date, end_date, leave_type, reason, user_id, leave_time, half_type } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end dates required' });
    if (start_date > end_date)    return res.status(400).json({ error: 'Start date must be before end date' });

    // Admin can apply leave on behalf of any employee
    const targetUserId = (req.user.role === 'admin' && user_id) ? parseInt(user_id) : req.user.id;

    const { data, error } = await supabase.from('leaves')
      .insert({
        user_id: targetUserId, start_date, end_date,
        leave_type: leave_type||'casual', reason: reason||'',
        leave_time: leave_time||'full',
        half_type:  leave_time === 'half' ? (half_type||'first_half') : null
      })
      .select('*, users!leaves_user_id_fkey(name)').single();
    if (error) throw new Error(error.message);
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leaves/:id', auth, async (req, res) => {
  try {
    const { data: leave } = await supabase.from('leaves').select('*').eq('id', req.params.id).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (req.user.role !== 'admin' && leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (leave.status === 'approved' && req.user.role !== 'admin') return res.status(400).json({ error: 'Cannot edit an approved leave' });

    const { start_date, end_date, leave_type, reason, leave_time, half_type } = req.body;
    if (start_date && end_date && start_date > end_date) return res.status(400).json({ error: 'Start date must be before end date' });

    await supabase.from('leaves').update({
      ...(start_date && { start_date }),
      ...(end_date   && { end_date }),
      ...(leave_type && { leave_type }),
      reason: reason ?? leave.reason,
      leave_time: leave_time || leave.leave_time,
      half_type:  (leave_time || leave.leave_time) === 'half' ? (half_type || leave.half_type || 'first_half') : null,
    }).eq('id', req.params.id);

    const { data } = await supabase.from('leaves').select('*, users!leaves_user_id_fkey(name)').eq('id', req.params.id).single();
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leaves/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const { data: leave, error: le } = await supabase.from('leaves').select('*').eq('id', req.params.id).single();
    if (le) return res.status(404).json({ error: 'Leave not found' });

    await supabase.from('leaves').update({ status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString() }).eq('id', req.params.id);

    // Mark attendance days as on_leave
    const settings = await getSettings();
    const start = new Date(leave.start_date + 'T12:00:00');
    const end   = new Date(leave.end_date   + 'T12:00:00');
    const upserts = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      if (isWorkingDay(ds, settings)) upserts.push({ user_id: leave.user_id, date: ds, status: leave.leave_time === 'half' ? 'half_day' : leave.leave_time === 'wfh' ? 'wfh' : 'on_leave' });
    }
    if (upserts.length) await supabase.from('attendance').upsert(upserts, { onConflict: 'user_id,date' });

    const { data } = await supabase.from('leaves').select('*, users!leaves_user_id_fkey(name)').eq('id', req.params.id).single();
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leaves/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    await supabase.from('leaves').update({ status: 'rejected', approved_by: req.user.id, approved_at: new Date().toISOString() }).eq('id', req.params.id);
    const { data } = await supabase.from('leaves').select('*, users!leaves_user_id_fkey(name)').eq('id', req.params.id).single();
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clean up attendance records with leave-based status but no approved leave backing them
app.post('/api/attendance/cleanup-orphaned', auth, async (req, res) => {
  try {
    const { data: leaveAttendance } = await supabase.from('attendance')
      .select('id, user_id, date, status')
      .in('status', ['on_leave', 'half_day', 'wfh']);

    if (!leaveAttendance?.length) return res.json({ removed: 0 });

    const { data: approvedLeaves } = await supabase.from('leaves')
      .select('user_id, start_date, end_date, leave_time')
      .eq('status', 'approved');

    const toDelete = [];
    for (const att of leaveAttendance) {
      const hasLeave = (approvedLeaves || []).some(l => {
        if (l.user_id !== att.user_id) return false;
        if (att.date < l.start_date || att.date > l.end_date) return false;
        const expected = l.leave_time === 'half' ? 'half_day' : l.leave_time === 'wfh' ? 'wfh' : 'on_leave';
        return att.status === expected;
      });
      if (!hasLeave) toDelete.push(att.id);
    }

    if (toDelete.length) await supabase.from('attendance').delete().in('id', toDelete);
    res.json({ removed: toDelete.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leaves/:id', auth, async (req, res) => {
  try {
    const { data: leave } = await supabase.from('leaves').select('*').eq('id', req.params.id).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (req.user.role !== 'admin' && leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (leave.status === 'approved' && req.user.role !== 'admin') return res.status(400).json({ error: 'Cannot cancel approved leave' });

    // If leave was approved, remove the attendance records that were created for those dates
    if (leave.status === 'approved') {
      const settings = await getSettings();
      const start = new Date(leave.start_date + 'T12:00:00');
      const end   = new Date(leave.end_date   + 'T12:00:00');
      const dates = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split('T')[0];
        if (isWorkingDay(ds, settings)) dates.push(ds);
      }
      if (dates.length) {
        await supabase.from('attendance')
          .delete()
          .eq('user_id', leave.user_id)
          .in('date', dates);
      }
    }

    await supabase.from('leaves').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
app.get('/api/settings', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('work_schedule').select('*').limit(1).single();
    const { data: clockify } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
    res.json({ schedule, clockify: { ...clockify, api_key: clockify?.api_key ? '***' : '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', auth, adminOnly, async (req, res) => {
  try {
    const { start_time, end_time, late_threshold, early_exit_threshold, half_day_hours, work_days } = req.body;
    const { data } = await supabase.from('work_schedule')
      .update({ start_time, end_time, late_threshold, early_exit_threshold, half_day_hours, work_days })
      .eq('id', 1).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/clockify', auth, adminOnly, async (req, res) => {
  try {
    const { api_key, workspace_id } = req.body;
    const { data: existing } = await supabase.from('clockify_config').select('id').limit(1).maybeSingle();
    if (existing) {
      await supabase.from('clockify_config').update({ api_key, workspace_id }).eq('id', existing.id);
    } else {
      await supabase.from('clockify_config').insert({ api_key, workspace_id });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Clockify ─────────────────────────────────────────────────────────────────
app.get('/api/clockify/workspaces', auth, adminOnly, async (req, res) => {
  try {
    const { data: config } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
    if (!config?.api_key || config.api_key === '') return res.status(400).json({ error: 'Clockify API key not configured' });
    const response = await axios.get('https://api.clockify.me/api/v1/workspaces', { headers: { 'X-Api-Key': config.api_key } });
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Clockify error: ' + (err.response?.data?.message || err.message) }); }
});

// Live timers — who is currently tracking right now in Clockify
app.get('/api/clockify/live', auth, async (req, res) => {
  try {
    const { data: config } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
    if (!config?.api_key || config.api_key === '') return res.json({ timers: {} });

    const { data: employees } = await supabase.from('users')
      .select('id, clockify_user_id').eq('role', 'employee');

    const timers = {};
    await Promise.all((employees || []).map(async emp => {
      if (!emp.clockify_user_id) return;
      try {
        const resp = await axios.get(
          `https://api.clockify.me/api/v1/workspaces/${config.workspace_id}/user/${emp.clockify_user_id}/time-entries`,
          { headers: { 'X-Api-Key': config.api_key }, params: { 'in-progress': true, 'page-size': 1 } }
        );
        const entries = resp.data || [];
        const active  = entries.find(e => !e.timeInterval?.end);
        timers[emp.id] = active
          ? { running: true,  start: active.timeInterval.start, description: active.description || '' }
          : { running: false };
      } catch { timers[emp.id] = { running: false }; }
    }));

    res.json({ timers });
  } catch (err) { res.json({ timers: {} }); }
});

// Fetch total hours per employee for a specific past date directly from Clockify
app.get('/api/clockify/day', auth, async (req, res) => {
  try {
    const { data: config } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
    if (!config?.api_key || !config?.workspace_id) return res.json({ hours: {} });

    const date     = req.query.date || new Date().toISOString().split('T')[0];
    const startISO = date + 'T00:00:00Z';
    const endISO   = date + 'T23:59:59Z';

    const { data: employees } = await supabase.from('users')
      .select('id, clockify_user_id').eq('role', 'employee');

    const hours = {};
    await Promise.all((employees || []).filter(e => e.clockify_user_id).map(async emp => {
      try {
        const resp = await axios.get(
          `https://api.clockify.me/api/v1/workspaces/${config.workspace_id}/user/${emp.clockify_user_id}/time-entries`,
          { headers: { 'X-Api-Key': config.api_key }, params: { start: startISO, end: endISO, 'page-size': 50 } }
        );
        const entries = resp.data || [];
        let totalSeconds = 0;
        for (const e of entries) {
          const m = (e.timeInterval?.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) totalSeconds += (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
        }
        if (totalSeconds > 0) hours[emp.id] = Math.round((totalSeconds / 3600) * 100) / 100;
      } catch { /* individual failure ok */ }
    }));

    res.json({ hours });
  } catch (err) { res.json({ hours: {} }); }
});

app.post('/api/clockify/sync', auth, adminOnly, async (req, res) => {
  try {
    const { data: config } = await supabase.from('clockify_config').select('*').limit(1).maybeSingle();
    if (!config?.api_key || !config?.workspace_id) return res.status(400).json({ error: 'Clockify API key and Workspace ID required' });

    const targetDate = req.body.date || new Date().toISOString().split('T')[0];
    const startISO   = targetDate + 'T00:00:00Z';
    const endISO     = targetDate + 'T23:59:59Z';

    const { data: cUsers } = await axios.get(
      `https://api.clockify.me/api/v1/workspaces/${config.workspace_id}/users`,
      { headers: { 'X-Api-Key': config.api_key } }
    );

    const results = [];
    for (const cUser of cUsers.data || cUsers) {
      const { data: localUser } = await supabase.from('users').select('*').ilike('email', cUser.email).maybeSingle();
      if (!localUser) continue;

      const { data: entriesResp } = await axios.get(
        `https://api.clockify.me/api/v1/workspaces/${config.workspace_id}/user/${cUser.id}/time-entries`,
        { headers: { 'X-Api-Key': config.api_key }, params: { start: startISO, end: endISO } }
      );
      const entries = entriesResp.data || entriesResp;

      let totalSeconds = 0;
      for (const e of entries) {
        const match = (e.timeInterval?.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (match) totalSeconds += (parseInt(match[1]||0)*3600) + (parseInt(match[2]||0)*60) + parseInt(match[3]||0);
      }
      const clockify_hours = Math.round((totalSeconds / 3600) * 100) / 100;

      await supabase.from('attendance')
        .update({ clockify_hours })
        .eq('user_id', localUser.id).eq('date', targetDate);

      results.push({ user: localUser.name, clockify_hours });
    }

    await supabase.from('clockify_config').update({ last_synced: new Date().toISOString() }).eq('id', config.id);
    res.json({ success: true, synced: results.length, results });
  } catch (err) { res.status(500).json({ error: 'Clockify sync failed: ' + (err.response?.data?.message || err.message) }); }
});

// ─── Frontend fallback ────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await seed();
    app.listen(PORT, () => {
      console.log(`\n🚀 Leave Tracker running at http://localhost:${PORT}`);
      console.log(`   Admin:    admin@company.com / admin123`);
      console.log(`   Employee: alice@company.com / password123\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
}

start();
