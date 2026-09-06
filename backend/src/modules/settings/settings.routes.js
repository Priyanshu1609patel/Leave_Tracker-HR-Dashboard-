const express = require('express');
const router  = express.Router();
const { db } = require('../../config/db');
const { pool }     = require('../../config/db');
const { auth } = require('../../middleware/auth');
const { hasPermission } = require('../../middleware/permissions');
const { orgId } = require('../../utils/helpers');

function isRootAdmin(role) { return role === 'root_admin'; }

// ─── Settings: Get Work Schedule ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { data: schedule } = await db.from('work_schedule').select('*').eq('organization_id', orgId(req)).limit(1).maybeSingle();
    res.json({ schedule: schedule || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Update Work Schedule ──────────────────────────────────────────
router.put('/', auth, hasPermission('settings', 'manage'), async (req, res) => {
  try {
    const { start_time, end_time, late_threshold, early_exit_threshold, half_day_hours, work_days, full_day_hours, max_early_leave_count } = req.body;
    // Try to update existing; insert if none
    const { data: existing } = await db.from('work_schedule').select('id').eq('organization_id', orgId(req)).limit(1).maybeSingle();
    const fields = { start_time, end_time, late_threshold, early_exit_threshold, half_day_hours, work_days, full_day_hours, max_early_leave_count };
    let data, err;
    if (existing) {
      const res2 = await db.from('work_schedule')
        .update(fields)
        .eq('id', existing.id).select().single();
      data = res2.data; err = res2.error;
    } else {
      const res2 = await db.from('work_schedule')
        .insert({ ...fields, organization_id: orgId(req) }).select().single();
      data = res2.data; err = res2.error;
    }
    if (err) throw new Error(err.message);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Shift-specific config — GET ───────────────────────────────────
// Returns shift's own work schedule + attendance rules, falling back to org defaults for null fields.
router.get('/shift/:shiftId', auth, async (req, res) => {
  try {
    const oId     = orgId(req);
    const shiftId = parseInt(req.params.shiftId, 10);
    if (!shiftId) return res.status(400).json({ error: 'Invalid shiftId' });

    const [{ data: shift }, { data: orgSchedule }] = await Promise.all([
      db.from('shifts')
        .select('id, name, start_time, end_time, days_of_week, late_threshold, early_exit_threshold, half_day_hours, full_day_hours, max_early_leave_count')
        .eq('id', shiftId)
        .eq('organization_id', oId)
        .maybeSingle(),
      db.from('work_schedule')
        .select('*')
        .eq('organization_id', oId)
        .maybeSingle(),
    ]);

    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    const config = {
      shift_id:              shift.id,
      shift_name:            shift.name,
      // Work Schedule (always set on the shift)
      start_time:            shift.start_time,
      end_time:              shift.end_time,
      work_days:             shift.days_of_week || orgSchedule?.work_days || '1,2,3,4,5',
      // Attendance Rules — shift-specific overrides; null = org default
      late_threshold:        shift.late_threshold        ?? orgSchedule?.late_threshold        ?? null,
      early_exit_threshold:  shift.early_exit_threshold  ?? orgSchedule?.early_exit_threshold  ?? null,
      half_day_hours:        shift.half_day_hours        != null ? Number(shift.half_day_hours)        : (orgSchedule?.half_day_hours        != null ? Number(orgSchedule.half_day_hours)        : null),
      full_day_hours:        shift.full_day_hours        != null ? Number(shift.full_day_hours)        : (orgSchedule?.full_day_hours        != null ? Number(orgSchedule.full_day_hours)        : null),
      max_early_leave_count: shift.max_early_leave_count != null ? Number(shift.max_early_leave_count) : (orgSchedule?.max_early_leave_count != null ? Number(orgSchedule.max_early_leave_count) : null),
      // Flags for UI
      has_shift_override: shift.late_threshold !== null || shift.half_day_hours !== null,
    };

    res.json({ config });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Shift-specific config — PUT ───────────────────────────────────
// Saves work schedule + attendance rules directly onto the shift row.
// Only updates the fields that are supplied (partial updates allowed).
router.put('/shift/:shiftId', auth, hasPermission('settings', 'manage'), async (req, res) => {
  try {
    const oId     = orgId(req);
    const shiftId = parseInt(req.params.shiftId, 10);
    if (!shiftId) return res.status(400).json({ error: 'Invalid shiftId' });

    const { data: shift } = await db.from('shifts')
      .select('id').eq('id', shiftId).eq('organization_id', oId).maybeSingle();
    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    const {
      start_time, end_time, work_days,
      late_threshold, early_exit_threshold,
      half_day_hours, full_day_hours, max_early_leave_count,
    } = req.body;

    const updates = {};
    if (start_time !== undefined)            updates.start_time            = start_time;
    if (end_time !== undefined)              updates.end_time              = end_time;
    if (work_days !== undefined)             updates.days_of_week          = work_days;
    if (late_threshold !== undefined)        updates.late_threshold        = late_threshold;
    if (early_exit_threshold !== undefined)  updates.early_exit_threshold  = early_exit_threshold;
    if (half_day_hours !== undefined)        updates.half_day_hours        = half_day_hours !== null ? parseFloat(half_day_hours) : null;
    if (full_day_hours !== undefined)        updates.full_day_hours        = full_day_hours !== null ? parseFloat(full_day_hours) : null;
    if (max_early_leave_count !== undefined) updates.max_early_leave_count = max_early_leave_count !== null ? parseInt(max_early_leave_count, 10) : null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    const { data, error } = await db.from('shifts')
      .update(updates)
      .eq('id', shiftId)
      .eq('organization_id', oId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);

    // Auto-reprocess last 90 days of biometric attendance for this shift
    // when hours thresholds change — fire-and-forget, does not block response.
    const newFull = updates.full_day_hours;
    const newHalf = updates.half_day_hours;
    if (newFull != null || newHalf != null) {
      setImmediate(async () => {
        try {
          // Fetch final effective thresholds (use saved row values as source of truth)
          const { rows: [saved] } = await pool.query(
            `SELECT full_day_hours, half_day_hours FROM shifts WHERE id = $1`, [shiftId]
          );
          const fullHrs = parseFloat(saved.full_day_hours ?? 8);
          const halfHrs = parseFloat(saved.half_day_hours ?? 4.5);

          const { rowCount } = await pool.query(
            `UPDATE attendance a
             SET status = CASE
               WHEN a.work_hours >= $1 THEN 'present'
               WHEN a.work_hours >= $2 THEN 'early_leave'
               ELSE 'half_day'
             END
             FROM shift_assignments sa
             WHERE a.user_id        = sa.user_id
               AND a.date           = sa.date
               AND sa.shift_id      = $3
               AND a.organization_id = $4
               AND a.source         = 'biometric'
               AND a.date          >= CURRENT_DATE - INTERVAL '90 days'
               AND a.work_hours    IS NOT NULL
               AND a.status NOT IN ('on_leave', 'wfh', 'half_day_leave')`,
            [fullHrs, halfHrs, shiftId, oId]
          );
          console.log(`[settings] shift ${shiftId} threshold change → reprocessed ${rowCount} attendance rows`);
        } catch (e) {
          console.error('[settings] attendance reprocess after shift save failed:', e.message);
        }
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Email Automation — GET ────────────────────────────────────────
router.get('/email-automation', auth, async (req, res) => {
  if (!isRootAdmin(req.user.role)) return res.status(403).json({ error: 'Root admin only' });
  try {
    const oId = orgId(req);
    const result = await pool.query(
      `SELECT * FROM attendance_email_settings WHERE organization_id = $1 LIMIT 1`,
      [oId]
    );
    res.json(result.rows[0] || {
      late_email_enabled: false,
      daily_summary_enabled: false,
      daily_summary_time: '18:30',
      appreciation_email_enabled: false,
      appreciation_threshold_hours: 8,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Email Automation — PUT ────────────────────────────────────────
router.put('/email-automation', auth, async (req, res) => {
  if (!isRootAdmin(req.user.role)) return res.status(403).json({ error: 'Root admin only' });
  try {
    const oId = orgId(req);
    const {
      late_email_enabled,
      daily_summary_enabled,
      daily_summary_time,
      appreciation_email_enabled,
      appreciation_threshold_hours,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO attendance_email_settings
         (organization_id, late_email_enabled, daily_summary_enabled, daily_summary_time,
          appreciation_email_enabled, appreciation_threshold_hours, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         late_email_enabled           = EXCLUDED.late_email_enabled,
         daily_summary_enabled        = EXCLUDED.daily_summary_enabled,
         daily_summary_time           = EXCLUDED.daily_summary_time,
         appreciation_email_enabled   = EXCLUDED.appreciation_email_enabled,
         appreciation_threshold_hours = EXCLUDED.appreciation_threshold_hours,
         updated_at                   = NOW()
       RETURNING *`,
      [oId, !!late_email_enabled, !!daily_summary_enabled,
       daily_summary_time || '18:30',
       !!appreciation_email_enabled,
       parseFloat(appreciation_threshold_hours) || 8]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Biometric Config ───────────────────────────────────────────────
router.get('/biometric-config', auth, hasPermission('biometric', 'view'), (req, res) => {
  const ip   = process.env.BIOMETRIC_SERVER_IP   || '';
  const port = process.env.BIOMETRIC_SERVER_PORT  || '8080';
  res.json({
    server_ip:   ip,
    server_port: port,
    adms_url:    ip ? `http://${ip}:${port}/iclock` : '',
  });
});

module.exports = router;
