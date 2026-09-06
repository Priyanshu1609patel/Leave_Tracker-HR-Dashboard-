const express = require('express');
const router  = express.Router();
const { db, pool } = require('../../config/db');
const { auth, isAdminRole } = require('../../middleware/auth');
const { hasPermission } = require('../../middleware/permissions');
const { flat, flatOne, orgId, getSettings, isWorkingDay, getRecipients, localDateStr, getOrgContext } = require('../../utils/helpers');
const { sendMail, leaveAppliedHtml, leaveStatusHtml, leaveDeptApprovalHtml, leaveForwardedToRootHtml } = require('../../services/emailService');
const engine = require('../../services/leaveWorkflowEngine');

// ─── Helpers ─────────────────────────────────────────────────────────────────


async function fetchHolidaySet(oId, startDate, endDate) {
  try {
    const { data } = await db
      .from('holidays')
      .select('date')
      .eq('organization_id', oId)
      .gte('date', startDate)
      .lte('date', endDate);
    return new Set((data || []).map(h => h.date));
  } catch { return new Set(); }
}

function buildWorkingDates(startDate, endDate, settings, holidayDates = new Set()) {
  const dates = [];
  const start = new Date(startDate + 'T12:00:00');
  const end   = new Date(endDate   + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split('T')[0];
    if (isWorkingDay(ds, settings) && !holidayDates.has(ds)) dates.push(ds);
  }
  return dates;
}

// Legacy helper: find dept head for old-flow leaves.
async function findDeptHead(userId, oId) {
  const { data: user } = await db
    .from('users')
    .select('department_id, reporting_to')
    .eq('id', userId)
    .eq('organization_id', oId)
    .maybeSingle();
  if (!user) return null;

  if (user.department_id) {
    const { data: dept } = await db
      .from('departments')
      .select('head_user_id')
      .eq('id', user.department_id)
      .eq('organization_id', oId)
      .maybeSingle();
    const headId = dept?.head_user_id;
    if (headId && headId !== userId) return headId;
  }

  if (user.reporting_to && user.reporting_to !== userId) return user.reporting_to;
  return null;
}

function logApprovalAction({ leaveId, oId, actorId, actorName, action, fromStatus, toStatus, notes, level }) {
  // 'level' column only exists after the workflow migration — omit it safely when null
  const row = {
    leave_id:    leaveId,
    org_id:      oId,
    actor_id:    actorId,
    actor_name:  actorName || null,
    action,
    from_status: fromStatus || null,
    to_status:   toStatus   || null,
    notes:       notes      || null,
  };
  if (level != null) row.level = level;
  return db.from('leave_approval_log').insert(row).then(() => {}).catch(e => console.error('[leave_approval_log] insert failed:', e.message));
}

function notify(userId, title, message, oId) {
  db.from('notifications').insert({
    user_id: userId, title, message, type: 'leave', organization_id: oId,
  }).then(() => {});
}

// BUG_096: notify all HR admins and root admins in the org (fire-and-forget)
async function notifyAdmins(oId, title, message, excludeUserId) {
  try {
    const query = db.from('users')
      .select('id')
      .eq('organization_id', oId)
      .in('role', ['admin', 'root_admin']);
    if (excludeUserId) query.neq('id', excludeUserId);
    const { data: admins } = await query;
    for (const admin of admins || []) {
      notify(admin.id, title, message, oId);
    }
  } catch (_) {}
}

// BUG_096: get dept head user ID for a given employee (fire-and-forget safe)
async function getDeptHeadId(userId, oId) {
  try {
    const { data: user } = await db.from('users')
      .select('department_id')
      .eq('id', userId)
      .eq('organization_id', oId)
      .maybeSingle();
    if (!user?.department_id) return null;
    const { data: dept } = await db.from('departments')
      .select('head_user_id')
      .eq('id', user.department_id)
      .eq('organization_id', oId)
      .maybeSingle();
    const headId = dept?.head_user_id;
    return (headId && headId !== userId) ? headId : null;
  } catch (_) { return null; }
}

