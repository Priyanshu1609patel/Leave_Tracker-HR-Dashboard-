/**
 * leaveWorkflowEngine.js
 *
 * Dynamic multi-level leave approval workflow engine.
 * Uses pool.query (raw SQL) throughout — the pg-adapter's nested select
 * syntax does NOT support parent-child table joins.
 *
 * Supported approver types:
 *   reporting_manager  — resolved from users.reporting_to
 *   department_head    — resolved from departments.head_user_id (employee's primary dept)
 *   hr_admin           — any user with role 'admin' or 'root_admin'
 *   root_admin         — any user with role 'root_admin'
 *   specific_user      — fixed user_id stored in level.role_reference
 */

const { pool } = require('../config/db');

// ── Default workflow created for every new organisation ───────────────────────
const DEFAULT_WORKFLOW_LEVELS = [
  { level_number: 1, role_type: 'hr_admin',   level_label: 'HR Admin',   is_required: true },
  { level_number: 2, role_type: 'root_admin', level_label: 'Root Admin', is_required: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// getOrgWorkflow
// Returns active workflow with sorted levels.
// If none exists, auto-creates the default 2-level workflow.
// ─────────────────────────────────────────────────────────────────────────────
async function getOrgWorkflow(oId) {
  // 1. Find active workflow for org
  const wfRes = await pool.query(
    `SELECT id, workflow_name, organization_id
     FROM leave_workflows
     WHERE organization_id = $1 AND active = TRUE
     LIMIT 1`,
    [oId]
  );

  let workflow = wfRes.rows[0] || null;

  if (!workflow) {
    // Auto-create default workflow
    const ins = await pool.query(
      `INSERT INTO leave_workflows (organization_id, workflow_name, active)
       VALUES ($1, $2, TRUE)
       RETURNING id, workflow_name, organization_id`,
      [oId, 'Default Approval Workflow']
    );
    workflow = ins.rows[0];

    // Insert default levels
    for (const l of DEFAULT_WORKFLOW_LEVELS) {
      await pool.query(
        `INSERT INTO leave_workflow_levels
           (workflow_id, level_number, role_type, level_label, is_required)
         VALUES ($1, $2, $3, $4, $5)`,
        [workflow.id, l.level_number, l.role_type, l.level_label, l.is_required]
      );
    }
  }

  // 2. Fetch levels for this workflow
  const lvlRes = await pool.query(
    `SELECT id, level_number, role_type, role_reference, level_label, is_required
     FROM leave_workflow_levels
     WHERE workflow_id = $1
     ORDER BY level_number ASC`,
    [workflow.id]
  );

  return {
    id:             workflow.id,
    workflow_name:  workflow.workflow_name,
    organization_id: oId,
    levels: lvlRes.rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveApprover
// Returns { userId: number|null, label: string }
// userId = null means "any user with the required role" (hr_admin, root_admin)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveApprover(level, employeeId, oId) {
  const label = level.level_label || level.role_type.replace(/_/g, ' ');

  switch (level.role_type) {
    case 'reporting_manager': {
      const r = await pool.query(
        `SELECT reporting_to FROM users WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [employeeId, oId]
      );
      const uid = r.rows[0]?.reporting_to;
      if (!uid || uid === employeeId) return { userId: null, label };
      return { userId: uid, label };
    }

    case 'department_head': {
      // Try junction table first (primary), then fall back to users.department string
      const junctR = await pool.query(
        `SELECT ud.department_id FROM user_departments ud
         WHERE ud.user_id = $1 AND ud.organization_id = $2
         ORDER BY ud.created_at ASC LIMIT 1`,
        [employeeId, oId]
      );
      let deptId = junctR.rows[0]?.department_id;

      // Fallback: look up via users.department string name
      if (!deptId) {
        const nameR = await pool.query(
          `SELECT d.id FROM users u
           JOIN departments d ON d.name = u.department AND d.organization_id = u.organization_id
           WHERE u.id = $1 AND u.organization_id = $2 LIMIT 1`,
          [employeeId, oId]
        );
        deptId = nameR.rows[0]?.id;
      }

      if (!deptId) return { userId: null, label };
      const deptR = await pool.query(
        `SELECT head_user_id FROM departments WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [deptId, oId]
      );
      const uid = deptR.rows[0]?.head_user_id;
      if (!uid || uid === employeeId) return { userId: null, label };
      return { userId: uid, label };
    }

    // Role-based: any user with that role can approve — no specific userId stored
    case 'hr_admin':
    case 'root_admin':
      return { userId: null, label };

    case 'specific_user': {
      const uid = level.role_reference ? parseInt(level.role_reference, 10) : null;
      return { userId: uid || null, label };
    }

    default:
      return { userId: null, label };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// canUserApproveLevel — pure function, no DB calls
// ─────────────────────────────────────────────────────────────────────────────
function canUserApproveLevel(level, userId, userRole, currentApproverId) {
  switch (level.role_type) {
    case 'reporting_manager':
    case 'department_head':
    case 'specific_user':
      return currentApproverId !== null && currentApproverId === userId;
    case 'hr_admin':
      return ['admin', 'root_admin'].includes(userRole);
    case 'root_admin':
      return userRole === 'root_admin';
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkCanApprove
// Returns { can: boolean, level: object|null }
// ─────────────────────────────────────────────────────────────────────────────
async function checkCanApprove(leave, userId, userRole) {
  if (!leave.workflow_id || leave.status !== 'pending_approval') {
    return { can: false, level: null };
  }

  const workflow = await getOrgWorkflow(leave.organization_id);
  // Coerce to number — Supabase JS client may return level_number as string
  const currentLevelNum = Number(leave.current_level);
  const currentLevel = workflow.levels.find(l => Number(l.level_number) === currentLevelNum);

  // If the workflow was updated after leave submission, current_level may not
  // match any level — allow any admin as a fallback so the leave doesn't get stuck.
  if (!currentLevel) {
    const isAdmin = ['admin', 'root_admin'].includes(userRole);
    return { can: isAdmin, level: null };
  }

  const can = canUserApproveLevel(currentLevel, userId, userRole, leave.current_approver_id);
  return { can, level: currentLevel };
}

// ─────────────────────────────────────────────────────────────────────────────
// initWorkflow
// Called when employee submits a leave.
// Returns { status, workflow_id, current_level, current_approver_id }
// ─────────────────────────────────────────────────────────────────────────────
async function initWorkflow(employeeId, oId) {
  const workflow = await getOrgWorkflow(oId);
  const levels = workflow.levels;

  if (!levels.length) {
    return { status: 'pending_approval', workflow_id: workflow.id, current_level: null, current_approver_id: null };
  }

  for (const level of levels) {
    const { userId } = await resolveApprover(level, employeeId, oId);
    const isResolvable = userId !== null || ['hr_admin', 'root_admin'].includes(level.role_type);

    // Skip optional levels with no resolvable approver
    if (!isResolvable && !level.is_required) continue;

    return {
      status:              'pending_approval',
      workflow_id:         workflow.id,
      current_level:       level.level_number,
      current_approver_id: userId,
    };
  }

  // All levels were skippable — use first required or first level
  const fallback = levels.find(l => l.is_required) || levels[0];
  const { userId } = await resolveApprover(fallback, employeeId, oId);
  return {
    status:              'pending_approval',
    workflow_id:         workflow.id,
    current_level:       fallback.level_number,
    current_approver_id: userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// findNextLevel
// Returns { level, approverId } for the next approver after `afterLevelNum`,
// skipping optional levels with no approver. Returns null if no more levels.
// ─────────────────────────────────────────────────────────────────────────────
async function findNextLevel(workflow, afterLevelNum, employeeId, oId) {
  const after = Number(afterLevelNum);
  const remaining = workflow.levels
    .filter(l => Number(l.level_number) > after)
    .sort((a, b) => Number(a.level_number) - Number(b.level_number));

  for (const level of remaining) {
    const { userId } = await resolveApprover(level, employeeId, oId);
    const isResolvable = userId !== null || ['hr_admin', 'root_admin'].includes(level.role_type);

    if (!isResolvable && !level.is_required) continue; // skip optional with no approver

    return { level, approverId: userId };
  }

  return null; // no more levels → final approval
}

// ─────────────────────────────────────────────────────────────────────────────
// getMyPendingLeaves
// Returns leaves pending THIS user's action in the new workflow.
// ─────────────────────────────────────────────────────────────────────────────
async function getMyPendingLeaves(userId, userRole, oId) {
  const { rows } = await pool.query(
    `SELECT
       l.*,
       u.name, u.email, u.department, u.avatar_color, u.position,
       wl.role_type   AS current_level_role_type,
       wl.level_label AS current_level_label
     FROM leaves l
     JOIN users u ON u.id = l.user_id
     LEFT JOIN leave_workflow_levels wl
       ON wl.workflow_id = l.workflow_id AND wl.level_number = l.current_level
     WHERE l.organization_id = $1
       AND l.status = 'pending_approval'
       AND l.workflow_id IS NOT NULL
       AND l.deleted_at IS NULL
       AND (
         (wl.role_type IN ('reporting_manager','department_head','specific_user')
          AND l.current_approver_id = $2)
         OR
         (wl.role_type = 'hr_admin' AND $3 = ANY(ARRAY['admin','root_admin']))
         OR
         (wl.role_type = 'root_admin' AND $3 = 'root_admin')
       )
     ORDER BY l.created_at ASC`,
    [oId, userId, userRole]
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// updateWorkflow
// Replace all levels for the org's active workflow.
// ─────────────────────────────────────────────────────────────────────────────
async function updateWorkflow(oId, workflowName, newLevels) {
  const workflow = await getOrgWorkflow(oId);

  // Update name + timestamp
  await pool.query(
    `UPDATE leave_workflows SET workflow_name = $1, updated_at = NOW() WHERE id = $2`,
    [workflowName || workflow.workflow_name, workflow.id]
  );

  // Delete existing levels
  await pool.query(`DELETE FROM leave_workflow_levels WHERE workflow_id = $1`, [workflow.id]);

  // Insert new levels
  for (const l of newLevels) {
    await pool.query(
      `INSERT INTO leave_workflow_levels
         (workflow_id, level_number, role_type, role_reference, level_label, is_required)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        workflow.id,
        l.level_number,
        l.role_type,
        l.role_reference || null,
        l.level_label    || null,
        l.is_required    !== false,
      ]
    );
  }

  // Reset any pending leaves to the new workflow's first level.
  // When level numbers are replaced, a leave whose current_level mapped to
  // e.g. 'hr_admin' may now map to 'root_admin', blocking the original approver.
  // Resetting to level 1 lets the new workflow re-evaluate from the start.
  if (newLevels.length > 0) {
    const firstLevel = [...newLevels].sort((a, b) => a.level_number - b.level_number)[0];
    // For role-based levels (hr_admin, root_admin) current_approver_id is not used
    // by canUserApproveLevel, so NULL is correct. Person-based levels (reporting_manager,
    // department_head) store a specific user — those will need re-initiation, but
    // setting NULL causes the BUG_169 admin fallback to take over, keeping them unblocked.
    await pool.query(
      `UPDATE leaves
          SET current_level       = $1,
              current_approver_id = CASE
                WHEN $2 IN ('hr_admin','root_admin') THEN NULL
                ELSE current_approver_id
              END
        WHERE organization_id = $3
          AND workflow_id     = $4
          AND status          = 'pending_approval'`,
      [firstLevel.level_number, firstLevel.role_type, oId, workflow.id]
    );
  }

  return getOrgWorkflow(oId);
}

module.exports = {
  getOrgWorkflow,
  resolveApprover,
  canUserApproveLevel,
  checkCanApprove,
  initWorkflow,
  findNextLevel,
  getMyPendingLeaves,
  updateWorkflow,
};
