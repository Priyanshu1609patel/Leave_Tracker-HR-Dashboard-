const express    = require('express');
const router     = express.Router();
const { db, pool } = require('../../config/db');
const { auth } = require('../../middleware/auth');
const { hasPermission, hasAnyPermission } = require('../../middleware/permissions');
const { orgId } = require('../../utils/helpers');
const { calculatePayroll, PayrollError } = require('../../services/payrollEngine');
const {
  generatePayrollRun,
  generateEmployeePayslip,
  lockPayrollRun,
  unlockPayrollRun,
  previewPayrollRun,
  GenerationError,
} = require('../../services/payrollGenerationService');
const { triggerManual } = require('../../services/payrollScheduler');
const { sendPayslipsBatch } = require('../../services/payrollEmailService');

// ── ROUTE: POST /payroll/calculate-preview ────────────────────────────────────
// Runs the payroll engine for one employee/period. No writes. Returns the full
// calculation breakdown so HR can verify before generating the payslip.
// Moved before all other routes so it doesn't collide with parameterized paths.
router.post('/calculate-preview', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { user_id, month, year } = req.body;
    if (!user_id || !month || !year) {
      return res.status(400).json({ error: 'user_id, month, and year are required' });
    }
    const result = await calculatePayroll({
      organizationId: oId,
      userId:         parseInt(user_id, 10),
      month:          parseInt(month,   10),
      year:           parseInt(year,    10),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof PayrollError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  }
});

function isAdmin(role) { return role === 'admin' || role === 'root_admin'; }