// ─── ROUTE: GET /workflow-config ──────────────────────────────────────────────
// Returns the org's active workflow with all levels.
// Accessible to all authenticated users (employees need it for timeline display).
router.get('/workflow-config', auth, async (req, res) => {
  try {
    const workflow = await engine.getOrgWorkflow(orgId(req));
    res.json(workflow);
  } catch (err) {
    // Migration not yet applied — return empty workflow so frontend doesn't crash
    if (err.message && (err.message.includes('does not exist') || err.message.includes('relation'))) {
      return res.json({ id: null, workflow_name: 'Default Approval Workflow', levels: [], _migration_pending: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: PUT /workflow-config ──────────────────────────────────────────────
// Replace the org's workflow levels. Admin only.
router.put('/workflow-config', auth, hasPermission('settings', 'manage'), async (req, res) => {
  try {
    const { workflow_name, levels } = req.body;
    if (!Array.isArray(levels)) return res.status(400).json({ error: 'levels must be an array' });

    const VALID_TYPES = ['reporting_manager','department_head','hr_admin','root_admin','specific_user'];
    const UNIQUE_TYPES = ['reporting_manager','department_head','hr_admin','root_admin'];
    const seenTypes = new Set();
    for (const [i, l] of levels.entries()) {
      if (!VALID_TYPES.includes(l.role_type)) {
        return res.status(400).json({ error: `Level ${i + 1}: invalid role_type '${l.role_type}'` });
      }
      // BUG_167: enforce uniqueness for non-specific_user types
      if (UNIQUE_TYPES.includes(l.role_type) && seenTypes.has(l.role_type)) {
        return res.status(400).json({ error: `Approver type '${l.role_type}' can only appear once in the workflow` });
      }
      if (UNIQUE_TYPES.includes(l.role_type)) seenTypes.add(l.role_type);
    }

    // Re-number levels sequentially to prevent gaps
    const normalised = levels.map((l, i) => ({ ...l, level_number: i + 1 }));

    const updated = await engine.updateWorkflow(orgId(req), workflow_name, normalised);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /my-approvals ─────────────────────────────────────────────────
// Returns all new-workflow leaves currently pending THIS user's action.
// MUST be before GET /:id.
router.get('/my-approvals', auth, async (req, res) => {
  try {
    const leaves = await engine.getMyPendingLeaves(req.user.id, req.user.role, orgId(req));
    res.json(leaves);
  } catch (err) {
    // Migration not yet applied — return empty list gracefully
    if (err.message && (err.message.includes('does not exist') || err.message.includes('relation'))) {
      return res.json([]);
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: GET /date-check ───────────────────────────────────────────────────
router.get('/date-check', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const { data: rawConflicts } = await db.from('leaves')
      .select('id, leave_type, leave_time, status, start_date, end_date')
      .eq('user_id', req.user.id)
      .eq('organization_id', orgId(req))
      .in('status', ['pending','pending_dept','pending_root','pending_approval','approved'])
      .lte('start_date', endDate)
      .gte('end_date', startDate);

    const { leave_time: newLeaveTime, leave_type: newLeaveType } = req.query;
    const newIsWfh  = newLeaveType === 'wfh' || newLeaveTime === 'wfh';
    const newIsHalf = newLeaveTime === 'half';
    const conflicts = (rawConflicts || []).filter(c => {
      const cIsWfh = c.leave_type === 'wfh' || c.leave_time === 'wfh';
      if (cIsWfh && newIsHalf) return false;
      if (!cIsWfh && c.leave_time === 'half' && newIsWfh) return false;
      return true;
    });

    const { data: attendanceRecs } = await db.from('attendance')
      .select('date, work_hours')
      .eq('user_id', req.user.id)
      .eq('organization_id', orgId(req))
      .gte('date', startDate)
      .lte('date', endDate)
      .gt('work_hours', 0);

    const year = new Date().getFullYear();
    const { data: approved } = await db.from('leaves')
      .select('leave_type, start_date, end_date, leave_time')
      .eq('user_id', req.user.id)
      .eq('organization_id', orgId(req))
      .eq('status', 'approved')
      .gte('start_date', `${year}-01-01`)
      .lte('end_date', `${year}-12-31`);

    const { data: orgHolidays } = await db.from('holidays')
      .select('date').eq('organization_id', orgId(req))
      .like('date', `${year}-%`);
    const holidaySet = new Set((orgHolidays || []).map(h => h.date));

    const usedByType = {};
    for (const l of approved || []) {
      if (!usedByType[l.leave_type]) usedByType[l.leave_type] = 0;
      if (l.leave_time === 'half') {
        usedByType[l.leave_type] += 0.5;
      } else if (l.leave_time !== 'wfh' && l.leave_type !== 'wfh') {
        const s = new Date(l.start_date + 'T12:00:00');
        const e = new Date(l.end_date   + 'T12:00:00');
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
          const ds  = d.toISOString().split('T')[0];
          const dow = d.getDay();
          if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) usedByType[l.leave_type] += 1;
        }
      }
    }

    const { data: policies } = await db.from('leave_policies')
      .select('leave_type, annual_quota').eq('organization_id', orgId(req)).eq('active', true);
    const { data: orgRow } = await db.from('organizations')
      .select('total_annual_leaves').eq('id', orgId(req)).maybeSingle();
    const policyQuotas = {};
    (policies || []).forEach(p => { policyQuotas[p.leave_type] = p.annual_quota; });
    const totalAnnual = orgRow?.total_annual_leaves || 18;

    res.json({
      conflicts: conflicts || [],
      hasAttendance: (attendanceRecs || []).length > 0,
      usedByType,
      totalAnnual,
      policyQuotas,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /team ─────────────────────────────────────────────────────────
router.get('/team', auth, async (req, res) => {
  try {
    const { startDate, endDate, year, month } = req.query;
    let query = db.from('leaves')
      .select('id, user_id, start_date, end_date, leave_type, leave_time, users!leaves_user_id_fkey(name, avatar_color, department)')
      .eq('organization_id', orgId(req))
      .eq('status', 'approved')
      .order('start_date', { ascending: true });

    if (startDate && endDate) {
      query = query.lte('start_date', endDate).gte('end_date', startDate);
    } else if (year && month) {
      const ym = `${year}-${String(month).padStart(2, '0')}`;
      query = query.lte('start_date', `${ym}-31`).gte('end_date', `${ym}-01`);
    } else if (year) {
      query = query.lte('start_date', `${year}-12-31`).gte('end_date', `${year}-01-01`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json((data || []).map(l => ({
      id: l.id, user_id: l.user_id, start_date: l.start_date, end_date: l.end_date,
      leave_type: l.leave_type, leave_time: l.leave_time,
      name: l.users?.name, avatar_color: l.users?.avatar_color, department: l.users?.department,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /balance ──────────────────────────────────────────────────────
router.get('/balance', auth, async (req, res) => {
  try {
    const oId   = orgId(req);
    const targetId = (isAdminRole(req.user.role) && req.query.userId)
      ? parseInt(req.query.userId)
      : req.user.id;

    // Fetch org's leave-year start month (1=Jan calendar year, 4=Apr financial year, etc.)
    const { data: orgRow } = await db.from('organizations')
      .select('leave_year_start_month')
      .eq('id', oId)
      .maybeSingle();
    const startMonth = orgRow?.leave_year_start_month || 1;

    // Default 'year' to the starting year of the CURRENT leave cycle.
    // e.g. for Apr-start FY: if today is Feb 2027, the current FY started in Apr 2026 → year=2026.
    const now = new Date();
    const curMonth = now.getMonth() + 1; // 1-indexed
    const curYear  = now.getFullYear();
    const defaultYear = (startMonth > 1 && curMonth < startMonth) ? curYear - 1 : curYear;
    const year = parseInt(req.query.year) || defaultYear;

    // Compute the leave-cycle date window for this year + start month
    const mm       = String(startMonth).padStart(2, '0');
    const fyStart  = `${year}-${mm}-01`;
    const fyEndYear  = startMonth === 1 ? year : year + 1;
    const fyEndMonth = startMonth === 1 ? 12  : startMonth - 1;
    // Date.UTC month is 0-indexed; day 0 = last day of previous month. UTC avoids TZ shift.
    const fyEnd = new Date(Date.UTC(fyEndYear, fyEndMonth, 0)).toISOString().split('T')[0];

    const [policiesRes, leavesRes, settings, adjRes] = await Promise.all([
      db.from('leave_policies')
        .select('leave_type, label, annual_quota')
        .eq('organization_id', oId).eq('active', true).gt('annual_quota', 0),
      db.from('leaves')
        .select('leave_type, leave_time, start_date, end_date, status')
        .eq('user_id', targetId).eq('organization_id', oId)
        .in('status', ['approved', 'pending', 'pending_dept', 'pending_root', 'pending_approval'])
        .gte('start_date', fyStart).lte('end_date', fyEnd)
        .neq('leave_type', 'wfh'),
      getSettings(oId),
      db.from('leave_balance_adjustments')
        .select('leave_type, delta')
        .eq('user_id', targetId).eq('org_id', oId).eq('year', year),
    ]);

    const policies = policiesRes.data || [];
    const leaves   = (leavesRes.data || []).filter(l => l.leave_time !== 'wfh');

    const adjByType = {};
    (adjRes.data || []).forEach(a => { adjByType[a.leave_type] = (adjByType[a.leave_type] || 0) + Number(a.delta); });

    function workDays(leave) {
      if (leave.leave_time === 'half') return 0.5;
      return buildWorkingDates(leave.start_date, leave.end_date, settings).length;
    }

    const pendingStatuses = ['pending', 'pending_dept', 'pending_root', 'pending_approval'];
    const balances = policies.map(p => {
      const approved = leaves.filter(l => l.leave_type === p.leave_type && l.status === 'approved');
      const pending  = leaves.filter(l => l.leave_type === p.leave_type && pendingStatuses.includes(l.status));
      const used     = approved.reduce((s, l) => s + workDays(l), 0);
      const inProg   = pending.reduce((s, l) => s + workDays(l), 0);
      const adj      = adjByType[p.leave_type] || 0;
      return {
        leave_type:  p.leave_type,
        label:       p.label || p.leave_type,
        allocated:   p.annual_quota,
        adjustment:  Math.round(adj   * 2) / 2,
        used:        Math.round(used  * 2) / 2,
        pending:     Math.round(inProg * 2) / 2,
        remaining:   Math.max(0, p.annual_quota + adj - used),
      };
    });

    res.json({ year, balances });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /balance/adjustments ─────────────────────────────────────────
router.get('/balance/adjustments', auth, async (req, res) => {
  try {
    const oId      = orgId(req);
    const year     = parseInt(req.query.year) || new Date().getFullYear();
    const targetId = (isAdminRole(req.user.role) && req.query.userId)
      ? parseInt(req.query.userId)
      : req.user.id;

    const { data: rows, error } = await db
      .from('leave_balance_adjustments')
      .select('*')
      .eq('user_id', targetId)
      .eq('org_id', oId)
      .eq('year', year)
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (!rows?.length) return res.json([]);

    const adjByIds = [...new Set(rows.map(r => r.adjusted_by).filter(Boolean))];
    const { data: adjUsers } = adjByIds.length
      ? await db.from('users').select('id, name, avatar_color').in('id', adjByIds)
      : { data: [] };
    const adjMap = {};
    (adjUsers || []).forEach(u => { adjMap[u.id] = u; });

    res.json(rows.map(r => ({
      ...r,
      adjusted_by_name:  adjMap[r.adjusted_by]?.name         || 'HR',
      adjusted_by_color: adjMap[r.adjusted_by]?.avatar_color || '#3525cd',
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: POST /balance/adjust ──────────────────────────────────────────────
router.post('/balance/adjust', auth, hasPermission('leaves', 'manage'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const { userId, leave_type, delta, reason, year } = req.body;
    const targetYear  = parseInt(year)  || new Date().getFullYear();
    const parsedDelta = parseFloat(delta);

    if (!userId || !leave_type || !reason?.trim())
      return res.status(400).json({ error: 'userId, leave_type, delta, and reason are required' });
    if (isNaN(parsedDelta) || parsedDelta === 0)
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    if (Math.abs(parsedDelta) > 365)
      return res.status(400).json({ error: 'delta cannot exceed 365 days' });

    const { data: emp } = await db.from('users')
      .select('id').eq('id', parseInt(userId)).eq('organization_id', oId).maybeSingle();
    if (!emp) return res.status(404).json({ error: 'Employee not found in this organisation' });

    const { data: policy } = await db.from('leave_policies')
      .select('id').eq('organization_id', oId).eq('leave_type', leave_type).eq('active', true).maybeSingle();
    if (!policy) return res.status(400).json({ error: 'Leave type not found in active policies' });

    const { data, error } = await db.from('leave_balance_adjustments').insert({
      user_id:     parseInt(userId),
      org_id:      oId,
      leave_type,
      year:        targetYear,
      delta:       parsedDelta,
      reason:      reason.trim(),
      adjusted_by: req.user.id,
    }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /team-dashboard ───────────────────────────────────────────────
router.get('/team-dashboard', auth, async (req, res) => {
  try {
    const oId = orgId(req);
    const today = localDateStr ? localDateStr() : new Date().toISOString().split('T')[0];

    const { data: dept } = await db
      .from('departments').select('id, name')
      .eq('head_user_id', req.user.id).eq('organization_id', oId).maybeSingle();
    if (!dept) return res.json({ is_dept_head: false });

    // BUG_153: fall back to matching by department name if department_id FK not set
    const memberRes = await pool.query(
      `SELECT id, name, avatar_color, employee_status
       FROM users
       WHERE organization_id = $1
         AND (department_id = $2 OR department = $3)
         AND id != $4
         AND employee_status IN ('active', 'probation')`,
      [oId, dept.id, dept.name, req.user.id]
    );
    const members   = memberRes.rows || [];
    const memberIds = members.map(m => m.id);

    let attMap = {};
    if (memberIds.length > 0) {
      const { data: attRows } = await db
        .from('attendance').select('user_id, status')
        .eq('date', today).in('user_id', memberIds);
      for (const a of attRows || []) attMap[a.user_id] = a.status;
    }

    const present = Object.values(attMap).filter(s => ['present', 'wfh', 'half_day'].includes(s)).length;
    const onLeave = Object.values(attMap).filter(s => s === 'on_leave').length;
    const notIn   = memberIds.length - Object.keys(attMap).length;

    // Count both old (pending_dept) and new (pending_approval at dept head level) leaves
    let pendingCount = 0;
    if (memberIds.length > 0) {
      const { count: oldCount } = await db.from('leaves')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending_dept').in('user_id', memberIds).eq('organization_id', oId);

      let deptNewCount = 0;
      try {
        const newPending = await engine.getMyPendingLeaves(req.user.id, req.user.role, oId);
        deptNewCount = newPending.filter(l =>
          ['reporting_manager','department_head'].includes(l.current_level_role_type) &&
          memberIds.includes(l.user_id)
        ).length;
      } catch (_) { /* workflow tables not yet migrated — skip */ }

      pendingCount = (oldCount || 0) + deptNewCount;
    }

    const next7 = new Date(today); next7.setDate(next7.getDate() + 7);
    const next7Str = next7.toISOString().split('T')[0];
    let upcomingLeaves = [];
    if (memberIds.length > 0) {
      const memberMap = {};
      for (const m of members) memberMap[m.id] = m.name;
      const { data: upcoming } = await db.from('leaves')
        .select('user_id, start_date, end_date, leave_type, leave_time')
        .eq('status', 'approved').in('user_id', memberIds)
        .gte('start_date', today).lte('start_date', next7Str)
        .order('start_date').limit(5);
      upcomingLeaves = (upcoming || []).map(l => ({ ...l, name: memberMap[l.user_id] || '' }));
    }

    res.json({
      is_dept_head:     true,
      department:       dept,
      team_count:       memberIds.length,
      present_today:    present,
      on_leave_today:   onLeave,
      not_checked_in:   notIn,
      pending_approvals: pendingCount,
      upcoming_leaves:  upcomingLeaves,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /is-dept-head ─────────────────────────────────────────────────
router.get('/is-dept-head', auth, async (req, res) => {
  try {
    const oId = orgId(req);
    const { data: dept } = await db
      .from('departments')
      .select('id, name')
      .eq('head_user_id', req.user.id)
      .eq('organization_id', oId)
      .maybeSingle();

    if (!dept) return res.json({ is_dept_head: false });
    res.json({ is_dept_head: true, department_id: dept.id, department_name: dept.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /pending-department (legacy + new flow) ───────────────────────
router.get('/pending-department', auth, async (req, res) => {
  try {
    const oId = orgId(req);

    // Legacy: employees in dept or reporting to this user
    const { data: myDepts } = await db
      .from('departments')
      .select('id')
      .eq('head_user_id', req.user.id)
      .eq('organization_id', oId);

    const deptEmpIds = [];
    if (myDepts?.length) {
      const deptIds = myDepts.map(d => d.id);
      const empRes = await pool.query(
        `SELECT id FROM users WHERE department_id = ANY($1::bigint[]) AND organization_id = $2 AND id != $3`,
        [deptIds, oId, req.user.id]
      );
      deptEmpIds.push(...empRes.rows.map(r => r.id));
    }

    const reporteeRes = await pool.query(
      `SELECT id FROM users WHERE reporting_to = $1 AND organization_id = $2 AND id != $1`,
      [req.user.id, oId]
    );
    const reporteeIds = reporteeRes.rows.map(r => r.id);
    const allEmpIds = [...new Set([...deptEmpIds, ...reporteeIds])];

    let legacyLeaves = [];
    if (allEmpIds.length) {
      const { data } = await db
        .from('leaves')
        .select('*, users!leaves_user_id_fkey(id, name, email, department, avatar_color, position)')
        .eq('organization_id', oId)
        .eq('status', 'pending_dept')
        .is('deleted_at', null)
        .in('user_id', allEmpIds)
        .order('created_at', { ascending: false });
      legacyLeaves = (data || []).map(l => ({ ...l, ...l.users, users: undefined, _flow: 'legacy' }));
    }

    // New workflow: leaves assigned to this user at dept-level roles
    let newDeptLeaves = [];
    try {
      const newLeaves = await engine.getMyPendingLeaves(req.user.id, req.user.role, oId);
      newDeptLeaves = newLeaves
        .filter(l => ['reporting_manager','department_head'].includes(l.current_level_role_type))
        .map(l => ({ ...l, _flow: 'new' }));
    } catch (_) { /* workflow tables not yet migrated — skip */ }

    res.json([...legacyLeaves, ...newDeptLeaves]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /pending-root (legacy + new flow) ─────────────────────────────
router.get('/pending-root', auth, hasPermission('leaves', 'approve'), async (req, res) => {
  try {
    const oId = orgId(req);

    // Legacy pending_root
    const { data: legacy } = await db
      .from('leaves')
      .select('*, users!leaves_user_id_fkey(id, name, email, department, avatar_color, position)')
      .eq('organization_id', oId)
      .eq('status', 'pending_root')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    const legacyLeaves = (legacy || []).map(l => ({ ...l, ...l.users, users: undefined, _flow: 'legacy' }));

    // New workflow: leaves at admin/root level
    let newAdminLeaves = [];
    try {
      const newLeaves = await engine.getMyPendingLeaves(req.user.id, req.user.role, oId);
      newAdminLeaves = newLeaves
        .filter(l => ['hr_admin','root_admin'].includes(l.current_level_role_type))
        .map(l => ({ ...l, _flow: 'new' }));
    } catch (_) { /* workflow tables not yet migrated — skip */ }

    res.json([...legacyLeaves, ...newAdminLeaves]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET / — list leaves ───────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    let query = db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email, avatar_color, department), approver:users!leaves_approved_by_fkey(name)')
      .eq('organization_id', orgId(req))
      .order('created_at', { ascending: false });

    if (!isAdminRole(req.user.role)) {
      query = query.eq('user_id', req.user.id);
    } else if (userId) {
      query = query.eq('user_id', parseInt(userId));
    }
    if (year && month) {
      const ym = `${year}-${String(month).padStart(2,'0')}`;
      query = query.lte('start_date', `${ym}-31`).gte('end_date', `${ym}-01`);
    } else if (year) {
      query = query.lte('start_date', `${year}-12-31`).gte('end_date', `${year}-01-01`);
    } else if (req.query.startDate && req.query.endDate) {
      query = query.lte('start_date', req.query.endDate).gte('end_date', req.query.startDate);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const result = (data || []).map(l => ({
      ...l, ...l.users,
      approver_name: l.approver?.name,
      users: undefined, approver: undefined,
    }));

    // Enrich pending_approval leaves with current_level_role_type so the
    // frontend can hide the Approve button for levels the caller can't act on.
    if (isAdminRole(req.user.role)) {
      try {
        const wf = await engine.getOrgWorkflow(orgId(req));
        const levelMap = {};
        for (const lvl of wf.levels) levelMap[Number(lvl.level_number)] = lvl.role_type;
        for (const l of result) {
          if (l.status === 'pending_approval' && l.current_level != null) {
            l.current_level_role_type = levelMap[Number(l.current_level)] || null;
          }
        }
      } catch (_) { /* workflow tables not yet migrated — skip */ }
    }

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: POST / — create leave ─────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { start_date, end_date, leave_type, reason, user_id, leave_time, half_type } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end dates required' });
    if (start_date > end_date)    return res.status(400).json({ error: 'Start date must be before end date' });

    if (leave_time !== 'wfh' && leave_type !== 'wfh') {
      const settings = await getSettings(orgId(req));
      const checkDates = buildWorkingDates(start_date, end_date, settings);
      if (checkDates.length === 0) {
        return res.status(400).json({ error: 'The selected date range contains no working days.' });
      }
    }

    const targetUserId = (isAdminRole(req.user.role) && user_id) ? parseInt(user_id) : req.user.id;
    const isOnBehalf   = isAdminRole(req.user.role) && targetUserId !== req.user.id;

    // ── Admin creates on behalf → auto-approve ────────────────────────────────
    if (isOnBehalf) {
      const settings     = await getSettings(orgId(req));
      const attStatus    = leave_time === 'half' ? 'half_day' : (leave_time === 'wfh' || leave_type === 'wfh') ? 'wfh' : 'on_leave';
      const holidayDates = await fetchHolidaySet(orgId(req), start_date, end_date);
      const workDates    = buildWorkingDates(start_date, end_date, settings, holidayDates);
      const approvedAt   = new Date().toISOString();

      const client = await pool.connect();
      let leaveId;
      try {
        await client.query('BEGIN');
        const leaveRes = await client.query(
          `INSERT INTO leaves
             (user_id, start_date, end_date, leave_type, reason, leave_time, half_type,
              status, approved_by, approved_at, organization_id,
              dept_head_status, root_admin_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9,$10,'approved','approved')
           RETURNING id`,
          [targetUserId, start_date, end_date, leave_type||'casual', reason||'',
           leave_time||'full', leave_time === 'half' ? (half_type||'first_half') : null,
           req.user.id, approvedAt, orgId(req)]
        );
        leaveId = leaveRes.rows[0].id;
        for (const ds of workDates) {
          await client.query(
            `INSERT INTO attendance (user_id, date, status, organization_id)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (user_id, date, organization_id) DO UPDATE SET status = EXCLUDED.status`,
            [targetUserId, ds, attStatus, orgId(req)]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Leave creation failed. ' + err.message });
      } finally { client.release(); }

      const { data } = await db.from('leaves')
        .select('*, users!leaves_user_id_fkey(name, email, department)')
        .eq('id', leaveId).single();

      if (data.users?.email) {
        const { orgName: _on, orgEmail: _oe } = await getOrgContext(orgId(req));
        sendMail({ to: data.users.email, subject: `Leave Added — ${req.user.name || 'HR'}`, html: leaveStatusHtml(data.users, data, 'approved', req.user.name, _on, _oe) });
      }
      return res.json(flatOne(data));
    }

    // ── Employee self-submit: use workflow engine (fallback to legacy if not migrated) ──
    let wfInit;
    try {
      wfInit = await engine.initWorkflow(targetUserId, orgId(req));
    } catch (_) {
      // Workflow tables not yet migrated — use legacy 2-step flow
      const deptHeadId = await findDeptHead(targetUserId, orgId(req));
      wfInit = {
        status:              deptHeadId ? 'pending_dept' : 'pending',
        workflow_id:         null,
        current_level:       null,
        current_approver_id: deptHeadId || null,
      };
    }

    const insertPayload = {
      user_id:         targetUserId,
      start_date, end_date,
      leave_type:      leave_type || 'casual',
      reason:          reason || '',
      leave_time:      leave_time || 'full',
      half_type:       leave_time === 'half' ? (half_type || 'first_half') : null,
      organization_id: orgId(req),
      status:          wfInit.status,
      // Only set workflow columns when migration has run (workflow_id present)
      ...(wfInit.workflow_id != null && {
        workflow_id:         wfInit.workflow_id,
        current_level:       wfInit.current_level,
        current_approver_id: wfInit.current_approver_id,
      }),
    };

    const { data, error } = await db.from('leaves')
      .insert(insertPayload)
      .select('*, users!leaves_user_id_fkey(name, email, department)')
      .single();
    if (error) throw new Error(error.message);

    const leaveId  = data.id;
    const emp      = data.users || {};
    const empName  = emp.name  || req.user.name;
    const empEmail = emp.email || req.user.email;

    logApprovalAction({
      leaveId, oId: orgId(req), actorId: req.user.id, actorName: empName,
      action: 'submitted', fromStatus: null, toStatus: wfInit.status,
      level: wfInit.current_level,
    });

    // Notify the first approver
    const leaveNotifyTitle = `New ${leave_type === 'wfh' ? 'WFH' : 'Leave'} Request from ${empName}`;
    const leaveNotifyMsg   = `${empName} has applied for ${leave_type || 'casual'} leave from ${start_date} to ${end_date}. Your approval is required.`;

    if (wfInit.current_approver_id) {
      // Specific user approver (reporting manager / dept head / specific user)
      const { data: approverUser } = await db.from('users')
        .select('name, email').eq('id', wfInit.current_approver_id).maybeSingle();

      notify(wfInit.current_approver_id, leaveNotifyTitle, leaveNotifyMsg, orgId(req));

      // BUG_096: also notify all HR/root admins in-app (excluding the specific approver)
      notifyAdmins(orgId(req), leaveNotifyTitle, leaveNotifyMsg, wfInit.current_approver_id);

      // BUG_096: notify dept head if not already the current approver
      getDeptHeadId(targetUserId, orgId(req)).then(headId => {
        if (headId && headId !== wfInit.current_approver_id) {
          notify(headId, leaveNotifyTitle, leaveNotifyMsg, orgId(req));
        }
      });

      if (approverUser?.email && typeof leaveDeptApprovalHtml === 'function') {
        const { orgName: _on, orgEmail: _oe } = await getOrgContext(orgId(req));
        sendMail({
          to: approverUser.email,
          subject: `Leave Request Pending Your Approval — ${empName}`,
          html: leaveDeptApprovalHtml({ name: empName, email: empEmail, department: emp.department }, data, approverUser.name, _on, _oe),
        });
      }
    } else {
      // Role-based approver (hr_admin / root_admin) OR legacy flow with no dept head
      // → notify all org recipients via email
      const recipients = await getRecipients(orgId(req));
      if (recipients.length > 0) {
        const { orgName: _on, orgEmail: _oe } = await getOrgContext(orgId(req));
        sendMail({
          to: recipients,
          subject: `${leave_type === 'wfh' ? 'WFH Request' : 'Leave Request'} — ${empName}`,
          html: leaveAppliedHtml({ name: empName, email: empEmail, department: emp.department }, data, _on, _oe),
        });
      }

      // BUG_096: in-app notify all HR/root admins
      notifyAdmins(orgId(req), leaveNotifyTitle, leaveNotifyMsg, targetUserId);

      // BUG_096: in-app notify dept head
      getDeptHeadId(targetUserId, orgId(req)).then(headId => {
        if (headId) notify(headId, leaveNotifyTitle, leaveNotifyMsg, orgId(req));
      });
    }

    return res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: PUT /:id — edit leave ─────────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  try {
    const { data: leave } = await db.from('leaves').select('*').eq('id', req.params.id).eq('organization_id', orgId(req)).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (!isAdminRole(req.user.role) && leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (['approved','rejected'].includes(leave.status) && !isAdminRole(req.user.role)) {
      return res.status(400).json({ error: 'Cannot edit an approved or rejected leave' });
    }

    const { start_date, end_date, leave_type, reason, leave_time, half_type } = req.body;
    if (start_date && end_date && start_date > end_date) return res.status(400).json({ error: 'Start date must be before end date' });

    await db.from('leaves').update({
      ...(start_date && { start_date }),
      ...(end_date   && { end_date }),
      ...(leave_type && { leave_type }),
      reason:     reason     ?? leave.reason,
      leave_time: leave_time || leave.leave_time,
      half_type:  (leave_time || leave.leave_time) === 'half' ? (half_type || leave.half_type || 'first_half') : null,
    }).eq('id', req.params.id).eq('organization_id', orgId(req));

    const { data } = await db.from('leaves').select('*, users!leaves_user_id_fkey(name)').eq('id', req.params.id).eq('organization_id', orgId(req)).single();
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: PUT /:id/approve — workflow-aware unified approve ─────────────────
// Handles: new workflow (pending_approval), old pending_root, legacy pending.
// For new workflow: advances to next level OR final-approves.
router.put('/:id/approve', auth, async (req, res) => {
  try {
    const oId     = orgId(req);
    const { orgName, orgEmail } = await getOrgContext(oId);
    const { data: leave } = await db.from('leaves')
      .select('*').eq('id', req.params.id).eq('organization_id', oId).single();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (leave.status === 'approved') {
      const { data } = await db.from('leaves').select('*, users!leaves_user_id_fkey(name, email)').eq('id', req.params.id).single();
      return res.json(flatOne(data));
    }

    // ── New workflow leave ────────────────────────────────────────────────────
    if (leave.workflow_id && leave.status === 'pending_approval') {
      const { can, level: currentLevel } = await engine.checkCanApprove(leave, req.user.id, req.user.role);
      if (!can) {
        return res.status(403).json({
          error: 'You are not authorized to approve this leave at its current stage.',
          current_status: leave.status,
          current_level: leave.current_level,
        });
      }

      const workflow = await engine.getOrgWorkflow(oId);
      const notes = req.body?.notes || req.body?.remarks || null;

      // Find next level (skipping optional ones with no approver)
      const nextInfo = await engine.findNextLevel(workflow, leave.current_level, leave.user_id, oId);

      // Log this level's approval
      logApprovalAction({
        leaveId: leave.id, oId, actorId: req.user.id, actorName: req.user.name,
        action: `level_${leave.current_level}_approved`,
        fromStatus: 'pending_approval', toStatus: nextInfo ? 'pending_approval' : 'approved',
        notes, level: leave.current_level,
      });

      // Log skipped levels (levels that findNextLevel skipped)
      if (nextInfo) {
        const skippedLevels = workflow.levels.filter(l =>
          l.level_number > leave.current_level && l.level_number < nextInfo.level.level_number
        );
        for (const sk of skippedLevels) {
          logApprovalAction({
            leaveId: leave.id, oId, actorId: req.user.id, actorName: req.user.name,
            action: `level_${sk.level_number}_skipped`,
            fromStatus: 'pending_approval', toStatus: 'pending_approval',
            notes: `No ${sk.level_label || sk.role_type} found; auto-skipped`,
            level: sk.level_number,
          });
        }
      }

      if (!nextInfo) {
        // ── Final level approved — create attendance + mark approved ────────
        const settings     = await getSettings(oId);
        const holidayDates = await fetchHolidaySet(oId, leave.start_date, leave.end_date);
        const workDates    = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);
        const attStatus    = leave.leave_time === 'half' ? 'half_day'
          : (leave.leave_time === 'wfh' || leave.leave_type === 'wfh') ? 'wfh'
          : 'on_leave';
        const approvedAt = new Date().toISOString();

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const ds of workDates) {
            await client.query(
              `INSERT INTO attendance (user_id, date, status, organization_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, date, organization_id) DO UPDATE SET status = EXCLUDED.status`,
              [leave.user_id, ds, attStatus, oId]
            );
          }
          await client.query(
            `UPDATE leaves SET
               status = 'approved', approved_by = $1, approved_at = $2,
               current_level = NULL, current_approver_id = NULL
             WHERE id = $3 AND organization_id = $4`,
            [req.user.id, approvedAt, leave.id, oId]
          );
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Final approval failed: ' + txErr.message });
        } finally { client.release(); }

        notify(leave.user_id, 'Leave Approved',
          `Your leave request from ${leave.start_date} to ${leave.end_date} has been approved by ${req.user.name}.`,
          oId);

        const { data: updated } = await db.from('leaves')
          .select('*, users!leaves_user_id_fkey(name, email)').eq('id', leave.id).single();
        if (updated.users?.email) {
          sendMail({ to: updated.users.email, subject: 'Your Leave Request has been Approved', html: leaveStatusHtml(updated.users, leave, 'approved', req.user.name, orgName, orgEmail) });
        }
        return res.json(flatOne(updated));

      } else {
        // ── Intermediate level — advance to next ─────────────────────────────
        await db.from('leaves').update({
          current_level:       nextInfo.level.level_number,
          current_approver_id: nextInfo.approverId,
        }).eq('id', leave.id).eq('organization_id', oId);

        const nextLabel = nextInfo.level.level_label || nextInfo.level.role_type.replace(/_/g, ' ');

        // Notifications are fire-and-forget — never let them bubble a 500
        try {
          notify(leave.user_id,
            'Leave Forwarded for Approval',
            `Your leave request has been approved by ${req.user.name} and forwarded to ${nextLabel}.`,
            oId);

          if (nextInfo.approverId) {
            notify(nextInfo.approverId,
              `Leave Request Awaiting Your Approval`,
              `A leave request from ${leave.user_id} requires your action.`,
              oId);
            const { data: nextApprover } = await db.from('users')
              .select('name, email').eq('id', nextInfo.approverId).maybeSingle();
            if (nextApprover?.email && typeof leaveForwardedToRootHtml === 'function') {
              const { data: empUser } = await db.from('users')
                .select('name, email, department').eq('id', leave.user_id).maybeSingle();
              sendMail({
                to: nextApprover.email,
                subject: `Leave Request Forwarded for Your Approval`,
                html: leaveForwardedToRootHtml(empUser || {}, leave, req.user.name, orgName, orgEmail),
              });
            }
          } else {
            // Role-based next approver (hr_admin / root_admin)
            const nextRoleType = nextInfo.level.role_type;
            const roleFilter   = nextRoleType === 'root_admin' ? ['root_admin'] : ['admin', 'root_admin'];
            const { data: roleUsers } = await db.from('users')
              .select('id, email, name').eq('organization_id', oId).in('role', roleFilter);
            const { data: empUser } = await db.from('users')
              .select('name, email, department').eq('id', leave.user_id).maybeSingle();
            const empName = empUser?.name || 'An employee';
            if (roleUsers?.length) {
              await db.from('notifications').insert(roleUsers.map(u => ({
                user_id: u.id,
                title:   `Leave Request Awaiting Your Approval`,
                message: `${empName}'s leave request (${leave.start_date} → ${leave.end_date}) requires your approval at the ${nextLabel} stage.`,
                type:    'leave',
                organization_id: oId,
              }))).catch(() => {});
              const emailList = roleUsers.map(u => u.email).filter(Boolean);
              if (emailList.length > 0 && typeof leaveForwardedToRootHtml === 'function') {
                sendMail({
                  to: emailList,
                  subject: `Leave Forwarded for ${nextLabel} Approval`,
                  html: leaveForwardedToRootHtml(empUser || {}, leave, req.user.name, orgName, orgEmail),
                });
              }
            }
          }
        } catch (notifyErr) {
          console.error('[leave approve] notification error (non-fatal):', notifyErr.message);
        }

        const { data: updated } = await db.from('leaves').select('*').eq('id', leave.id).single();
        return res.json(updated);
      }
    }

    // ── Legacy flow: pending_dept blocks direct approve ───────────────────────
    if (leave.status === 'pending_dept') {
      return res.status(400).json({
        error: 'This leave is waiting for Department Head approval. The Department Head must forward it first.',
        current_status: 'pending_dept',
      });
    }

    if (leave.status === 'rejected' || leave.status === 'cancelled' || leave.status === 'withdrawn') {
      return res.status(409).json({ error: `Cannot approve a ${leave.status} leave.`, current_status: leave.status });
    }

    // Legacy pending_root requires root_admin; old pending requires any admin
    if (leave.status === 'pending_root' && req.user.role !== 'root_admin') {
      return res.status(403).json({ error: 'Only Root Admin can give final approval on pending_root leaves.' });
    }
    if (!isAdminRole(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to approve this leave.' });
    }

    const settings     = await getSettings(oId);
    const holidayDates = await fetchHolidaySet(oId, leave.start_date, leave.end_date);
    const workDates    = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);
    const attStatus    = leave.leave_time === 'half' ? 'half_day'
      : (leave.leave_time === 'wfh' || leave.leave_type === 'wfh') ? 'wfh'
      : 'on_leave';
    const approvedAt = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ds of workDates) {
        await client.query(
          `INSERT INTO attendance (user_id, date, status, organization_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, date, organization_id) DO UPDATE SET status = EXCLUDED.status`,
          [leave.user_id, ds, attStatus, oId]
        );
      }
      await client.query(
        `UPDATE leaves SET
           status = 'approved', approved_by = $1, approved_at = $2,
           root_admin_status = 'approved', root_admin_id = $1, root_admin_reviewed_at = $2
         WHERE id = $3 AND organization_id = $4`,
        [req.user.id, approvedAt, req.params.id, oId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Approval failed. ' + err.message });
    } finally { client.release(); }

    logApprovalAction({ leaveId: leave.id, oId, actorId: req.user.id, actorName: req.user.name, action: 'root_approved', fromStatus: leave.status, toStatus: 'approved' });

    const { data: updated } = await db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email)').eq('id', req.params.id).single();
    notify(leave.user_id, 'Leave Approved', `Your leave from ${leave.start_date} to ${leave.end_date} has been approved.`, oId);
    if (updated.users?.email) {
      sendMail({ to: updated.users.email, subject: 'Your Leave Request has been Approved', html: leaveStatusHtml(updated.users, leave, 'approved', req.user.name, orgName, orgEmail) });
    }
    res.json(flatOne(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: PUT /:id/reject — workflow-aware unified reject ───────────────────
router.put('/:id/reject', auth, async (req, res) => {
  try {
    const oId     = orgId(req);
    const { orgName, orgEmail } = await getOrgContext(oId);
    const { data: leave } = await db.from('leaves')
      .select('*').eq('id', req.params.id).eq('organization_id', oId).single();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (leave.status === 'rejected') return res.json(leave);

    const { remarks } = req.body || {};

    // ── New workflow leave ────────────────────────────────────────────────────
    if (leave.workflow_id && leave.status === 'pending_approval') {
      const { can } = await engine.checkCanApprove(leave, req.user.id, req.user.role);
      if (!can) {
        return res.status(403).json({ error: 'You are not authorized to reject this leave at its current stage.' });
      }

      const rejectedAt = new Date().toISOString();
      await db.from('leaves').update({
        status:              'rejected',
        approved_by:         req.user.id,
        approved_at:         rejectedAt,
        current_level:       null,
        current_approver_id: null,
        remarks:             remarks || null,
      }).eq('id', leave.id).eq('organization_id', oId);

      logApprovalAction({
        leaveId: leave.id, oId, actorId: req.user.id, actorName: req.user.name,
        action: `level_${leave.current_level}_rejected`,
        fromStatus: 'pending_approval', toStatus: 'rejected',
        notes: remarks, level: leave.current_level,
      });

      notify(leave.user_id, 'Leave Request Rejected',
        `Your leave request from ${leave.start_date} to ${leave.end_date} has been rejected by ${req.user.name}.${remarks ? ` Reason: ${remarks}` : ''}`,
        oId);

      const { data: updated } = await db.from('leaves')
        .select('*, users!leaves_user_id_fkey(name, email)').eq('id', leave.id).single();
      if (updated.users?.email) {
        sendMail({ to: updated.users.email, subject: 'Your Leave Request has been Rejected', html: leaveStatusHtml(updated.users, leave, 'rejected', req.user.name, orgName, orgEmail) });
      }
      return res.json(flatOne(updated));
    }

    // ── Legacy: pending_dept blocks reject ────────────────────────────────────
    if (leave.status === 'pending_dept') {
      return res.status(400).json({
        error: 'This leave has not been forwarded by the Department Head yet.',
        current_status: 'pending_dept',
      });
    }

    if (leave.status === 'pending_root' && req.user.role !== 'root_admin') {
      return res.status(403).json({ error: 'Only Root Admin can make the final decision.' });
    }

    const rejectedAt = new Date().toISOString();
    let workDates = [];
    if (leave.status === 'approved') {
      const settings     = await getSettings(oId);
      const holidayDates = await fetchHolidaySet(oId, leave.start_date, leave.end_date);
      workDates = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (workDates.length) {
        await client.query(
          `DELETE FROM attendance
           WHERE user_id = $1 AND organization_id = $2
             AND date = ANY($3::text[])
             AND status = ANY(ARRAY['on_leave','half_day','wfh'])`,
          [leave.user_id, oId, workDates]
        );
      }
      await client.query(
        `UPDATE leaves SET
           status = 'rejected', approved_by = $1, approved_at = $2,
           remarks = $3,
           root_admin_status = 'rejected', root_admin_id = $1, root_admin_reviewed_at = $2
         WHERE id = $4 AND organization_id = $5`,
        [req.user.id, rejectedAt, remarks || null, req.params.id, oId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Rejection failed. ' + err.message });
    } finally { client.release(); }

    logApprovalAction({ leaveId: leave.id, oId, actorId: req.user.id, actorName: req.user.name, action: 'root_rejected', fromStatus: leave.status, toStatus: 'rejected', notes: remarks });
    notify(leave.user_id, 'Leave Request Rejected', `Your leave from ${leave.start_date} to ${leave.end_date} has been rejected.`, oId);

    const { data: updated } = await db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email)').eq('id', req.params.id).single();
    if (updated.users?.email) {
      sendMail({ to: updated.users.email, subject: 'Your Leave Request has been Rejected', html: leaveStatusHtml(updated.users, leave, 'rejected', req.user.name, orgName, orgEmail) });
    }
    res.json(flatOne(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: POST /:id/withdraw — employee withdraws pending leave ──────────────
router.post('/:id/withdraw', auth, async (req, res) => {
  try {
    const { data: leave } = await db.from('leaves')
      .select('*').eq('id', req.params.id).eq('organization_id', orgId(req)).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (!['pending_approval','pending','pending_dept','pending_root'].includes(leave.status)) {
      return res.status(400).json({ error: 'Can only withdraw leaves that are still pending' });
    }

    await db.from('leaves').update({
      status:              'withdrawn',
      current_level:       null,
      current_approver_id: null,
    }).eq('id', req.params.id).eq('organization_id', orgId(req));

    logApprovalAction({
      leaveId: leave.id, oId: orgId(req), actorId: req.user.id, actorName: req.user.name,
      action: 'withdrawn', fromStatus: leave.status, toStatus: 'withdrawn',
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: PUT /:id/revert ───────────────────────────────────────────────────
router.put('/:id/revert', auth, async (req, res) => {
  const { data: leave } = await db.from('leaves').select('*').eq('id', req.params.id).eq('organization_id', orgId(req)).maybeSingle();
  if (!leave) return res.status(404).json({ error: 'Leave not found' });
  if (!isAdminRole(req.user.role) && leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (leave.status !== 'approved') return res.status(400).json({ error: 'Only approved leaves can be reverted' });

  const settings     = await getSettings(orgId(req));
  const holidayDates = await fetchHolidaySet(orgId(req), leave.start_date, leave.end_date);
  const workDates    = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (workDates.length) {
      await client.query(
        `DELETE FROM attendance
         WHERE user_id = $1 AND organization_id = $2
           AND date = ANY($3::text[])
           AND status = ANY(ARRAY['on_leave','half_day','wfh'])`,
        [leave.user_id, orgId(req), workDates]
      );
    }
    await client.query(
      `UPDATE leaves SET status = 'cancelled' WHERE id = $1 AND organization_id = $2`,
      [req.params.id, orgId(req)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Revert failed. ' + err.message });
  } finally { client.release(); }

  logApprovalAction({ leaveId: leave.id, oId: orgId(req), actorId: req.user.id, actorName: req.user.name, action: 'cancelled', fromStatus: 'approved', toStatus: 'cancelled' });

  const { data } = await db.from('leaves')
    .select('*, users!leaves_user_id_fkey(name, email)').eq('id', req.params.id).single();
  res.json(flatOne(data));
});

// ─── ROUTE: DELETE /:id ───────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const { data: leave } = await db.from('leaves').select('*').eq('id', req.params.id).eq('organization_id', orgId(req)).maybeSingle();
  if (!leave) return res.status(404).json({ error: 'Leave not found' });
  if (!isAdminRole(req.user.role) && leave.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (leave.status === 'approved' && !isAdminRole(req.user.role)) return res.status(400).json({ error: 'Cannot cancel approved leave' });

  let workDates = [];
  if (leave.status === 'approved') {
    const settings     = await getSettings(orgId(req));
    const holidayDates = await fetchHolidaySet(orgId(req), leave.start_date, leave.end_date);
    workDates = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (workDates.length) {
      await client.query(
        `DELETE FROM attendance
         WHERE user_id = $1 AND organization_id = $2
           AND date = ANY($3::text[])
           AND status = ANY(ARRAY['on_leave','half_day','wfh'])`,
        [leave.user_id, orgId(req), workDates]
      );
    }
    await client.query(`DELETE FROM leaves WHERE id = $1 AND organization_id = $2`, [req.params.id, orgId(req)]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Delete failed. ' + err.message });
  } finally { client.release(); }

  res.json({ success: true });
});

// ─── ROUTE: POST /:id/department-approve (LEGACY — kept for backward compat) ──
router.post('/:id/department-approve', auth, async (req, res) => {
  try {
    const oId     = orgId(req);
    const { orgName, orgEmail } = await getOrgContext(oId);
    const leaveId = parseInt(req.params.id, 10);

    const { data: leave } = await db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email, department, department_id)')
      .eq('id', leaveId).eq('organization_id', oId).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });

    if (leave.status !== 'pending_dept') {
      return res.status(400).json({
        error: `This leave is not pending department approval. Current status: ${leave.status}`,
        current_status: leave.status,
      });
    }

    const empDeptId = leave.users?.department_id;
    let isAuthorized = false;
    let approverLabel = '';

    if (empDeptId) {
      const { data: dept } = await db.from('departments')
        .select('id, head_user_id, name').eq('id', empDeptId).eq('organization_id', oId).maybeSingle();
      if (dept?.head_user_id === req.user.id) { isAuthorized = true; approverLabel = dept.name + ' Head'; }
    }
    if (!isAuthorized) {
      const { data: empUser } = await db.from('users')
        .select('reporting_to').eq('id', leave.user_id).eq('organization_id', oId).maybeSingle();
      if (empUser?.reporting_to === req.user.id) { isAuthorized = true; approverLabel = 'Reporting Manager'; }
    }
    if (!isAuthorized) return res.status(403).json({ error: 'You are not authorized to forward this leave.' });

    const now = new Date().toISOString();
    const { notes } = req.body || {};

    await db.from('leaves').update({
      status:                'pending_root',
      dept_head_status:      'approved',
      dept_head_id:          req.user.id,
      dept_head_reviewed_at: now,
    }).eq('id', leaveId).eq('organization_id', oId);

    logApprovalAction({ leaveId, oId, actorId: req.user.id, actorName: req.user.name, action: 'dept_approved', fromStatus: 'pending_dept', toStatus: 'pending_root', notes });

    const empName = leave.users?.name || 'Employee';
    notify(leave.user_id, 'Leave Forwarded for Final Approval', `${req.user.name} (${approverLabel}) has forwarded your leave to the Root Admin.`, oId);

    const rootAdmins = await pool.query(
      `SELECT id, name FROM users WHERE role = 'root_admin' AND organization_id = $1`, [oId]
    );
    for (const ra of rootAdmins.rows) {
      notify(ra.id, `Leave Request Awaiting Final Approval — ${empName}`, `${empName}'s leave has been approved by the Department Head and requires your final decision.`, oId);
    }

    const recipients = await getRecipients(oId);
    if (recipients.length > 0 && typeof leaveForwardedToRootHtml === 'function') {
      sendMail({
        to: recipients,
        subject: `Leave Forwarded for Final Approval — ${empName}`,
        html: leaveForwardedToRootHtml({ name: empName, email: leave.users?.email, department: leave.users?.department }, leave, req.user.name, orgName, orgEmail),
      });
    }

    const { data: updated } = await db.from('leaves').select('*').eq('id', leaveId).single();
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: POST /:id/final-approve (LEGACY) ─────────────────────────────────
router.post('/:id/final-approve', auth, hasPermission('leaves', 'approve'), async (req, res) => {
  try {
    const oId     = orgId(req);
    const { orgName, orgEmail } = await getOrgContext(oId);
    const leaveId = parseInt(req.params.id, 10);

    const { data: leave } = await db.from('leaves').select('*').eq('id', leaveId).eq('organization_id', oId).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (leave.status === 'approved') return res.json(leave);
    if (leave.status !== 'pending_root') {
      return res.status(400).json({ error: `Cannot final-approve a leave with status '${leave.status}'.`, current_status: leave.status });
    }

    const settings     = await getSettings(oId);
    const holidayDates = await fetchHolidaySet(oId, leave.start_date, leave.end_date);
    const workDates    = buildWorkingDates(leave.start_date, leave.end_date, settings, holidayDates);
    const attStatus    = leave.leave_time === 'half' ? 'half_day'
      : (leave.leave_time === 'wfh' || leave.leave_type === 'wfh') ? 'wfh'
      : 'on_leave';
    const approvedAt = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ds of workDates) {
        await client.query(
          `INSERT INTO attendance (user_id, date, status, organization_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, date, organization_id) DO UPDATE SET status = EXCLUDED.status`,
          [leave.user_id, ds, attStatus, oId]
        );
      }
      await client.query(
        `UPDATE leaves SET
           status = 'approved', approved_by = $1, approved_at = $2,
           root_admin_status = 'approved', root_admin_id = $1, root_admin_reviewed_at = $2
         WHERE id = $3 AND organization_id = $4`,
        [req.user.id, approvedAt, leaveId, oId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Final approval failed. ' + err.message });
    } finally { client.release(); }

    logApprovalAction({ leaveId, oId, actorId: req.user.id, actorName: req.user.name, action: 'root_approved', fromStatus: 'pending_root', toStatus: 'approved' });

    const { data } = await db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email)').eq('id', leaveId).single();
    notify(leave.user_id, 'Leave Approved', `Your leave from ${leave.start_date} to ${leave.end_date} has been approved by ${req.user.name}.`, oId);
    if (data.users?.email) {
      sendMail({ to: data.users.email, subject: 'Your Leave Request has been Approved', html: leaveStatusHtml(data.users, leave, 'approved', req.user.name, orgName, orgEmail) });
    }
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: POST /:id/final-reject (LEGACY) ──────────────────────────────────
router.post('/:id/final-reject', auth, hasPermission('leaves', 'reject'), async (req, res) => {
  try {
    const oId     = orgId(req);
    const { orgName, orgEmail } = await getOrgContext(oId);
    const leaveId = parseInt(req.params.id, 10);

    const { data: leave } = await db.from('leaves').select('*').eq('id', leaveId).eq('organization_id', oId).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    if (leave.status === 'rejected') return res.json(leave);
    if (!['pending_root', 'pending'].includes(leave.status)) {
      return res.status(400).json({ error: `Cannot reject a leave with status '${leave.status}'.`, current_status: leave.status });
    }

    const { remarks } = req.body || {};
    const rejectedAt = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE leaves SET
           status = 'rejected', approved_by = $1, approved_at = $2,
           remarks = $3,
           root_admin_status = 'rejected', root_admin_id = $1, root_admin_reviewed_at = $2
         WHERE id = $4 AND organization_id = $5`,
        [req.user.id, rejectedAt, remarks || null, leaveId, oId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Rejection failed. ' + err.message });
    } finally { client.release(); }

    logApprovalAction({ leaveId, oId, actorId: req.user.id, actorName: req.user.name, action: 'root_rejected', fromStatus: leave.status, toStatus: 'rejected', notes: remarks });
    notify(leave.user_id, 'Leave Request Rejected', `Your leave from ${leave.start_date} to ${leave.end_date} has been rejected.`, oId);

    const { data } = await db.from('leaves')
      .select('*, users!leaves_user_id_fkey(name, email)').eq('id', leaveId).single();
    if (data.users?.email) {
      sendMail({ to: data.users.email, subject: 'Your Leave Request has been Rejected', html: leaveStatusHtml(data.users, leave, 'rejected', req.user.name, orgName, orgEmail) });
    }
    res.json(flatOne(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: GET /:id/history ──────────────────────────────────────────────────
router.get('/:id/history', auth, async (req, res) => {
  try {
    const oId     = orgId(req);
    const leaveId = parseInt(req.params.id, 10);
    if (!leaveId) return res.status(400).json({ error: 'Invalid leave ID' });

    const { data: leave } = await db.from('leaves')
      .select('id, user_id').eq('id', leaveId).eq('organization_id', oId).maybeSingle();
    if (!leave) return res.status(404).json({ error: 'Leave not found' });

    if (!isAdminRole(req.user.role) && leave.user_id !== req.user.id) {
      const { data: employee } = await db.from('users')
        .select('department_id').eq('id', leave.user_id).eq('organization_id', oId).maybeSingle();
      let isDeptHead = false;
      if (employee?.department_id) {
        const { data: dept } = await db.from('departments')
          .select('head_user_id').eq('id', employee.department_id).eq('organization_id', oId).maybeSingle();
        isDeptHead = dept?.head_user_id === req.user.id;
      }
      if (!isDeptHead) return res.status(403).json({ error: 'Not authorized' });
    }

    const { data, error } = await db.from('leave_approval_log')
      .select('*').eq('leave_id', leaveId).eq('org_id', oId).order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
