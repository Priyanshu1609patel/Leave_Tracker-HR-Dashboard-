import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Calendar, Edit, Trash2, CheckCircle, X, Home, CheckCircle2, Inbox, AlertTriangle, RotateCcw, Users, ChevronUp, ChevronDown } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';
import { Avatar } from '@/components/ui/Avatar';
import { StatusBadge, LeaveTypeBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { fmtDate, fmtDateRange, fmtTime, fmtHours, initials, todayStr, cn, countWorkingDaysInRange } from '@/lib/utils';


// BUG_069: Added 'emergency' and 'comp_off' which were missing from the filter dropdown
const LEAVE_TYPES = ['casual','sick','annual','emergency','comp_off','maternity','paternity','bereavement','unpaid'];

const ATT_STATUS_CFG = {
  present:  { label: 'Present',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  wfh:      { label: 'WFH',      cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  half_day: { label: 'Half Day', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  on_leave: { label: 'On Leave', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  absent:   { label: 'Absent',   cls: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export default function Leaves() {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam    = searchParams.get('tab');
  const dateParam   = searchParams.get('date');
  const statusParam = searchParams.get('status');
  const typeParam   = searchParams.get('type');
  const userIdParam = searchParams.get('userId');

  // Initialise tab from URL param; fall back to role-based default
  const [tab, setTab] = useState(() => {
    if (statusParam === 'pending') {
      // Respect explicit tabParam even when filtering by pending status
      if (tabParam === 'wfh') return 'wfh';
      return 'all';
    }
    if (tabParam === 'all' || tabParam === 'wfh') return tabParam;
    if (tabParam === 'mine' && !isAdmin) return 'mine';
    return isAdmin ? 'all' : 'mine';
  });

  // Initialise date filter from URL param ('today' resolves to today's date string)
  const [filterStart, setFilterStart] = useState(() => {
    if (dateParam === 'today') return todayStr();
    return dateParam || '';
  });
  const [filterEnd,    setFilterEnd]    = useState('');
  const [filterMonth,  setFilterMonth]  = useState('');
  const [filterType,   setFilterType]   = useState(() => typeParam || '');
  const [applyModal, setApplyModal] = useState(false);
  const [editLeave,  setEditLeave]  = useState(null);
  const [confirmDel,    setConfirmDel]    = useState(null);
  const [confirmRevert, setConfirmRevert] = useState(null);

  const { data: leaves = [], refetch: refetchLeaves } = useQuery({
    queryKey: ['leaves', userIdParam],
    queryFn: () => apiGet('/leaves', userIdParam ? { userId: userIdParam } : {}),
  });

  const { data: policies = [] } = useQuery({
    queryKey: ['leave-policies'],
    queryFn: () => apiGet('/leave-policies'),
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees-list'],
    queryFn: async () => {
      const all = await apiGet('/employees');
      return all.filter(e => e.role === 'employee');
    },
  });

  const myLeaves      = leaves.filter(l => l.user_id === user?.id);
  const allLeaves     = isAdmin ? leaves : myLeaves;
  const summaryLeaves = isAdmin ? allLeaves : myLeaves;

  async function approve(id) {
    try { await apiPut(`/leaves/${id}/approve`, {}); toast('Leave approved', 'success'); refetchLeaves(); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function reject(id) {
    try { await apiPut(`/leaves/${id}/reject`, {}); toast('Leave rejected', 'warning'); refetchLeaves(); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function revert(id) {
    try { await apiPut(`/leaves/${id}/revert`, {}); toast('Leave reverted', 'info'); refetchLeaves(); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function cancel(id) {
    try { await apiDelete(`/leaves/${id}`); toast('Leave cancelled', 'info'); refetchLeaves(); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function deleteLeave(id) {
    try { await apiDelete(`/leaves/${id}`); toast('Leave deleted', 'success'); refetchLeaves(); }
    catch (err) { toast(err.message, 'error'); }
  }

  const activeList = (() => {
    if (tab === 'summary') return [];
    let src = tab === 'all' ? allLeaves : (tab === 'wfh' ? allLeaves : myLeaves);
    const hasRange = filterStart || filterEnd;
    const s = filterStart || '0000-01-01';
    const e = filterEnd   || '9999-12-31';
    if (tab === 'wfh') {
      src = src.filter(l => l.leave_time === 'wfh' || l.leave_type === 'wfh');
      if (hasRange) src = src.filter(l => l.start_date <= e && l.end_date >= s);
      return src;
    }
    src = src.filter(l => l.leave_time !== 'wfh' && l.leave_type !== 'wfh');
    if (filterType) src = src.filter(l => l.leave_type === filterType);
    if (hasRange) src = src.filter(l => l.start_date <= e && l.end_date >= s);
    return src;
  })();

  const PENDING_STATUSES = ['pending', 'pending_dept', 'pending_root', 'pending_approval'];
  const pendingCount    = allLeaves.filter(l => PENDING_STATUSES.includes(l.status) && l.leave_time !== 'wfh' && l.leave_type !== 'wfh').length;
  const wfhPendingCount = allLeaves.filter(l => PENDING_STATUSES.includes(l.status) && (l.leave_time === 'wfh' || l.leave_type === 'wfh')).length;

  // When navigated with a status param, filter accordingly
  const pendingOnly    = statusParam === 'pending';
  const approvedOnly   = statusParam === 'approved';
  const displayList    = pendingOnly  ? activeList.filter(l => PENDING_STATUSES.includes(l.status))
                       : approvedOnly ? activeList.filter(l => l.status === 'approved')
                       : activeList;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Leave Management</div>
          <div className="page-subtitle">Track and manage employee leaves</div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => setApplyModal(true)}>
            <Plus size={14} /> {isAdmin ? 'Add Employee Leave' : 'Apply Leave'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        <div>
          {/* Active filter badges */}
          {(pendingOnly || filterType || userIdParam) && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {userIdParam && (
                <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                  <Users size={11} />
                  Filtered by employee
                  <X size={11} className="cursor-pointer ml-0.5" onClick={() => setSearchParams(p => { const n = new URLSearchParams(p); n.delete('userId'); return n; }, { replace: true })} />
                </span>
              )}
              {pendingOnly && (
                <span className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                  <AlertTriangle size={11} /> Pending approvals only
                </span>
              )}
              {filterType && (
                <span className="text-xs font-bold text-[#3525cd] bg-[#f0f3ff] border border-[#c7c4d8] px-2.5 py-1 rounded-full flex items-center gap-1.5 capitalize">
                  <X size={11} className="cursor-pointer" onClick={() => setFilterType('')} />
                  {filterType} leave
                </span>
              )}
              {pendingOnly && (
                <button className="text-xs text-[#3525cd] hover:underline font-semibold"
                  onClick={() => setSearchParams(p => { const n = new URLSearchParams(p); n.delete('status'); return n; }, { replace: true })}>
                  Clear filter
                </button>
              )}
            </div>
          )}

          {/* Date range filter */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <label className="text-xs font-semibold text-[#777587] flex items-center gap-1 shrink-0"><Calendar size={12} />Filter:</label>
            <select className="form-control w-auto py-1.5 px-3 text-xs" value={filterType}
              onChange={e => setFilterType(e.target.value)}>
              <option value="">All Types</option>
              {LEAVE_TYPES.map(t => <option key={t} value={t} className="capitalize">{t === 'comp_off' ? 'Comp Off' : t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
            <input type="date" className="form-control w-auto py-1.5 px-3 text-xs" value={filterStart}
              onChange={e => { setFilterStart(e.target.value); setFilterMonth(''); }} />
            <span className="text-xs text-[#777587]">to</span>
            <input type="date" className="form-control w-auto py-1.5 px-3 text-xs" value={filterEnd}
              onChange={e => { setFilterEnd(e.target.value); setFilterMonth(''); }} />
            <span className="text-xs text-[#9ca3af] font-medium">or month:</span>
            <input type="month" className="form-control w-auto py-1.5 px-3 text-xs" value={filterMonth}
              onChange={e => {
                const m = e.target.value;
                setFilterMonth(m);
                if (m) {
                  const [yr, mo] = m.split('-').map(Number);
                  const first = `${yr}-${String(mo).padStart(2, '0')}-01`;
                  const last  = `${yr}-${String(mo).padStart(2, '0')}-${String(new Date(yr, mo, 0).getDate()).padStart(2, '0')}`;
                  setFilterStart(first);
                  setFilterEnd(last);
                } else {
                  setFilterStart('');
                  setFilterEnd('');
                }
              }} />
            {(filterStart || filterEnd || filterType) && (
              <button className="btn btn-ghost btn-sm text-xs" onClick={() => { setFilterStart(''); setFilterEnd(''); setFilterMonth(''); setFilterType(''); }}>
                <X size={12} /> Clear
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-[#f0f3ff] border border-[#c7c4d8] p-1 rounded-xl mb-4">
            {isAdmin && (
              <TabBtn active={tab === 'all'} onClick={() => setTab('all')}>
                All Leaves {pendingCount > 0 && <span className="ml-1 bg-rose-500 text-white text-[0.6rem] font-black px-1.5 py-0.5 rounded-full">{pendingCount}</span>}
              </TabBtn>
            )}
            {!isAdmin && <TabBtn active={tab === 'mine'} onClick={() => setTab('mine')}>My Leaves</TabBtn>}
            <TabBtn active={tab === 'wfh'}  onClick={() => setTab('wfh')}><Home size={13} /> WFH {wfhPendingCount > 0 && <span className="ml-1 bg-rose-500 text-white text-[0.6rem] font-black px-1.5 py-0.5 rounded-full">{wfhPendingCount}</span>}</TabBtn>
            {isAdmin && <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}><Users size={13} /> Summary</TabBtn>}
          </div>

          {/* List / Summary */}
          {tab === 'summary' ? (
            <LeaveSummaryTable
              employees={employees}
              leaves={leaves}
              policies={policies}
              filterStart={filterStart}
              filterEnd={filterEnd}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {displayList.length === 0
                ? <div className="empty-state"><Inbox size={36} className="mx-auto mb-2 opacity-30" /><p>{pendingOnly ? 'No pending approvals' : 'No leave records'}</p></div>
                : displayList.map(l => (
                    <LeaveCard key={l.id} leave={l} isAdmin={isAdmin} user={user}
                      onApprove={approve} onReject={reject} onRevert={(id) => setConfirmRevert(id)} onCancel={cancel}
                      onEdit={() => setEditLeave(l)}
                      onDelete={() => setConfirmDel({ id: l.id, name: l.name })} />
                  ))
              }
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4 self-start">
          {/* Leave Quotas */}
          <div className="card">
            <div className="px-5 py-4 border-b border-[#f0f3ff] font-black text-[#151c27] text-sm">Leave Quotas</div>
            <div className="p-5 space-y-0">
              {policies.length === 0
                ? <p className="text-xs text-[#9ca3af] text-center py-4">No leave policies configured</p>
                : policies.filter(p => p.active).map(p => (
                  <div key={p.leave_type} className="flex items-center justify-between py-2.5 border-b border-[#f0f3ff] last:border-0">
                    <LeaveTypeBadge type={p.leave_type} />
                    <span className="text-xs font-semibold text-[#464555]">
                      {p.annual_quota > 0 ? `${p.annual_quota} days / yr` : '—'}
                    </span>
                  </div>
                ))
              }
            </div>
          </div>

          {/* Upcoming Leaves */}
          <div className="card">
            <div className="px-5 py-4 border-b border-[#f0f3ff] font-black text-[#151c27] text-sm flex items-center gap-2">
              <Calendar size={14} className="text-[#3525cd]" /> Upcoming Leaves
            </div>
            <div className="divide-y divide-[#f0f3ff]">
              {(() => {
                const today = todayStr();
                const upcoming = allLeaves
                  .filter(l => l.status === 'approved' && l.start_date >= today && l.leave_time !== 'wfh' && l.leave_type !== 'wfh')
                  .sort((a, b) => a.start_date.localeCompare(b.start_date))
                  .slice(0, 6);
                if (upcoming.length === 0) return (
                  <div className="py-6 text-center">
                    <CheckCircle size={22} className="text-emerald-400 mx-auto mb-1" />
                    <p className="text-xs text-[#777587]">No upcoming leaves</p>
                  </div>
                );
                return upcoming.map(l => (
                  <div key={l.id} className="px-4 py-3 flex items-center gap-3">
                    {isAdmin && <Avatar name={l.name} color={l.avatar_color} size={26} />}
                    <div className="flex-1 min-w-0">
                      {isAdmin && <p className="text-xs font-bold text-[#151c27] truncate">{l.name}</p>}
                      <p className="text-[0.65rem] text-[#777587]">{fmtDateRange(l.start_date, l.end_date)}</p>
                    </div>
                    <LeaveTypeBadge type={l.leave_type} />
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {applyModal && <ApplyLeaveModal employees={employees} isAdmin={isAdmin} allLeaves={allLeaves} policies={policies} onClose={() => setApplyModal(false)} onSuccess={refetchLeaves} />}
      {editLeave  && <EditLeaveModal  leave={editLeave} isAdmin={isAdmin} onClose={() => setEditLeave(null)} onSuccess={refetchLeaves} />}
      <ConfirmModal
        open={!!confirmRevert}
        title="Confirm Revert Leave"
        message="Are you sure you want to revert this leave request? The leave will be cancelled and attendance records for those days will be removed."
        confirmLabel="Revert"
        variant="warning"
        onConfirm={() => revert(confirmRevert)}
        onCancel={() => setConfirmRevert(null)}
      />
      <ConfirmModal
        open={!!confirmDel}
        title="Delete Leave Record"
        message={`Delete the leave record for ${confirmDel?.name || 'this employee'}? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteLeave(confirmDel.id)}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={cn('flex-1 py-2 px-3 rounded-lg text-xs font-bold transition-all duration-150 flex items-center justify-center gap-1',
      active ? 'bg-white text-[#3525cd] shadow-sm' : 'text-[#777587] hover:text-[#151c27]')}>
      {children}
    </button>
  );
}

// ── Leave Card ────────────────────────────────────────────────────────────────
const STATUS_CARD = {
  pending:          { border: 'border-l-4 border-l-amber-400',   bg: 'bg-amber-50/40' },
  pending_dept:     { border: 'border-l-4 border-l-blue-400',    bg: 'bg-blue-50/30' },
  pending_root:     { border: 'border-l-4 border-l-violet-400',  bg: 'bg-violet-50/30' },
  pending_approval: { border: 'border-l-4 border-l-blue-500',    bg: 'bg-blue-50/30' },
  approved:         { border: 'border-l-4 border-l-emerald-400', bg: '' },
  rejected:         { border: 'border-l-4 border-l-rose-400',    bg: '' },
  cancelled:        { border: 'border-l-4 border-l-slate-400',   bg: 'bg-slate-50/40' },
  withdrawn:        { border: 'border-l-4 border-l-slate-400',   bg: 'bg-slate-50/40' },
};

function LeaveCard({ leave: l, isAdmin, user, onApprove, onReject, onRevert, onCancel, onEdit, onDelete }) {
  const sc = STATUS_CARD[l.status] || {};
  const isRootAdmin = user?.role === 'root_admin';

  // For new-workflow leaves: can the current user approve at this stage?
  const canApproveNow = (() => {
    if (l.status !== 'pending_approval') return false;
    const rt = l.current_level_role_type;
    if (!rt) return isAdmin; // no enrichment yet — fall back to any admin
    if (rt === 'root_admin') return isRootAdmin;
    if (rt === 'hr_admin') return isAdmin; // admin OR root_admin
    // person-based (reporting_manager, department_head, specific_user)
    return Number(l.current_approver_id) === Number(user?.id);
  })();
  return (
    <div className={`card px-4 py-3.5 flex items-start gap-3.5 hover:border-[#3525cd] hover:shadow-card-hover hover:translate-x-0.5 transition-all duration-150 ${sc.border || ''} ${sc.bg || ''}`}>
      <Avatar name={l.name} color={l.avatar_color} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-black">{l.name}</span>
          {/* WFH is not a leave type — show WFH badge only, never the leave_type badge */}
          {(l.leave_time === 'wfh' || l.leave_type === 'wfh') ? (
            <span className="badge badge-wfh flex items-center gap-1"><Home size={10} /> WFH</span>
          ) : (
            <LeaveTypeBadge type={l.leave_type} />
          )}
          {l.leave_time === 'half' && (
            <span className="text-[0.7rem] font-semibold px-2 py-0.5 rounded-full bg-[#f0f3ff] text-[#3525cd]">
              {l.half_type === 'second_half' ? 'Second Half' : 'First Half'}
            </span>
          )}
          {l.leave_time === 'full' && l.leave_type !== 'wfh' && <span className="text-[0.7rem] font-semibold px-2 py-0.5 rounded-full bg-[#f0f3ff] text-[#464555]">Full Day</span>}
          <StatusBadge status={l.status} />
        </div>
        <div className="text-xs text-[#777587] mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="flex items-center gap-1"><Calendar size={11} /> {fmtDateRange(l.start_date, l.end_date)}</span>
          <span className="text-[0.68rem] font-bold px-2 py-0.5 rounded bg-[#f0f3ff] text-[#3525cd] border border-[#c7c4d8]">
            {l.leave_time === 'half' ? '0.5 Working Day' : `${countWorkingDaysInRange(l.start_date, l.end_date)} Working Days`}
          </span>
        </div>

        {l.reason && <div className="text-xs text-[#777587] italic mt-0.5">"{l.reason}"</div>}
        {l.approver_name && <div className="text-xs text-[#777587] mt-0.5">By: {l.approver_name}</div>}
        <div className="flex gap-2 mt-2.5 flex-wrap">
          {/* Old-flow pending — both HR Admin and Root Admin can approve */}
          {isAdmin && l.status === 'pending' && (
            <>
              <button className="btn btn-success btn-sm text-xs" onClick={() => onApprove(l.id)}><CheckCircle size={12} /> Approve</button>
              <button className="btn btn-danger btn-sm text-xs"  onClick={() => onReject(l.id)}><X size={12} /> Reject</button>
            </>
          )}
          {/* New workflow: pending_approval — show actions only when user can approve this level */}
          {isAdmin && l.status === 'pending_approval' && canApproveNow && (
            <>
              <button className="btn btn-success btn-sm text-xs" onClick={() => onApprove(l.id)}><CheckCircle size={12} /> Approve</button>
              <button className="btn btn-danger btn-sm text-xs"  onClick={() => onReject(l.id)}><X size={12} /> Reject</button>
            </>
          )}
          {isAdmin && l.status === 'pending_approval' && !canApproveNow && l.current_level_role_type === 'root_admin' && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-lg">
              Awaiting Root Admin Decision
            </span>
          )}
          {/* Legacy-flow: waiting for dept head — show info, no action for admins */}
          {isAdmin && l.status === 'pending_dept' && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-lg">
              Awaiting Dept Head Forwarding
            </span>
          )}
          {/* Legacy-flow: Root Admin final decision */}
          {isAdmin && l.status === 'pending_root' && isRootAdmin && (
            <>
              <button className="btn btn-success btn-sm text-xs" onClick={() => onApprove(l.id)}><CheckCircle size={12} /> Approve</button>
              <button className="btn btn-danger btn-sm text-xs"  onClick={() => onReject(l.id)}><X size={12} /> Reject</button>
            </>
          )}
          {isAdmin && l.status === 'pending_root' && !isRootAdmin && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-lg">
              Awaiting Root Admin Decision
            </span>
          )}
          {l.status === 'approved' && (isAdmin || l.user_id === user?.id) && (
            <button className="btn btn-outline btn-sm text-xs border-amber-300 text-amber-800 hover:bg-amber-50" onClick={() => onRevert(l.id)}>
              <RotateCcw size={12} /> Revert Leave
            </button>
          )}
          {['pending', 'pending_approval'].includes(l.status) && l.user_id === user?.id && (
            <button className="btn btn-outline btn-sm text-xs" onClick={() => onCancel(l.id)}><X size={12} /> Cancel</button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {(isAdmin || l.status !== 'approved') && (
          <button className="btn btn-outline btn-sm text-xs py-1 px-2" onClick={onEdit}><Edit size={12} /> Edit</button>
        )}
        {isAdmin && (
          <button className="btn btn-danger btn-sm text-xs py-1 px-2" onClick={onDelete}><Trash2 size={12} /></button>
        )}
      </div>
    </div>
  );
}

// ── Mini Calendar ─────────────────────────────────────────────────────────────
const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MiniCalendar({ value, onChange, holidays = [], minDate }) {
  const today = todayStr();

  // Derive initial month from value or today
  const [viewYear, setViewYear] = useState(() => {
    const ref = value || today;
    return parseInt(ref.slice(0, 4));
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const ref = value || today;
    return parseInt(ref.slice(5, 7));
  });

  // Build a Set of holiday date strings for O(1) lookup
  const holidayMap = React.useMemo(() => {
    const m = {};
    holidays.forEach(h => { m[h.date] = h.name; });
    return m;
  }, [holidays]);

  function prevMonth() {
    if (viewMonth === 1) { setViewYear(y => y - 1); setViewMonth(12); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 12) { setViewYear(y => y + 1); setViewMonth(1); }
    else setViewMonth(m => m + 1);
  }

  // Build calendar grid: array of date strings (YYYY-MM-DD) or null for padding
  const cells = React.useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth - 1, 1);
    // getDay(): 0=Sun,1=Mon,...,6=Sat. We want Mon=0 offset.
    const startOffset = (firstDay.getDay() + 6) % 7; // Mon-based offset
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
    const result = [];
    for (let i = 0; i < startOffset; i++) result.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const mm = String(viewMonth).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      result.push(`${viewYear}-${mm}-${dd}`);
    }
    // Pad to full weeks
    while (result.length % 7 !== 0) result.push(null);
    return result;
  }, [viewYear, viewMonth]);

  const monthLabel = new Date(viewYear, viewMonth - 1, 1)
    .toLocaleString('default', { month: 'long', year: 'numeric' });

  return (
    <div className="border border-[#c7c4d8] rounded-xl bg-white overflow-hidden" style={{ minWidth: 248 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#f0f3ff] border-b border-[#c7c4d8]">
        <button type="button" onClick={prevMonth}
          className="p-1 rounded hover:bg-[#e0e4ff] text-[#3525cd] font-black text-sm leading-none">&#8249;</button>
        <span className="text-xs font-black text-[#151c27]">{monthLabel}</span>
        <button type="button" onClick={nextMonth}
          className="p-1 rounded hover:bg-[#e0e4ff] text-[#3525cd] font-black text-sm leading-none">&#8250;</button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-[#f0f3ff]">
        {DAYS_OF_WEEK.map(d => (
          <div key={d} className="text-center py-1.5 text-[0.6rem] font-black text-[#777587] uppercase tracking-wide">
            {d}
          </div>
        ))}
      </div>

      {/* Date grid */}
      <div className="grid grid-cols-7">
        {cells.map((dateStr, idx) => {
          if (!dateStr) {
            return <div key={`pad-${idx}`} className="p-1.5" />;
          }
          const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun,6=Sat
          const isWeekend = dow === 0 || dow === 6;
          const isHoliday = !!holidayMap[dateStr];
          const holidayName = holidayMap[dateStr] || '';
          const isSelected = value === dateStr;
          const isToday = dateStr === today;
          const isDisabled = minDate && dateStr < minDate;

          let cellBg = '';
          let textColor = 'text-[#151c27]';
          if (isSelected) {
            cellBg = 'bg-[#3525cd]';
            textColor = 'text-white';
          } else if (isHoliday) {
            cellBg = 'bg-orange-50';
          } else if (isWeekend) {
            cellBg = 'bg-slate-50';
          }

          if (isDisabled) textColor = 'text-[#c7c4d8]';

          return (
            <div
              key={dateStr}
              title={isHoliday ? holidayName : undefined}
              onClick={() => { if (!isDisabled) onChange(dateStr); }}
              className={`relative flex flex-col items-center justify-center p-1 cursor-pointer transition-all duration-100
                ${cellBg} ${textColor}
                ${isDisabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-[#e8ecff] hover:text-[#3525cd]'}
                ${isSelected ? 'hover:bg-[#2415aa] hover:text-white rounded-lg' : 'rounded-lg'}
              `}
              style={{ minHeight: 34 }}
            >
              <span className={`text-[0.7rem] font-semibold leading-tight ${isToday && !isSelected ? 'underline decoration-[#3525cd] decoration-2 underline-offset-2' : ''}`}>
                {parseInt(dateStr.slice(8), 10)}
              </span>
              {isHoliday && !isSelected && (
                <span className="block w-1 h-1 rounded-full bg-orange-400 mt-0.5" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Apply Leave Modal ─────────────────────────────────────────────────────────
function SegBtn({ value, current, onChange, children }) {
  const active = value === current;
  return (
    <button type="button" onClick={() => onChange(value)}
      className={`flex-1 py-2 px-3 text-xs font-bold rounded-lg transition-all duration-150 ${
        active ? 'bg-[#3525cd] text-white shadow-sm' : 'text-[#777587] hover:text-[#151c27]'
      }`}>
      {children}
    </button>
  );
}

export function ApplyLeaveModal({ employees, isAdmin, allLeaves, policies, onClose, onSuccess }) {
  const toast = useToast();
  const blank = () => ({
    emp: '', request_type: 'leave',
    type: 'casual', time: 'full', half: 'first_half',
    start: '', end: '',
    wfh_date: '', wfh_time: 'full',
    reason: '',
  });
  const [forms, setForms] = useState([blank()]);

  // Fetch holidays for current year and next year
  const currentYear = new Date().getFullYear();
  const { data: holidaysThisYear = [] } = useQuery({
    queryKey: ['holidays', currentYear],
    queryFn: () => apiGet(`/holidays?year=${currentYear}`),
    staleTime: 1000 * 60 * 60, // 1 hour
  });
  const { data: holidaysNextYear = [] } = useQuery({
    queryKey: ['holidays', currentYear + 1],
    queryFn: () => apiGet(`/holidays?year=${currentYear + 1}`),
    staleTime: 1000 * 60 * 60,
  });
  const holidays = React.useMemo(() => [...holidaysThisYear, ...holidaysNextYear], [holidaysThisYear, holidaysNextYear]);

  // Build holiday set for range calculations
  const holidayDateSet = React.useMemo(() => new Set(holidays.map(h => h.date)), [holidays]);

  function update(i, k, v) { setForms(fs => fs.map((f, idx) => idx === i ? { ...f, [k]: v } : f)); }
  function add()    { setForms(fs => [...fs, blank()]); }
  function remove(i){ setForms(fs => fs.filter((_, idx) => idx !== i)); }

  function getEmpBalance(empId) {
    if (!empId || !isAdmin) return null;
    const empLeaves = (allLeaves || []).filter(l => String(l.user_id) === String(empId) && l.status === 'approved');
    const activePolicies = (policies || []).filter(p => p.active && p.annual_quota > 0);
    return activePolicies.map(p => {
      const used = empLeaves
        .filter(l => l.leave_type === p.leave_type && l.leave_time !== 'wfh' && l.leave_type !== 'wfh')
        .reduce((s, l) => s + (l.leave_time === 'half' ? 0.5 : countWorkingDaysInRange(l.start_date, l.end_date)), 0);
      const remaining = Math.max(0, p.annual_quota - used);
      return { type: p.leave_type, quota: p.annual_quota, used, remaining };
    }).filter(b => ['casual', 'sick', 'annual', 'emergency'].includes(b.type));
  }

  async function submit() {
    for (const [i, f] of forms.entries()) {
      if (isAdmin && !f.emp) { toast('Select an employee', 'warning'); return; }
      if (!f.reason.trim()) { toast(`Reason is required for request ${i + 1}`, 'warning'); return; }
      if (f.request_type === 'wfh') {
        if (!f.wfh_date) { toast(`Fill WFH date for request ${i + 1}`, 'warning'); return; }
      } else {
        if (!f.start || !f.end) { toast(`Fill start/end date for request ${i + 1}`, 'warning'); return; }
      }
    }
    try {
      await Promise.all(forms.map(f => {
        let body;
        if (f.request_type === 'wfh') {
          body = {
            leave_type: 'wfh',
            leave_time: f.wfh_time === 'half' ? 'half' : 'wfh',
            half_type:  f.wfh_time === 'half' ? f.half : null,
            start_date: f.wfh_date, end_date: f.wfh_date,
            reason: f.reason,
          };
        } else {
          body = {
            leave_type: f.type, start_date: f.start, end_date: f.end,
            reason: f.reason, leave_time: f.time,
            half_type: f.time === 'half' ? f.half : null,
          };
        }
        if (isAdmin && f.emp) body.user_id = parseInt(f.emp);
        return apiPost('/leaves', body);
      }));
      toast(`${forms.length} leave request${forms.length > 1 ? 's' : ''} submitted!`, 'success');
      onClose(); onSuccess();
    } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <Modal open onClose={onClose} title="Add Employee Leave" size="lg"
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Submit All</button></>}>
      {{
        body: (
          <>
            {forms.map((f, i) => (
              <div key={i} className="border border-[#c7c4d8] rounded-xl p-4 mb-3 bg-[#f0f3ff]/50">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold text-[#3525cd]">{i === 0 ? 'Request' : `Request #${i + 1}`}</span>
                  {i > 0 && <button className="btn btn-ghost btn-sm text-xs text-rose-400" onClick={() => remove(i)}><X size={12} /> Remove</button>}
                </div>

                {/* Employee selector */}
                {isAdmin && (
                  <div className="mb-3">
                    <label className="form-label">Employee <span className="text-rose-500">*</span></label>
                    <select className="form-control" value={f.emp} onChange={e => update(i, 'emp', e.target.value)}>
                      <option value="">Select employee…</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                    {f.emp && (() => {
                      const balance = getEmpBalance(f.emp);
                      if (!balance || balance.length === 0) return null;
                      return (
                        <div className="mt-2 p-3 rounded-xl bg-[#f0f3ff] border border-[#c7c4d8]">
                          <p className="text-[0.65rem] font-black text-[#3525cd] uppercase tracking-wider mb-2">Leave Balance</p>
                          <div className="flex flex-wrap gap-3">
                            {balance.map(b => (
                              <div key={b.type} className="text-xs">
                                <span className="capitalize text-[#464555] font-semibold">{b.type}: </span>
                                <span className={b.remaining === 0 ? 'text-rose-600 font-black' : b.remaining <= 2 ? 'text-amber-600 font-black' : 'text-emerald-600 font-black'}>{b.remaining}</span>
                                <span className="text-[#9ca3af]">/{b.quota} days</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Request Type toggle */}
                <div className="mb-3">
                  <label className="form-label">Request Type</label>
                  <div className="flex gap-1 p-1 bg-white border border-[#c7c4d8] rounded-xl">
                    <SegBtn value="leave" current={f.request_type} onChange={v => update(i, 'request_type', v)}>Leave</SegBtn>
                    <SegBtn value="wfh"   current={f.request_type} onChange={v => update(i, 'request_type', v)}>
                      <span className="flex items-center justify-center gap-1"><Home size={12} /> Work From Home</span>
                    </SegBtn>
                  </div>
                </div>

                {/* Leave fields */}
                {f.request_type === 'leave' && (
                  <>
                    <div className="mb-3">
                      <label className="form-label">Leave Type</label>
                      <select className="form-control" value={f.type} onChange={e => update(i, 'type', e.target.value)}>
                        {LEAVE_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                      </select>
                    </div>
                    <div className="mb-3">
                      <label className="form-label">Duration</label>
                      <div className="flex gap-1 p-1 bg-[#f0f3ff] border border-[#c7c4d8] rounded-xl">
                        <SegBtn value="full" current={f.time} onChange={v => update(i, 'time', v)}>Full Day</SegBtn>
                        <SegBtn value="half" current={f.time} onChange={v => update(i, 'time', v)}>Half Day</SegBtn>
                      </div>
                    </div>
                    {f.time === 'half' && (
                      <div className="mb-3">
                        <label className="form-label">Which Half?</label>
                        <div className="flex gap-1 p-1 bg-[#f0f3ff] border border-[#c7c4d8] rounded-xl">
                          <SegBtn value="first_half"  current={f.half} onChange={v => update(i, 'half', v)}>First Half (Morning)</SegBtn>
                          <SegBtn value="second_half" current={f.half} onChange={v => update(i, 'half', v)}>Second Half (Afternoon)</SegBtn>
                        </div>
                      </div>
                    )}
                    <div className="mb-3">
                      <label className="form-label">Select Dates</label>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1">
                          <p className="text-[0.65rem] font-bold text-[#777587] uppercase tracking-wider mb-1.5">Start Date</p>
                          <MiniCalendar
                            value={f.start}
                            onChange={v => update(i, 'start', v)}
                            holidays={holidays}
                          />
                        </div>
                        <div className="flex-1">
                          <p className="text-[0.65rem] font-bold text-[#777587] uppercase tracking-wider mb-1.5">End Date</p>
                          <MiniCalendar
                            value={f.end}
                            onChange={v => update(i, 'end', v)}
                            holidays={holidays}
                            minDate={f.start || undefined}
                          />
                        </div>
                      </div>

                      {/* Range summary */}
                      {f.start && f.end && (() => {
                        const startD = new Date(f.start + 'T12:00:00');
                        const endD   = new Date(f.end   + 'T12:00:00');
                        if (startD > endD) return (
                          <p className="mt-2 text-xs text-rose-600 font-semibold">End date must be after start date.</p>
                        );
                        // Calendar days
                        const calDays = Math.round((endD - startD) / 86400000) + 1;
                        // Holidays in range
                        const holidaysInRange = holidays.filter(h => h.date >= f.start && h.date <= f.end);
                        // Actual leave days: working days (Mon-Fri) excluding holidays
                        let actualDays = 0;
                        for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
                          const dow = d.getDay();
                          const ds  = d.toISOString().slice(0, 10);
                          if (dow !== 0 && dow !== 6 && !holidayDateSet.has(ds)) actualDays++;
                        }
                        return (
                          <div className="mt-2 p-3 rounded-xl bg-[#f0f3ff] border border-[#c7c4d8] space-y-1 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-[#777587]">Selected Range:</span>
                              <span className="font-semibold text-[#151c27]">{f.start} – {f.end}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[#777587]">Total calendar days:</span>
                              <span className="font-semibold text-[#151c27]">{calDays}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[#777587]">Holidays in range:</span>
                              {holidaysInRange.length === 0
                                ? <span className="font-semibold text-[#151c27]">0</span>
                                : <span className="font-semibold text-orange-600">
                                    {holidaysInRange.length} ({holidaysInRange.map(h => h.name).join(', ')})
                                  </span>
                              }
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[#777587]">Actual leave days:</span>
                              <span className="font-black text-[#3525cd] bg-white px-2 py-0.5 rounded-full border border-[#c7c4d8]">{actualDays}</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}

                {/* WFH fields */}
                {f.request_type === 'wfh' && (
                  <>
                    <div className="mb-3">
                      <label className="form-label">WFH Date</label>
                      <input type="date" className="form-control" value={f.wfh_date} onChange={e => update(i, 'wfh_date', e.target.value)} />
                    </div>
                    <div className="mb-3">
                      <label className="form-label">Duration</label>
                      <div className="flex gap-1 p-1 bg-[#f0f3ff] border border-[#c7c4d8] rounded-xl">
                        <SegBtn value="full" current={f.wfh_time} onChange={v => update(i, 'wfh_time', v)}>Full Day</SegBtn>
                        <SegBtn value="half" current={f.wfh_time} onChange={v => update(i, 'wfh_time', v)}>Half Day</SegBtn>
                      </div>
                    </div>
                    {f.wfh_time === 'half' && (
                      <div className="mb-3">
                        <label className="form-label">Which Half?</label>
                        <div className="flex gap-1 p-1 bg-[#f0f3ff] border border-[#c7c4d8] rounded-xl">
                          <SegBtn value="first_half"  current={f.half} onChange={v => update(i, 'half', v)}>First Half (Morning)</SegBtn>
                          <SegBtn value="second_half" current={f.half} onChange={v => update(i, 'half', v)}>Second Half (Afternoon)</SegBtn>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Reason — always required */}
                <div>
                  <label className="form-label">Reason <span className="text-rose-500">*</span></label>
                  <textarea className="form-control" rows="2" placeholder="Reason is required…" value={f.reason} onChange={e => update(i, 'reason', e.target.value)} />
                </div>
              </div>
            ))}
            <button className="btn btn-outline btn-sm text-xs" onClick={add}><Plus size={12} /> Add Another</button>
          </>
        ),
      }}
    </Modal>
  );
}

// ── Edit Leave Modal ──────────────────────────────────────────────────────────
function EditLeaveModal({ leave: l, isAdmin, onClose, onSuccess }) {
  const toast = useToast();
  const canEdit = l.status !== 'approved' || isAdmin;
  const [form, setForm] = useState({ type: l.leave_type, time: l.leave_time, half: l.half_type || 'first_half', start: l.start_date, end: l.end_date, reason: l.reason || '' });
  const [confirmDel, setConfirmDel] = useState(false);

  async function save() {
    if (!form.start || !form.end) return toast('Fill dates', 'warning');
    if (form.start > form.end)    return toast('Start must be before end', 'warning');
    if (!form.reason.trim())      return toast('Reason is required', 'warning');
    try {
      await apiPut(`/leaves/${l.id}`, { leave_type: form.type, start_date: form.start, end_date: form.end, reason: form.reason, leave_time: form.time, half_type: form.time === 'half' ? form.half : null });
      toast('Updated!', 'success'); onClose(); onSuccess();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function del() {
    try { await apiDelete(`/leaves/${l.id}`); toast('Deleted', 'success'); onClose(); onSuccess(); }
    catch (err) { toast(err.message, 'error'); }
  }

  return (
    <>
      <Modal open onClose={onClose} title="Edit Leave" size="md"
        footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>{canEdit && <button className="btn btn-primary" onClick={save}>Save</button>}</>}>
        {{
          header: <button className="btn btn-danger btn-sm text-xs py-1 px-2" onClick={() => setConfirmDel(true)}><Trash2 size={12} /> Delete</button>,
          body: (
            <div className="space-y-3">
              <div><label className="form-label">Employee</label><input className="form-control" value={l.name} disabled /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="form-label">Leave Type</label>
                  <select className="form-control" value={form.type} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    {LEAVE_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
                <div><label className="form-label">Leave Time</label>
                  <select className="form-control" value={form.time} disabled={!canEdit} onChange={e => {
                    const t = e.target.value;
                    setForm(f => ({ ...f, time: t, ...(t === 'wfh' ? { type: 'wfh' } : {}) }));
                  }}>
                    <option value="full">Full Leave</option><option value="half">Half Leave</option><option value="wfh">WFH</option>
                  </select>
                </div>
              </div>
              {form.time === 'half' && (
                <div><label className="form-label">Which Half?</label>
                  <select className="form-control" value={form.half} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, half: e.target.value }))}>
                    <option value="first_half">First Half</option><option value="second_half">Second Half</option>
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="form-label">Start Date</label><input type="date" className="form-control" value={form.start} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} /></div>
                <div><label className="form-label">End Date</label><input type="date" className="form-control" value={form.end} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} /></div>
              </div>
              <div><label className="form-label">Reason <span className="text-rose-500">*</span></label><textarea className="form-control" rows="2" value={form.reason} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} /></div>
              {!canEdit && <p className="text-xs text-amber-600 flex items-center gap-1.5"><AlertTriangle size={12} /> Approved leave — only admin can edit</p>}
              <div className="flex items-center gap-2 mt-1"><StatusBadge status={l.status} />{l.approver_name && <span className="text-xs text-[#777587]">By: {l.approver_name}</span>}</div>
            </div>
          ),
        }}
      </Modal>
      <ConfirmModal
        open={confirmDel}
        title="Delete Leave Record"
        message={`Delete ${l.name}'s leave record? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={del}
        onCancel={() => setConfirmDel(false)}
      />
    </>
  );
}

// ── Employee Leave Summary Table ───────────────────────────────────────────────
function LeaveSummaryTable({ employees, leaves, policies, filterStart, filterEnd }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');

  const activePolicies = policies.filter(p => p.active && p.leave_type !== 'wfh');

  const days = recs => recs.reduce((sum, l) =>
    sum + (l.leave_time === 'half' ? 0.5 : countWorkingDaysInRange(l.start_date, l.end_date)), 0);

  const summaryData = employees.map(emp => {
    let empLeaves = leaves.filter(l => l.user_id === emp.id);
    if (filterStart || filterEnd) {
      const s = filterStart || '0000-01-01';
      const e = filterEnd   || '9999-12-31';
      empLeaves = empLeaves.filter(l => l.start_date <= e && l.end_date >= s);
    }
    const approved = empLeaves.filter(l => l.status === 'approved' && l.leave_time !== 'wfh' && l.leave_type !== 'wfh');
    const pending  = empLeaves.filter(l => ['pending','pending_approval'].includes(l.status) && l.leave_time !== 'wfh' && l.leave_type !== 'wfh');
    const wfhRecs  = empLeaves.filter(l => l.status === 'approved' && (l.leave_time === 'wfh' || l.leave_type === 'wfh'));
    const byType = {};
    activePolicies.forEach(p => {
      byType[p.leave_type] = days(approved.filter(l => l.leave_type === p.leave_type));
    });
    return {
      id: emp.id, name: emp.name, avatar_color: emp.avatar_color,
      byType,
      totalApproved: days(approved),
      totalWfh: days(wfhRecs),
      totalPending: days(pending),
    };
  });

  const filtered = summaryData.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));

  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortKey === 'name')    { va = a.name; vb = b.name; return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); }
    if (sortKey === 'wfh')     { va = a.totalWfh;     vb = b.totalWfh; }
    else if (sortKey === 'total')   { va = a.totalApproved; vb = b.totalApproved; }
    else if (sortKey === 'pending') { va = a.totalPending;  vb = b.totalPending; }
    else { va = a.byType[sortKey] || 0; vb = b.byType[sortKey] || 0; }
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function SortIcon({ col }) {
    if (sortKey !== col) return <ChevronUp size={11} className="opacity-20" />;
    return sortDir === 'asc' ? <ChevronUp size={11} className="text-[#3525cd]" /> : <ChevronDown size={11} className="text-[#3525cd]" />;
  }

  const totals = {
    byType: Object.fromEntries(activePolicies.map(p => [p.leave_type, sorted.reduce((s, r) => s + (r.byType[p.leave_type] || 0), 0)])),
    wfh:     sorted.reduce((s, r) => s + r.totalWfh, 0),
    total:   sorted.reduce((s, r) => s + r.totalApproved, 0),
    pending: sorted.reduce((s, r) => s + r.totalPending, 0),
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <input
          type="text"
          className="form-control w-52 py-1.5 px-3 text-xs"
          placeholder="Search employee…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="text-xs text-[#777587]">{sorted.length} employee{sorted.length !== 1 ? 's' : ''}</span>
        {(filterStart || filterEnd) && (
          <span className="text-xs font-semibold text-[#3525cd] bg-[#f0f3ff] px-2.5 py-1 rounded-full border border-[#c7c4d8]">
            Filtered by date range
          </span>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs min-w-[600px]">
          <thead>
            <tr className="border-b border-[#e5e7f0] bg-[#f8f9ff]">
              <th className="text-left py-3 px-4 font-black text-[#151c27] sticky left-0 bg-[#f8f9ff]">
                <button className="flex items-center gap-1 hover:text-[#3525cd]" onClick={() => toggleSort('name')}>
                  Employee <SortIcon col="name" />
                </button>
              </th>
              {activePolicies.map(p => (
                <th key={p.leave_type} className="text-center py-3 px-3 font-black text-[#464555]">
                  <button className="flex items-center gap-1 mx-auto capitalize hover:text-[#3525cd]" onClick={() => toggleSort(p.leave_type)}>
                    {p.leave_type} <SortIcon col={p.leave_type} />
                  </button>
                </th>
              ))}
              <th className="text-center py-3 px-3 font-black text-blue-700">
                <button className="flex items-center gap-1 mx-auto hover:text-blue-900" onClick={() => toggleSort('wfh')}>
                  WFH <SortIcon col="wfh" />
                </button>
              </th>
              <th className="text-center py-3 px-3 font-black text-[#3525cd]">
                <button className="flex items-center gap-1 mx-auto hover:text-[#1a0f8f]" onClick={() => toggleSort('total')}>
                  Total <SortIcon col="total" />
                </button>
              </th>
              <th className="text-center py-3 px-3 font-black text-amber-600">
                <button className="flex items-center gap-1 mx-auto hover:text-amber-800" onClick={() => toggleSort('pending')}>
                  Pending <SortIcon col="pending" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={activePolicies.length + 4} className="text-center py-8 text-[#9ca3af] text-xs">No employees found</td></tr>
            ) : sorted.map(emp => (
              <tr key={emp.id} className="border-b border-[#f0f3ff] hover:bg-[#f8f9ff] transition-colors">
                <td className="py-3 px-4 sticky left-0 bg-white hover:bg-[#f8f9ff]">
                  <div className="flex items-center gap-2">
                    <Avatar name={emp.name} color={emp.avatar_color} size={28} />
                    <span className="font-semibold text-[#151c27] whitespace-nowrap">{emp.name}</span>
                  </div>
                </td>
                {activePolicies.map(p => (
                  <td key={p.leave_type} className="text-center py-3 px-3">
                    {emp.byType[p.leave_type] > 0
                      ? <span className="font-bold text-[#151c27]">{emp.byType[p.leave_type]}</span>
                      : <span className="text-[#d1d5db]">—</span>}
                  </td>
                ))}
                <td className="text-center py-3 px-3">
                  {emp.totalWfh > 0
                    ? <span className="font-bold text-blue-600">{emp.totalWfh}</span>
                    : <span className="text-[#d1d5db]">—</span>}
                </td>
                <td className="text-center py-3 px-3">
                  {emp.totalApproved > 0
                    ? <span className="font-black text-[#3525cd] bg-[#f0f3ff] px-2 py-0.5 rounded-full">{emp.totalApproved}</span>
                    : <span className="text-[#d1d5db]">0</span>}
                </td>
                <td className="text-center py-3 px-3">
                  {emp.totalPending > 0
                    ? <span className="font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">{emp.totalPending}</span>
                    : <span className="text-[#d1d5db]">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
          {sorted.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-[#c7c4d8] bg-[#f0f3ff]">
                <td className="py-3 px-4 font-black text-[#151c27] text-xs sticky left-0 bg-[#f0f3ff]">Total ({sorted.length})</td>
                {activePolicies.map(p => (
                  <td key={p.leave_type} className="text-center py-3 px-3 font-black text-[#464555]">
                    {totals.byType[p.leave_type] > 0 ? totals.byType[p.leave_type] : <span className="text-[#d1d5db]">—</span>}
                  </td>
                ))}
                <td className="text-center py-3 px-3 font-black text-blue-700">{totals.wfh > 0 ? totals.wfh : <span className="text-[#d1d5db]">—</span>}</td>
                <td className="text-center py-3 px-3"><span className="font-black text-[#3525cd]">{totals.total}</span></td>
                <td className="text-center py-3 px-3">{totals.pending > 0 ? <span className="font-black text-amber-600">{totals.pending}</span> : <span className="text-[#d1d5db]">—</span>}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