// ── Audit helper (fire-and-forget) ────────────────────────────────────────────
function logPayroll({ oId, actorId, actorName, action, entityType, entityId, targetUserId, oldValues, newValues, ip }) {
  pool.query(
    `INSERT INTO payroll_audit_log
       (organization_id, actor_id, actor_name, action, entity_type, entity_id,
        target_user_id, old_values, new_values, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [oId, actorId || null, actorName || null, action, entityType,
     entityId || null, targetUserId || null,
     oldValues  ? JSON.stringify(oldValues)  : null,
     newValues  ? JSON.stringify(newValues)  : null,
     ip || null]
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.1 — PAYROLL SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

const SETTINGS_DEFAULTS = {
  payroll_cycle: 'monthly', payroll_date: 1,
  working_days_rule: 'calendar', fixed_working_days: 26,
  weekend_policy: 'sat_sun', count_holidays_as_paid: true,
  grace_minutes: 15, late_allowance_per_month: 3,
  early_exit_allowance_minutes: 30, half_day_after_lates: 3,
  lop_after_half_days: 2,
  pf_enabled: true, esi_enabled: true,
  professional_tax_enabled: true, tds_enabled: false,
  payslip_auto_email: true, auto_generate_payroll: false,
  auto_publish: false, timezone: 'Asia/Kolkata',
  // Phase 3.5 — per-org configurable schedule (multi-tenant)
  payroll_generation_day: null, payroll_generation_time: '01:00',
  payroll_generate_for: 'PREVIOUS',
  payroll_publish_day: null,    payroll_publish_time: '09:00',
  payroll_payout_day: null,     payroll_payout_time: null,
  // Salary calculation rules (CTC-based auto-calculation)
  salary_calculation_rules: null,
  // Probation management settings
  probation_enabled:              false,
  default_probation_months:       3,
  paid_leave_during_probation:    true,
  probation_scope:                'selected', // 'selected' | 'all'
  // Per-day salary rate basis for LOP calculation
  // 'working_days': gross ÷ non-weekend working days (default)
  // 'calendar_days': gross ÷ total calendar days in month (e.g. Aug=÷31)
  per_day_salary_basis:           'working_days',
  // Payslip branding — org-specific details printed on payslips.
  // Null = not configured; payslip renders gracefully without them.
  payslip_company_address:        null,
  payslip_company_cin:            null,
  payslip_company_registration:   null,
  payslip_footer_note:            null,
};

const SETTINGS_FIELDS = Object.keys(SETTINGS_DEFAULTS);

// GET /api/payroll/settings
router.get('/settings', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { data, error } = await db.from('payroll_settings')
      .select('*').eq('organization_id', oId).maybeSingle();
    if (error) throw error;
    res.json(data || { ...SETTINGS_DEFAULTS, organization_id: oId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/payroll/settings
router.put('/settings', auth, hasPermission('payroll', 'manage_settings'), async (req, res) => {
  try {
    const oId = orgId(req);
    const payload = {};
    for (const key of SETTINGS_FIELDS) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }
    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }
    payload.updated_at = new Date().toISOString();
    payload.updated_by = req.user.id;

    const { data: existing } = await db.from('payroll_settings')
      .select('*').eq('organization_id', oId).maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await db.from('payroll_settings')
        .update(payload).eq('organization_id', oId).select('*').single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await db.from('payroll_settings')
        .insert({ ...payload, organization_id: oId }).select('*').single();
      if (error) throw error;
      result = data;
    }

    logPayroll({
      oId, actorId: req.user.id, actorName: req.user.name,
      action: 'settings_updated', entityType: 'payroll_settings',
      entityId: result.id, oldValues: existing || null, newValues: result,
      ip: req.ip,
    });

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /payroll/apply-probation-bulk ──────────────────────────────────────
// Applies company-wide probation to all eligible active employees (not already
// inactive/resigned/terminated/probation) using joining_date + default_months.
// Only available when scope='all'.
//
// Classification:
//   probation_end_date > today  → set Probation (still serving)
//   probation_end_date <= today → set Active + full_time (already completed)
//   no joining_date             → skipped
router.post('/apply-probation-bulk', auth, hasPermission('payroll', 'manage_settings'), async (req, res) => {
  try {
    const oId = orgId(req);

    const { data: settings } = await db.from('payroll_settings')
      .select('probation_enabled, default_probation_months, probation_scope')
      .eq('organization_id', oId).maybeSingle();

    if (!settings?.probation_enabled) {
      return res.status(400).json({ error: 'Probation is not enabled for this organisation.' });
    }
    if (settings?.probation_scope !== 'all') {
      return res.status(400).json({ error: 'Bulk apply is only available when scope is set to "All Employees".' });
    }

    const months = Number(settings.default_probation_months) || 3;
    const today  = new Date().toISOString().split('T')[0];

    // Use raw query so we can COALESCE joining_date + date_of_joining + created_at —
    // the same resolution the rest of the app uses. The Supabase client's joining_date
    // filter excluded employees whose date is only in date_of_joining or created_at.
    const { rows: employees } = await pool.query(`
      SELECT id,
        COALESCE(
          joining_date::text,
          date_of_joining,
          TO_CHAR(created_at, 'YYYY-MM-DD')
        ) AS resolved_joining_date
      FROM users
      WHERE organization_id = $1
        AND role = 'employee'
        AND COALESCE(employee_status, 'active') NOT IN ('inactive', 'resigned', 'terminated', 'probation')
        AND COALESCE(joining_date::text, date_of_joining) IS NOT NULL
    `, [oId]);

    let setToProbation = 0, setToActive = 0;

    for (const emp of employees) {
      const startDate = emp.resolved_joining_date.slice(0, 10);

      const endD = new Date(startDate + 'T12:00:00Z');
      endD.setMonth(endD.getMonth() + months);
      const endDate = endD.toISOString().split('T')[0];

      if (endDate > today) {
        // Still within probation window
        await db.from('users').update({
          probation_applicable: true,
          probation_months:     months,
          probation_start_date: startDate,
          probation_end_date:   endDate,
          employee_status:      'probation',
        }).eq('id', emp.id).eq('organization_id', oId);
        setToProbation++;
      } else {
        // Probation already completed — mark as confirmed full-time
        await db.from('users').update({
          probation_applicable: true,
          probation_months:     months,
          probation_start_date: startDate,
          probation_end_date:   endDate,
          employee_status:      'active',
          employment_type:      'full_time',
        }).eq('id', emp.id).eq('organization_id', oId);
        setToActive++;
      }
    }

    res.json({ success: true, set_to_probation: setToProbation, set_to_active: setToActive });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.1 — VERSIONED SALARY STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/payroll/employees — all employees with their current salary status
// Must be defined before /salary-structures/:id to avoid param collision
router.get('/employees', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { rows, error } = await pool.query(
      // BUG_131 FIX: return ALL salary structure fields so the ReviseModal pre-populates them.
      `SELECT
           u.id, u.name, u.email, u.department, u.position,
           u.employee_id, u.avatar_color, u.joining_date,
           ess.id                  AS salary_id,
           ess.gross_salary,
           ess.ctc,
           ess.effective_from,
           ess.basic,
           ess.hra,
           ess.da,
           ess.transport_allowance,
           ess.medical_allowance,
           ess.special_allowance,
           ess.other_allowance,
           ess.employee_pf,
           ess.employee_esi,
           ess.professional_tax,
           ess.tds,
           ess.other_deductions,
           ess.retention,
           ess.employer_pf,
           ess.employer_esi,
           ess.notes
         FROM users u
         LEFT JOIN employee_salary_structures ess
                ON ess.user_id = u.id
               AND ess.organization_id = $1
               AND ess.effective_to IS NULL
        WHERE u.organization_id = $1
          AND u.role = 'employee'
          AND (u.employee_status IS NULL OR u.employee_status NOT IN ('inactive','resigned','terminated'))
        ORDER BY u.name ASC`,
      [oId]
    );
    if (error) throw error;
    res.json(rows || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/salary-structures — list active salary per employee
router.get('/salary-structures', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { userId } = req.query;

    let query = db.from('employee_salary_structures')
      .select('*, users!employee_salary_structures_user_id_fkey(id, name, email, department, position, avatar_color, employee_id)')
      .eq('organization_id', oId)
      .is('effective_to', null)
      .order('created_at', { ascending: false });

    if (userId) query = query.eq('user_id', parseInt(userId));

    const { data, error } = await query;
    if (error) throw error;

    res.json((data || []).map(r => ({
      ...r,
      user_name:    r.users?.name,
      user_email:   r.users?.email,
      department:   r.users?.department,
      position:     r.users?.position,
      avatar_color: r.users?.avatar_color,
      employee_id:  r.users?.employee_id,
      users: undefined,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/salary-structures/history/:userId — all versions for one employee
router.get('/salary-structures/history/:userId', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId    = orgId(req);
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });

    // Verify employee belongs to this org
    const { data: emp } = await db.from('users')
      .select('id').eq('id', userId).eq('organization_id', oId).maybeSingle();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const { data, error } = await db.from('employee_salary_structures')
      .select('*, creator:users!employee_salary_structures_created_by_fkey(name)')
      .eq('organization_id', oId)
      .eq('user_id', userId)
      .order('effective_from', { ascending: false });

    if (error) throw error;
    res.json((data || []).map(r => ({
      ...r,
      created_by_name: r.creator?.name || null,
      creator: undefined,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/salary-structures/:id — single version
router.get('/salary-structures/:id', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { data, error } = await db.from('employee_salary_structures')
      .select('*, users!employee_salary_structures_user_id_fkey(id, name, department, position)')
      .eq('id', id).eq('organization_id', oId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Salary structure not found' });

    res.json({ ...data, user_name: data.users?.name, users: undefined });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/salary-structures — create new salary version (closes previous active)
router.post('/salary-structures', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId = orgId(req);
    const {
      user_id, effective_from,
      basic = 0, hra = 0, da = 0,
      transport_allowance = 0, medical_allowance = 0,
      special_allowance = 0, other_allowance = 0,
      employee_pf = 0, employee_esi = 0,
      professional_tax = 0, tds = 0, other_deductions = 0,
      retention = 0,
      employer_pf = 0, employer_esi = 0,
      notes,
    } = req.body;

    if (!user_id)        return res.status(400).json({ error: 'user_id is required' });
    if (!effective_from) return res.status(400).json({ error: 'effective_from is required' });

    // Verify employee belongs to this org
    const { data: employee } = await db.from('users')
      .select('id, name').eq('id', user_id).eq('organization_id', oId).maybeSingle();
    if (!employee) return res.status(404).json({ error: 'Employee not found in this organization' });

    const gross_salary =
      Number(basic) + Number(hra) + Number(da) +
      Number(transport_allowance) + Number(medical_allowance) +
      Number(special_allowance) + Number(other_allowance);

    const ctc = gross_salary + Number(employer_pf) + Number(employer_esi);

    const client = await pool.connect();
    let newRecord;
    let oldRecord;
    try {
      await client.query('BEGIN');

      // Pre-validate: check existing active record before attempting to close it
      const existingRes = await client.query(
        `SELECT id, effective_from FROM employee_salary_structures
          WHERE organization_id = $1 AND user_id = $2 AND effective_to IS NULL`,
        [oId, user_id]
      );
      const existingActive = existingRes.rows[0] || null;
      if (existingActive) {
        const existingDate = new Date(existingActive.effective_from);
        const newDate      = new Date(effective_from);
        if (newDate <= existingDate) {
          await client.query('ROLLBACK');
          const existingStr = existingActive.effective_from instanceof Date
            ? existingActive.effective_from.toISOString().split('T')[0]
            : String(existingActive.effective_from).split('T')[0];
          return res.status(400).json({
            error: `New effective date (${effective_from}) must be after the current active structure's effective date (${existingStr}). Please choose a later date.`,
          });
        }
      }

      // Close the current active version (effective_to = new_from - 1 day)
      const closeRes = await client.query(
        `UPDATE employee_salary_structures
            SET effective_to = ($1::date - INTERVAL '1 day')::date
          WHERE organization_id = $2
            AND user_id = $3
            AND effective_to IS NULL
          RETURNING *`,
        [effective_from, oId, user_id]
      );
      oldRecord = closeRes.rows[0] || null;

      // Add retention column if it doesn't exist yet (safe for older DBs)
      await client.query(`ALTER TABLE employee_salary_structures ADD COLUMN IF NOT EXISTS retention NUMERIC DEFAULT 0`).catch(() => {});

      const insertRes = await client.query(
        `INSERT INTO employee_salary_structures
           (organization_id, user_id, effective_from,
            basic, hra, da, transport_allowance, medical_allowance,
            special_allowance, other_allowance, gross_salary,
            employee_pf, employee_esi, professional_tax, tds, other_deductions, retention,
            employer_pf, employer_esi, ctc, notes, created_by)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING *`,
        [oId, user_id, effective_from,
         Number(basic), Number(hra), Number(da),
         Number(transport_allowance), Number(medical_allowance),
         Number(special_allowance), Number(other_allowance),
         parseFloat(gross_salary.toFixed(2)),
         Number(employee_pf), Number(employee_esi),
         Number(professional_tax), Number(tds), Number(other_deductions), Number(retention),
         Number(employer_pf), Number(employer_esi),
         parseFloat(ctc.toFixed(2)),
         notes || null, req.user.id]
      );
      newRecord = insertRes.rows[0];

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    logPayroll({
      oId, actorId: req.user.id, actorName: req.user.name,
      action: oldRecord ? 'salary_updated' : 'salary_created',
      entityType: 'salary_structure', entityId: newRecord.id,
      targetUserId: user_id,
      oldValues: null,
      newValues: newRecord,
      ip: req.ip,
    });

    // Notify the employee their compensation has changed (fire-and-forget)
    db.from('notifications').insert({
      user_id:         parseInt(user_id),
      title:           oldRecord ? 'Your Salary Structure Has Been Updated' : 'Your Salary Structure Has Been Set',
      message:         `Your ${oldRecord ? 'updated ' : ''}salary structure is effective from ${effective_from}. Gross pay: ₹${gross_salary.toLocaleString('en-IN')}.`,
      type:            'payroll',
      organization_id: oId,
    }).then(() => {}).catch(() => {});

    res.status(201).json(newRecord);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/payroll/salary-structures/:id — in-place correction of the current active structure.
// Does NOT create a new version or change effective_from / effective_to.
// Use when salary components were entered incorrectly and need to be fixed for the current period.
router.put('/salary-structures/:id', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid salary structure ID' });

    const {
      basic = 0, hra = 0, da = 0,
      transport_allowance = 0, medical_allowance = 0,
      special_allowance = 0, other_allowance = 0,
      employee_pf = 0, employee_esi = 0,
      professional_tax = 0, tds = 0, other_deductions = 0,
      retention = 0,
      employer_pf = 0, employer_esi = 0,
      notes,
      // Optional: HR may supply effective_from to backdate a future-dated structure
      // (e.g. set Sep-3 structure back to Aug-1 so August payroll can find it).
      // Null/undefined = keep existing value (COALESCE handles this).
      effective_from,
    } = req.body;

    // Only the currently active record (effective_to IS NULL) can be corrected
    const { rows: existing } = await pool.query(
      `SELECT id, user_id, effective_from, notes AS existing_notes
         FROM employee_salary_structures
        WHERE id = $1 AND organization_id = $2 AND effective_to IS NULL`,
      [id, oId]
    );
    if (!existing.length) {
      return res.status(404).json({
        error: 'Active salary structure not found. Only the current active record can be corrected in-place.',
      });
    }

    // Validate provided effective_from is a real date
    if (effective_from) {
      const parsed = new Date(effective_from + 'T12:00:00Z');
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: `Invalid effective_from date: ${effective_from}` });
      }
    }

    // Ensure retention column exists in case this DB is behind on migrations
    await pool.query(
      `ALTER TABLE employee_salary_structures ADD COLUMN IF NOT EXISTS retention NUMERIC DEFAULT 0`
    ).catch(() => {});

    const gross_salary = parseFloat((
      Number(basic) + Number(hra) + Number(da) +
      Number(transport_allowance) + Number(medical_allowance) +
      Number(special_allowance) + Number(other_allowance)
    ).toFixed(2));

    const ctc = parseFloat((gross_salary + Number(employer_pf) + Number(employer_esi)).toFixed(2));

    // $19 = effective_from (COALESCE: keep existing when not supplied)
    // $20 = id (WHERE), $21 = oId (WHERE)
    const { rows: updated } = await pool.query(
      `UPDATE employee_salary_structures SET
          basic               = $1,  hra                 = $2,  da                 = $3,
          transport_allowance = $4,  medical_allowance   = $5,
          special_allowance   = $6,  other_allowance     = $7,  gross_salary       = $8,
          employee_pf         = $9,  employee_esi        = $10, professional_tax   = $11,
          tds                 = $12, other_deductions    = $13, retention          = $14,
          employer_pf         = $15, employer_esi        = $16, ctc                = $17,
          notes               = COALESCE($18, notes),
          effective_from      = COALESCE($19::date, effective_from)
        WHERE id = $20 AND organization_id = $21
        RETURNING *`,
      [
        Number(basic), Number(hra), Number(da),
        Number(transport_allowance), Number(medical_allowance),
        Number(special_allowance), Number(other_allowance), gross_salary,
        Number(employee_pf), Number(employee_esi), Number(professional_tax),
        Number(tds), Number(other_deductions), Number(retention),
        Number(employer_pf), Number(employer_esi), ctc,
        notes ?? null,
        effective_from ?? null,
        id, oId,
      ]
    );

    logPayroll({
      oId, actorId: req.user.id, actorName: req.user.name,
      action: 'salary_updated', entityType: 'salary_structure', entityId: id,
      targetUserId: existing[0].user_id,
      oldValues: { effective_from: existing[0].effective_from },
      newValues: updated[0],
      ip: req.ip,
    });

    res.json(updated[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Payroll Structures ───────────────────────────────────────────────────────

// GET /api/payroll/structure?userId=
// Employees may view their own structure; admins need manage_structures permission.
router.get('/structure', auth, async (req, res) => {
  try {
    const oId = orgId(req);
    const { userId } = req.query;
    // Non-admins are always scoped to their own record regardless of userId param
    const targetId = isAdmin(req.user.role) ? (userId || req.user.id) : req.user.id;
    if (isAdmin(req.user.role) && userId && String(userId) !== String(req.user.id)) {
      // Admin querying another user — require explicit RBAC permission
      const { resolvePermissions, hasPermissionCheck } = require('../../services/permissionService');
      const perms = await resolvePermissions(req.user.id, oId);
      if (!hasPermissionCheck(perms, 'payroll', 'manage_structures')) {
        return res.status(403).json({ error: 'Permission denied. Required: payroll.manage_structures' });
      }
    }
    const { data, error } = await db.from('payroll_structures')
      .select('*').eq('user_id', targetId).eq('organization_id', oId)
      .order('effective_from', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/structure
// NOTE: Inserts into the legacy payroll_structures table. Column names differ from
// the newer employee_salary_structures table — mapped explicitly below.
router.post('/structure', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId  = orgId(req);
    const body = req.body;

    const user_id        = body.user_id;
    const effective_from = body.effective_from;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    if (user_id) {
      const { data: emp } = await db.from('users')
        .select('id').eq('id', parseInt(user_id)).eq('organization_id', oId).maybeSingle();
      if (!emp) return res.status(404).json({ error: 'Employee not found in this organisation' });
    }

    // Map to the actual payroll_structures column names
    const basic               = Number(body.basic               || 0);
    const hra                 = Number(body.hra                 || 0);
    const da                  = Number(body.da                  || 0);
    const transport_allowance = Number(body.transport_allowance || 0);
    const medical_allowance   = Number(body.medical_allowance   || 0);
    // Merge special_allowance + other_allowance into other_allowances (the legacy column)
    const other_allowances    = Number(body.other_allowances    || 0)
                              + Number(body.other_allowance     || 0)
                              + Number(body.special_allowance   || 0);
    // Support both naming conventions (Payroll.jsx sends pf_employee; SalaryStructure sends employee_pf)
    const pf_employee    = Number(body.pf_employee    || body.employee_pf    || 0);
    const pf_employer    = Number(body.pf_employer    || body.employer_pf    || 0);
    const esi_employee   = Number(body.esi_employee   || body.employee_esi   || 0);
    const esi_employer   = Number(body.esi_employer   || body.employer_esi   || 0);
    const professional_tax = Number(body.professional_tax || 0);
    const tds              = Number(body.tds              || 0);

    const { data, error } = await db.from('payroll_structures').insert({
      user_id, effective_from,
      basic, hra, da,
      transport_allowance, medical_allowance, other_allowances,
      pf_employee, pf_employer,
      esi_employee, esi_employer,
      professional_tax, tds,
      organization_id: oId,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/payroll/structure/:id
// NOTE: Updates the legacy payroll_structures table — column names mapped explicitly.
router.put('/structure/:id', auth, hasPermission('payroll', 'manage_structures'), async (req, res) => {
  try {
    const oId  = orgId(req);
    const b    = req.body;

    if (b.user_id !== undefined) {
      const { data: emp } = await db.from('users')
        .select('id').eq('id', parseInt(b.user_id)).eq('organization_id', oId).maybeSingle();
      if (!emp) return res.status(404).json({ error: 'Employee not found in this organisation' });
    }

    // Build update payload using only columns that exist in payroll_structures
    const patch = {};
    if (b.user_id        !== undefined) patch.user_id          = b.user_id;
    if (b.effective_from !== undefined) patch.effective_from   = b.effective_from;
    if (b.basic          !== undefined) patch.basic            = Number(b.basic);
    if (b.hra            !== undefined) patch.hra              = Number(b.hra);
    if (b.da             !== undefined) patch.da               = Number(b.da);
    if (b.transport_allowance !== undefined) patch.transport_allowance = Number(b.transport_allowance);
    if (b.medical_allowance   !== undefined) patch.medical_allowance   = Number(b.medical_allowance);
    if (b.professional_tax    !== undefined) patch.professional_tax    = Number(b.professional_tax);
    if (b.tds                 !== undefined) patch.tds                 = Number(b.tds);
    // Merge special_allowance + other_allowance into the legacy other_allowances column
    const hasOther = b.other_allowances !== undefined || b.other_allowance !== undefined || b.special_allowance !== undefined;
    if (hasOther) {
      patch.other_allowances = Number(b.other_allowances || 0)
                             + Number(b.other_allowance  || 0)
                             + Number(b.special_allowance || 0);
    }
    // Support both naming conventions
    if (b.pf_employee  !== undefined || b.employee_pf  !== undefined) patch.pf_employee  = Number(b.pf_employee  ?? b.employee_pf  ?? 0);
    if (b.pf_employer  !== undefined || b.employer_pf  !== undefined) patch.pf_employer  = Number(b.pf_employer  ?? b.employer_pf  ?? 0);
    if (b.esi_employee !== undefined || b.employee_esi !== undefined) patch.esi_employee = Number(b.esi_employee ?? b.employee_esi ?? 0);
    if (b.esi_employer !== undefined || b.employer_esi !== undefined) patch.esi_employer = Number(b.esi_employer ?? b.employer_esi ?? 0);

    const { data, error } = await db.from('payroll_structures')
      .update(patch).eq('id', req.params.id).eq('organization_id', oId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Payslips ─────────────────────────────────────────────────────────────────

// GET /api/payroll/payslips?userId=&year=
router.get('/payslips', auth, async (req, res) => {
  try {
    const oId = req.user.organization_id;
    const { userId, year } = req.query;
    const targetId = isAdmin(req.user.role) && userId ? userId : req.user.id;
    let q = db.from('payslips')
      .select('*, users!user_id(name, department, position)')
      .eq('organization_id', oId)
      .eq('user_id', targetId)
      .order('year', { ascending: false })
      .order('month', { ascending: false });
    if (year) q = q.eq('year', year);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/payslips/all — admin: all employees for a period
router.get('/payslips/all', auth, hasPermission('payroll', 'view_payslips'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { month, year } = req.query;
    const conditions = [`ps.organization_id = $1`];
    const params     = [oId];
    if (month) { conditions.push(`ps.month = $${params.length + 1}`); params.push(month); }
    if (year)  { conditions.push(`ps.year  = $${params.length + 1}`); params.push(Number(year)); }
    const { rows } = await pool.query(
      `SELECT ps.*,
              u.name AS user_name, u.department, u.position, u.avatar_color
         FROM payslips ps
         JOIN  users u ON u.id = ps.user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ps.created_at DESC`,
      params
    );
    // Shape the rows so callers receive the same nested structure Supabase used to provide
    res.json(rows.map(r => ({
      ...r,
      users: { name: r.user_name, department: r.department, position: r.position, avatar_color: r.avatar_color },
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/payslips/generate — legacy single-employee payslip generation
router.post('/payslips/generate', auth, hasPermission('payroll', 'generate'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { user_id, month, year, other_deductions, notes } = req.body;
    if (!user_id || !month || !year) return res.status(400).json({ error: 'user_id, month, year required' });

    // BUG_133 FIX: Fetch salary structure — check employee_salary_structures (primary table)
    // first, then fall back to the legacy payroll_structures table.
    // The date filter uses <= first day of the month so future-dated structures are excluded.
    const periodStart = `${year}-${String(month).padStart(2,'0')}-01`;

    // 1. Try employee_salary_structures (the Phase 3 primary table)
    const essRes = await pool.query(
      `SELECT id,
              basic, hra, da, transport_allowance, medical_allowance,
              special_allowance AS special_allowance,
              other_allowance   AS other_allowances,
              employee_pf AS pf_employee, employee_esi AS esi_employee,
              employer_pf AS pf_employer, employer_esi AS esi_employer,
              professional_tax, tds, other_deductions, retention,
              effective_from
         FROM employee_salary_structures
        WHERE user_id        = $1
          AND organization_id = $2
          AND effective_from <= $3
          AND (effective_to IS NULL OR effective_to >= $3)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [user_id, oId, periodStart]
    );

    let structure = essRes.rows[0] || null;

    // 2. Fallback: legacy payroll_structures table
    if (!structure) {
      let { data: structures } = await db.from('payroll_structures')
        .select('*').eq('user_id', user_id).eq('organization_id', oId)
        .lte('effective_from', periodStart)
        .order('effective_from', { ascending: false })
        .order('id', { ascending: false })
        .limit(1);
      if (!structures?.length) {
        const { data: fallback } = await db.from('payroll_structures')
          .select('*').eq('user_id', user_id).eq('organization_id', oId)
          .order('effective_from', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        structures = fallback;
      }
      structure = structures?.[0] || null;
    }

    if (!structure) return res.status(400).json({ error: 'No salary structure found for this employee' });

    // Block regeneration of locked or published payslips
    const { force } = req.body;
    const existingCheck = await pool.query(
      `SELECT id, status, locked FROM payslips
        WHERE user_id = $1 AND month = $2 AND year = $3 AND organization_id = $4`,
      [user_id, String(month).padStart(2, '0'), Number(year), oId]
    );
    const existingSlip = existingCheck.rows[0] || null;
    // Locked payslips may NEVER be overwritten — even with force=true
    if (existingSlip?.locked) {
      return res.status(409).json({
        error: 'This payslip is locked and cannot be regenerated. Unlock the payroll run first.',
        payslip_id: existingSlip.id,
        code: 'PAYSLIP_LOCKED',
      });
    }
    if (existingSlip?.status === 'published' && !force) {
      return res.status(409).json({
        error: 'This payslip has already been published. Pass force=true to regenerate.',
        payslip_id: existingSlip.id,
      });
    }

    // FIX: use actual last day of the month (not hardcoded 31 — breaks February)
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const { data: att } = await db.from('attendance')
      .select('status, date').eq('user_id', user_id).eq('organization_id', oId)
      .gte('date', `${year}-${String(month).padStart(2,'0')}-01`)
      .lte('date', `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`);

    // Count working days in the month based on org work schedule
    const { data: ws } = await db.from('work_schedule').select('work_days').eq('organization_id', oId).limit(1).maybeSingle();
    const workDays = (ws?.work_days || '1,2,3,4,5').split(',').map(Number);
    let totalWorkingDays = 0;
    const d = new Date(Number(year), Number(month) - 1, 1);
    while (d.getMonth() === Number(month) - 1) {
      if (workDays.includes(d.getDay())) totalWorkingDays++;
      d.setDate(d.getDate() + 1);
    }

    // FIX: half_day counts as 0.5 present and 0.5 LOP — not a full present day
    const fullPresent  = (att || []).filter(a => ['present', 'wfh'].includes(a.status)).length;
    const halfDayCount = (att || []).filter(a => a.status === 'half_day').length;
    const absentCount  = (att || []).filter(a => a.status === 'absent').length;
    const leaveCount   = (att || []).filter(a => a.status === 'on_leave').length;
    const presentDays  = fullPresent + halfDayCount * 0.5;
    // FIX: approved leaves (on_leave) are NOT LOP; absents and half-days are
    const lopDays      = absentCount + halfDayCount * 0.5;

    const grossSalary  = (structure.basic || 0) + (structure.hra || 0) + (structure.da || 0) + (structure.transport_allowance || 0) + (structure.medical_allowance || 0) + (structure.special_allowance || 0) + (structure.other_allowances || 0);
    const perDaySalary = totalWorkingDays > 0 ? grossSalary / totalWorkingDays : 0;
    const lopAmount    = lopDays * perDaySalary;
    const totalDed     = (structure.pf_employee || 0) + (structure.esi_employee || 0) + (structure.professional_tax || 0) + (structure.tds || 0) + Number(other_deductions || 0) + Number(structure.retention || 0) + lopAmount;
    const netSalary    = Math.max(0, grossSalary - totalDed);

    // Use an advisory lock keyed on (org_id, user_id, month, year) to prevent
    // two concurrent generate requests from producing duplicate payslips/notifications.
    // pg_advisory_xact_lock releases automatically at COMMIT/ROLLBACK.
    const lockKey = BigInt(oId) * 10000000n + BigInt(user_id) * 10000n + BigInt(year % 100) * 100n + BigInt(month);
    const client = await pool.connect();
    let data;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

      // Re-check inside lock: another concurrent request may have just locked or published
      const slipCheck = await client.query(
        `SELECT id, status, locked FROM payslips
         WHERE user_id = $1 AND month = $2 AND year = $3 AND organization_id = $4`,
        [user_id, String(month).padStart(2,'0'), Number(year), oId]
      );
      const lockedSlip = slipCheck.rows[0];
      if (lockedSlip?.locked) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Payslip is locked. Unlock the payroll run first.',
          payslip_id: lockedSlip.id,
          code: 'PAYSLIP_LOCKED',
        });
      }
      if (lockedSlip?.status === 'published' && !force) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Payslip already published. Pass force=true to regenerate.',
          payslip_id: lockedSlip.id,
        });
      }

      const upsertRes = await client.query(
        `INSERT INTO payslips
           (user_id, month, year, pay_period, basic, hra, da, transport_allowance,
            medical_allowance, other_allowances, gross_salary, pf_employee, pf_employer,
            esi_employee, esi_employer, professional_tax, tds, other_deductions,
            total_deductions, lop_days, lop_amount, net_salary, working_days, present_days,
            absent_days, leave_days, notes, status, organization_id, generated_by, retention)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'generated',$28,$29,$30)
         ON CONFLICT (user_id, month, year)
         DO UPDATE SET
           basic=$5, hra=$6, da=$7, transport_allowance=$8, medical_allowance=$9,
           other_allowances=$10, gross_salary=$11, pf_employee=$12, pf_employer=$13,
           esi_employee=$14, esi_employer=$15, professional_tax=$16, tds=$17,
           other_deductions=$18, total_deductions=$19, lop_days=$20, lop_amount=$21,
           net_salary=$22, working_days=$23, present_days=$24, absent_days=$25,
           leave_days=$26, notes=$27, status='generated', generated_by=$29, retention=$30
         RETURNING *`,
        [user_id, String(month).padStart(2,'0'), Number(year),
         `${String(month).padStart(2,'0')}/${year}`,
         structure.basic, structure.hra, structure.da, structure.transport_allowance,
         structure.medical_allowance, structure.other_allowances,
         parseFloat(grossSalary.toFixed(2)),
         structure.pf_employee, structure.pf_employer||0,
         structure.esi_employee, structure.esi_employer||0,
         structure.professional_tax, structure.tds,
         Number(other_deductions||0), parseFloat(totalDed.toFixed(2)),
         lopDays, parseFloat(lopAmount.toFixed(2)), parseFloat(netSalary.toFixed(2)),
         totalWorkingDays, presentDays, absentCount, leaveCount,
         notes||'', oId, req.user.id, Number(structure.retention || 0)]
      );
      data = upsertRes.rows[0];

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget notification after COMMIT
    db.from('notifications').insert({
      user_id, title: 'Payslip Generated',
      message: `Your payslip for ${String(month).padStart(2,'0')}/${year} has been generated. Net pay: ₹${netSalary.toFixed(2)}`,
      type: 'payroll', organization_id: oId,
    }).then(() => {});
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/payroll/payslips/:id/publish
router.put('/payslips/:id/publish', auth, hasPermission('payroll', 'generate'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid payslip ID' });

    // Verify payslip belongs to this org and is not locked before publishing
    const { rows } = await pool.query(
      `SELECT id, status, locked FROM payslips
        WHERE id = $1 AND organization_id = $2`,
      [id, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payslip not found' });
    if (rows[0].locked) {
      return res.status(409).json({ error: 'Payslip is locked and cannot be published without unlocking.' });
    }

    await pool.query(
      `UPDATE payslips SET status = 'published' WHERE id = $1 AND organization_id = $2`,
      [id, oId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.3 — PAYROLL GENERATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function genErrResponse(res, err) {
  if (err instanceof GenerationError) {
    return res.status(400).json({ error: err.message, code: err.code, meta: err.meta });
  }
  return res.status(500).json({ error: err.message });
}

// POST /api/payroll/preview — dry-run calculations, no writes
router.post('/preview', auth, hasPermission('payroll', 'generate'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const result = await previewPayrollRun({
      organizationId: oId,
      month: parseInt(month, 10),
      year:  parseInt(year,  10),
    });
    res.json(result);
  } catch (err) { genErrResponse(res, err); }
});

// POST /api/payroll/generate — create a payroll run and write payslip snapshots
router.post('/generate', auth, hasPermission('payroll', 'generate'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { month, year, notes, force } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const result = await generatePayrollRun({
      organizationId: oId,
      month:          parseInt(month, 10),
      year:           parseInt(year,  10),
      generatedBy:    req.user.id,
      notes:          notes  || null,
      force:          Boolean(force),
      ip:             req.ip,
    });
    res.status(201).json(result);
  } catch (err) { genErrResponse(res, err); }
});

// POST /api/payroll/lock/:id — lock a completed run (payslips become immutable)
router.post('/lock/:id', auth, hasPermission('payroll', 'lock'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });
    const result = await lockPayrollRun({
      organizationId: oId,
      runId,
      actorId:   req.user.id,
      actorName: req.user.name,
      ip:        req.ip,
    });
    res.json(result);

    // Fire-and-forget: notify every employee whose payslip is in this locked run
    pool.query(
      `SELECT ps.user_id, ps.net_salary, ps.month, ps.year
         FROM payslips ps
        WHERE ps.payroll_run_id = $1 AND ps.organization_id = $2`,
      [runId, oId]
    ).then(({ rows }) => {
      if (!rows.length) return;
      return db.from('notifications').insert(
        rows.map(r => ({
          user_id:         r.user_id,
          title:           'Your Payslip is Ready',
          message:         `Your payslip for ${String(r.month).padStart(2,'0')}/${r.year} has been finalized. Net pay: ₹${Number(r.net_salary).toFixed(2)}.`,
          type:            'payroll',
          organization_id: oId,
        }))
      );
    }).catch(() => {});
  } catch (err) { genErrResponse(res, err); }
});

// POST /api/payroll/unlock/:id — unlock a locked run (root admin only via RBAC)
router.post('/unlock/:id', auth, hasPermission('payroll', 'unlock'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });
    const result = await unlockPayrollRun({
      organizationId: oId,
      runId,
      actorId:   req.user.id,
      actorName: req.user.name,
      ip:        req.ip,
    });
    res.json(result);
  } catch (err) { genErrResponse(res, err); }
});

// GET /api/payroll/runs — list all payroll runs for the org
router.get('/runs', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { rows } = await pool.query(
      `SELECT pr.*,
              u.name  AS generated_by_name,
              lu.name AS locked_by_name
         FROM payroll_runs pr
         LEFT JOIN users u  ON u.id  = pr.generated_by
         LEFT JOIN users lu ON lu.id = pr.locked_by
        WHERE pr.organization_id = $1
        ORDER BY pr.year DESC, pr.month DESC`,
      [oId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/runs/:id — run details + per-employee breakdown
router.get('/runs/:id', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });

    const runRes = await pool.query(
      `SELECT pr.*,
              u.name  AS generated_by_name,
              lu.name AS locked_by_name
         FROM payroll_runs pr
         LEFT JOIN users u  ON u.id  = pr.generated_by
         LEFT JOIN users lu ON lu.id = pr.locked_by
        WHERE pr.id = $1 AND pr.organization_id = $2`,
      [runId, oId]
    );
    if (!runRes.rows.length) return res.status(404).json({ error: 'Payroll run not found' });

    const { rows: employees } = await pool.query(
      `SELECT pre.id, pre.user_id, pre.status AS employee_status,
              pre.error_message, pre.processed_at, pre.payslip_id,
              u.name, u.employee_id, u.department, u.position, u.avatar_color,
              ps.gross_salary, ps.total_deductions, ps.net_salary,
              ps.lop_days, ps.locked
         FROM payroll_run_employees pre
         JOIN  users u ON u.id = pre.user_id
         LEFT JOIN payslips ps ON ps.id = pre.payslip_id
        WHERE pre.payroll_run_id  = $1
          AND pre.organization_id = $2
        ORDER BY u.name ASC`,
      [runId, oId]
    );

    res.json({ ...runRes.rows[0], employees });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/payslips/:id/details — full payslip breakdown (run-generated)
// Placed BEFORE /:id to ensure Express matches /details as a literal segment
router.get('/payslips/:id/details', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId       = orgId(req);
    const payslipId = parseInt(req.params.id, 10);
    if (!payslipId) return res.status(400).json({ error: 'Invalid payslip ID' });

    const { rows } = await pool.query(
      `SELECT ps.*,
              u.name, u.employee_id, u.department, u.position, u.email, u.avatar_color,
              pr.month  AS run_month,
              pr.year   AS run_year,
              pr.status AS run_status
         FROM payslips ps
         JOIN  users u ON u.id = ps.user_id
         LEFT JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE ps.id = $1 AND ps.organization_id = $2`,
      [payslipId, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payslip not found' });

    // Non-admin employees may only view their own payslips
    const slip = rows[0];
    if (!isAdmin(req.user.role) && slip.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(slip);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.5 — SCHEDULER API
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/payroll/scheduler/trigger — manually trigger payroll for a period
router.post('/scheduler/trigger', auth, hasPermission('payroll', 'generate'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { month, year, force } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const result = await triggerManual({
      organizationId: oId,
      month:          parseInt(month, 10),
      year:           parseInt(year,  10),
      force:          Boolean(force),
      actorId:        req.user.id,
      actorName:      req.user.name,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof GenerationError) {
      return res.status(400).json({ error: err.message, code: err.code, meta: err.meta });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payroll/scheduler/runs — list scheduler run history for this org
router.get('/scheduler/runs', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { rows } = await pool.query(
      `SELECT psr.*, pr.status AS run_status, pr.employee_count, pr.total_net
         FROM payroll_scheduler_runs psr
         LEFT JOIN payroll_runs pr ON pr.id = psr.payroll_run_id
        WHERE psr.organization_id = $1
        ORDER BY psr.created_at DESC
        LIMIT 100`,
      [oId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/scheduler/email-log — email log for a payroll run
router.get('/scheduler/email-log', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.query.runId || '0', 10);
    const where = runId
      ? 'pel.organization_id = $1 AND pel.payroll_run_id = $2'
      : 'pel.organization_id = $1';
    const params = runId ? [oId, runId] : [oId];
    const { rows } = await pool.query(
      `SELECT pel.*, u.name, u.employee_id
         FROM payroll_email_log pel
         JOIN users u ON u.id = pel.user_id
        WHERE ${where}
        ORDER BY pel.sent_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/payslips/:id — single payslip by primary key
router.get('/payslips/:id', auth, async (req, res) => {
  try {
    const oId       = orgId(req);
    const payslipId = parseInt(req.params.id, 10);
    if (!payslipId) return res.status(400).json({ error: 'Invalid payslip ID' });

    const { rows } = await pool.query(
      `SELECT ps.*, u.name, u.employee_id, u.department, u.position, u.avatar_color
         FROM payslips ps
         JOIN  users u ON u.id = ps.user_id
        WHERE ps.id = $1 AND ps.organization_id = $2`,
      [payslipId, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payslip not found' });

    const slip = rows[0];
    if (!isAdmin(req.user.role) && slip.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(slip);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6A — ADJUSTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

const {
  createAdjustment,
  updateAdjustment,
  deleteAdjustment,
  listAdjustments,
  createOverride,
  deleteOverride,
  listOverrides,
} = require('../../services/payrollAdjustmentService');

const {
  getPayrollSummary,
  getDepartmentSummary,
  getSalaryRegister,
  getLopReport,
  getAdjustmentSummary,
  getMonthlyTrend,
  toCsv,
  SALARY_REGISTER_FIELDS,
} = require('../../services/payrollReportService');

const { generateBankFile, SUPPORTED_FORMATS } = require('../../services/payrollBankService');

// GET /api/payroll/adjustments
router.get('/adjustments', auth, hasPermission('payroll', 'manage_adjustments'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { runId, userId, month, year } = req.query;
    const rows = await listAdjustments({
      organizationId: oId,
      payrollRunId: runId ? parseInt(runId, 10) : null,
      userId:       userId ? parseInt(userId, 10) : null,
      month:        month  ? parseInt(month,  10) : null,
      year:         year   ? parseInt(year,   10) : null,
    });
    res.json(rows);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /api/payroll/adjustments
router.post('/adjustments', auth, hasPermission('payroll', 'manage_adjustments'), async (req, res) => {
  try {
    const oId = orgId(req);
    const {
      payroll_run_id, payslip_id, user_id,
      adjustment_type, adjustment_category,
      amount, addition_or_deduction,
      effective_month, effective_year, remarks,
    } = req.body;

    if (!user_id)               return res.status(400).json({ error: 'user_id is required' });
    if (!adjustment_category)   return res.status(400).json({ error: 'adjustment_category is required' });
    if (amount === undefined || amount === null) return res.status(400).json({ error: 'amount is required' });
    if (!effective_month || !effective_year) return res.status(400).json({ error: 'effective_month and effective_year are required' });

    const adj = await createAdjustment({
      organizationId: oId,
      payrollRunId:  payroll_run_id || null,
      payslipId:     payslip_id     || null,
      userId:        parseInt(user_id, 10),
      adjustmentType: adjustment_type,
      adjustmentCategory: adjustment_category,
      amount:        parseFloat(amount),
      additionOrDeduction: addition_or_deduction,
      effectiveMonth: parseInt(effective_month, 10),
      effectiveYear:  parseInt(effective_year,  10),
      remarks,
      createdBy: req.user.id,
      ip: req.ip,
    });
    res.status(201).json(adj);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// PUT /api/payroll/adjustments/:id
router.put('/adjustments/:id', auth, hasPermission('payroll', 'manage_adjustments'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid adjustment ID' });
    const adj = await updateAdjustment({
      organizationId: oId,
      adjustmentId: id,
      payload: req.body,
      updatedBy: req.user.id,
      ip: req.ip,
    });
    res.json(adj);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// DELETE /api/payroll/adjustments/:id
router.delete('/adjustments/:id', auth, hasPermission('payroll', 'manage_adjustments'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid adjustment ID' });
    await deleteAdjustment({ organizationId: oId, adjustmentId: id, deletedBy: req.user.id, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6B — ATTENDANCE OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/payroll/overrides
router.get('/overrides', auth, hasPermission('payroll', 'manage_overrides'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { runId, userId } = req.query;
    const rows = await listOverrides({
      organizationId: oId,
      payrollRunId: runId ? parseInt(runId, 10) : null,
      userId:       userId ? parseInt(userId, 10) : null,
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/overrides
router.post('/overrides', auth, hasPermission('payroll', 'manage_overrides'), async (req, res) => {
  try {
    const oId = orgId(req);
    const { payroll_run_id, user_id, original_values, override_values, reason } = req.body;
    if (!payroll_run_id) return res.status(400).json({ error: 'payroll_run_id is required' });
    if (!user_id)        return res.status(400).json({ error: 'user_id is required' });
    if (!reason)         return res.status(400).json({ error: 'reason is required' });

    const ov = await createOverride({
      organizationId: oId,
      payrollRunId:   parseInt(payroll_run_id, 10),
      userId:         parseInt(user_id, 10),
      originalValues: original_values || {},
      overrideValues: override_values || {},
      reason,
      createdBy: req.user.id,
      ip: req.ip,
    });
    res.status(201).json(ov);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// DELETE /api/payroll/overrides/:id
router.delete('/overrides/:id', auth, hasPermission('payroll', 'manage_overrides'), async (req, res) => {
  try {
    const oId = orgId(req);
    const id  = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid override ID' });
    await deleteOverride({ organizationId: oId, overrideId: id, deletedBy: req.user.id, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6C — PAYROLL LIFECYCLE (verify / approve / mark-paid)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/payroll/runs/:id/verify — HR Admin marks run as verified
router.post('/runs/:id/verify', auth, hasPermission('payroll', 'verify'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });

    const { rows } = await pool.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND organization_id = $2`,
      [runId, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payroll run not found' });
    if (!['completed','completed_with_errors'].includes(rows[0].status)) {
      return res.status(409).json({ error: `Cannot verify a run with status '${rows[0].status}'` });
    }

    const { rows: updated } = await pool.query(
      `UPDATE payroll_runs
          SET status = 'verified', verified_by = $1, verified_at = NOW()
        WHERE id = $2 AND organization_id = $3
       RETURNING *`,
      [req.user.id, runId, oId]
    );

    logPayroll({ oId, actorId: req.user.id, actorName: req.user.name,
      action: 'payroll_verified', entityType: 'payroll_run', entityId: runId, ip: req.ip });

    res.json(updated[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/runs/:id/approve — Root Admin approves verified run
router.post('/runs/:id/approve', auth, hasPermission('payroll', 'approve'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });

    const { rows } = await pool.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND organization_id = $2`,
      [runId, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payroll run not found' });
    if (rows[0].status !== 'verified') {
      return res.status(409).json({ error: `Cannot approve a run with status '${rows[0].status}'. Run must be verified first.` });
    }

    const { rows: updated } = await pool.query(
      `UPDATE payroll_runs
          SET status = 'approved', approved_by = $1, approved_at = NOW()
        WHERE id = $2 AND organization_id = $3
       RETURNING *`,
      [req.user.id, runId, oId]
    );

    logPayroll({ oId, actorId: req.user.id, actorName: req.user.name,
      action: 'payroll_approved', entityType: 'payroll_run', entityId: runId, ip: req.ip });

    res.json(updated[0]);

    // Fire payslip emails if auto-email is enabled — fire-and-forget after response
    setImmediate(async () => {
      try {
        const { rows: [ps] } = await pool.query(
          `SELECT payslip_auto_email FROM payroll_settings WHERE organization_id = $1`,
          [oId]
        );
        if (!ps?.payslip_auto_email) return;

        // Guard: don't re-send if already emailed for this run
        const { rows: already } = await pool.query(
          `SELECT 1 FROM payroll_email_log WHERE payroll_run_id = $1 AND organization_id = $2 AND status = 'sent' LIMIT 1`,
          [runId, oId]
        );
        if (already.length) return;

        // Publish all payslips in this run (generated → published)
        const { rows: runRow } = await pool.query(
          `SELECT month, year FROM payroll_runs WHERE id = $1`, [runId]
        );
        await pool.query(
          `UPDATE payslips SET status = 'published'
           WHERE payroll_run_id = $1 AND organization_id = $2 AND status = 'generated'`,
          [runId, oId]
        );

        await sendPayslipsBatch({ organizationId: oId, runId, month: runRow[0].month, year: runRow[0].year });
      } catch (e) {
        console.error('[payroll approve] auto-email failed:', e.message);
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payroll/runs/:id/mark-paid — Root Admin records salary credited
router.post('/runs/:id/mark-paid', auth, hasPermission('payroll', 'mark_paid'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });

    const { rows } = await pool.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND organization_id = $2`,
      [runId, oId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payroll run not found' });
    if (!['locked', 'approved'].includes(rows[0].status)) {
      return res.status(409).json({ error: `Cannot mark as paid from status '${rows[0].status}'` });
    }

    const { rows: updated } = await pool.query(
      `UPDATE payroll_runs
          SET status = 'paid', paid_by = $1, paid_at = NOW()
        WHERE id = $2 AND organization_id = $3
       RETURNING *`,
      [req.user.id, runId, oId]
    );

    logPayroll({ oId, actorId: req.user.id, actorName: req.user.name,
      action: 'payroll_paid', entityType: 'payroll_run', entityId: runId, ip: req.ip });

    res.json(updated[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6D — DASHBOARD DATA
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/payroll/dashboard?month=&year=
router.get('/dashboard', auth, hasPermission('payroll', 'view'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const month = req.query.month ? parseInt(req.query.month, 10) : null;
    const year  = req.query.year  ? parseInt(req.query.year,  10) : null;

    const [summary, deptBreakdown, trend] = await Promise.all([
      getPayrollSummary({ organizationId: oId, month, year }),
      getDepartmentSummary({ organizationId: oId, month, year }),
      getMonthlyTrend({ organizationId: oId, months: 6 }),
    ]);

    // KPI cards — aggregate across all runs in the filter period
    const kpi = summary.reduce((acc, r) => {
      acc.totalPayroll    += Number(r.total_gross    || 0);
      acc.totalNet        += Number(r.total_net      || 0);
      acc.totalDeductions += Number(r.total_deductions || 0);
      acc.employeesPaid   += Number(r.employee_count || 0);
      acc.errorCount      += Number(r.error_count    || 0);
      return acc;
    }, { totalPayroll: 0, totalNet: 0, totalDeductions: 0, employeesPaid: 0, errorCount: 0 });

    kpi.avgSalary = kpi.employeesPaid > 0 ? kpi.totalNet / kpi.employeesPaid : 0;

    // Pending runs (not yet paid)
    const { rows: pending } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payroll_runs
        WHERE organization_id = $1
          AND status NOT IN ('paid','failed','draft')
          AND ($2::int IS NULL OR month = $2)
          AND ($3::int IS NULL OR year  = $3)`,
      [oId, month, year]
    );
    kpi.pendingRuns = pending[0]?.count || 0;

    // Adjustment totals
    const { rows: adjAgg } = await pool.query(
      `SELECT
           SUM(CASE WHEN addition_or_deduction = 'addition' THEN amount ELSE 0 END) AS total_bonuses,
           SUM(CASE WHEN addition_or_deduction = 'deduction' THEN amount ELSE 0 END) AS total_deduction_adj
         FROM payroll_adjustments pa
         JOIN payroll_runs pr ON pr.id = pa.payroll_run_id
        WHERE pa.organization_id = $1
          AND pa.deleted_at IS NULL
          AND ($2::int IS NULL OR pr.month = $2)
          AND ($3::int IS NULL OR pr.year  = $3)`,
      [oId, month, year]
    );
    kpi.totalBonuses        = Number(adjAgg[0]?.total_bonuses || 0);
    kpi.totalDeductionAdj   = Number(adjAgg[0]?.total_deduction_adj || 0);

    res.json({ kpi, summary, deptBreakdown, trend });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6E — REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

function reportParams(req) {
  return {
    organizationId: orgId(req),
    month: req.query.month ? parseInt(req.query.month, 10) : null,
    year:  req.query.year  ? parseInt(req.query.year,  10) : null,
  };
}

// GET /api/payroll/reports/summary
router.get('/reports/summary', auth, hasPermission('payroll', 'run_reports'), async (req, res) => {
  try {
    const data = await getPayrollSummary(reportParams(req));
    if (req.query.format === 'csv') {
      const fields = [
        { key: 'run_id', label: 'Run ID' }, { key: 'month', label: 'Month' }, { key: 'year', label: 'Year' },
        { key: 'status' }, { key: 'employee_count', label: 'Employees' },
        { key: 'total_gross', label: 'Total Gross' }, { key: 'total_deductions', label: 'Total Deductions' },
        { key: 'total_net', label: 'Total Net' }, { key: 'total_adjustments', label: 'Adjustments' },
        { key: 'generated_by_name', label: 'Generated By' },
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="payroll_summary.csv"');
      return res.send(toCsv(data, fields));
    }
    logPayroll({ oId: orgId(req), actorId: req.user.id, actorName: req.user.name,
      action: 'report_exported', entityType: 'report', ip: req.ip });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/reports/department
router.get('/reports/department', auth, hasPermission('payroll', 'run_reports'), async (req, res) => {
  try {
    const data = await getDepartmentSummary(reportParams(req));
    if (req.query.format === 'csv') {
      const fields = [
        { key: 'department' }, { key: 'employee_count', label: 'Employees' },
        { key: 'total_gross', label: 'Total Gross' }, { key: 'total_deductions', label: 'Deductions' },
        { key: 'total_lop', label: 'LOP Amount' }, { key: 'total_net', label: 'Net Salary' },
        { key: 'avg_net_salary', label: 'Avg Net' }, { key: 'total_lop_days', label: 'LOP Days' },
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="dept_summary.csv"');
      return res.send(toCsv(data, fields));
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/reports/salary-register
router.get('/reports/salary-register', auth, hasPermission('payroll', 'run_reports'), async (req, res) => {
  try {
    const data = await getSalaryRegister(reportParams(req));
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="salary_register.csv"');
      return res.send(toCsv(data, SALARY_REGISTER_FIELDS));
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/reports/lop
router.get('/reports/lop', auth, hasPermission('payroll', 'run_reports'), async (req, res) => {
  try {
    const data = await getLopReport(reportParams(req));
    if (req.query.format === 'csv') {
      const fields = [
        { key: 'employee_id', label: 'Emp ID' }, { key: 'employee_name', label: 'Name' },
        { key: 'department' }, { key: 'month' }, { key: 'year' },
        { key: 'working_days', label: 'Working Days' }, { key: 'present_days', label: 'Present' },
        { key: 'absent_days', label: 'Absent' }, { key: 'leave_days', label: 'Leave' },
        { key: 'lop_days', label: 'LOP Days' }, { key: 'lop_amount', label: 'LOP Amount' },
        { key: 'gross_salary', label: 'Gross' }, { key: 'net_salary', label: 'Net' },
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="lop_report.csv"');
      return res.send(toCsv(data, fields));
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payroll/reports/adjustments
router.get('/reports/adjustments', auth, hasPermission('payroll', 'run_reports'), async (req, res) => {
  try {
    const data = await getAdjustmentSummary(reportParams(req));
    if (req.query.format === 'csv') {
      const fields = [
        { key: 'adjustment_category', label: 'Category' },
        { key: 'addition_or_deduction', label: 'Type' },
        { key: 'count' }, { key: 'total_amount', label: 'Total Amount' },
        { key: 'departments' },
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="adjustment_report.csv"');
      return res.send(toCsv(data, fields));
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3.6F — BANK TRANSFER FILES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/payroll/bank-file/:runId?format=generic|hdfc|icici|sbi|axis
router.get('/bank-file/:runId', auth, hasPermission('payroll', 'bank_files'), async (req, res) => {
  try {
    const oId   = orgId(req);
    const runId = parseInt(req.params.runId, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run ID' });

    const format = req.query.format || 'generic';
    const result = await generateBankFile({ organizationId: oId, runId, format });

    logPayroll({ oId, actorId: req.user.id, actorName: req.user.name,
      action: 'bank_file_generated', entityType: 'payroll_run', entityId: runId,
      newValues: { format, rowCount: result.rowCount, totalAmount: result.totalAmount },
      ip: req.ip,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// GET /api/payroll/bank-file/formats — list supported formats
router.get('/bank-file/formats', auth, hasPermission('payroll', 'bank_files'), (req, res) => {
  res.json({ formats: SUPPORTED_FORMATS });
});

module.exports = router;
