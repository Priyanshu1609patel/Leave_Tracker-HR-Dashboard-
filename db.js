const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ Missing Supabase credentials in .env file');
  console.error('   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required\n');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// ─── Auto-seed demo data on first run ─────────────────────────────────────────
async function seed() {
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  if (count > 0) return;

  console.log('Seeding database with demo data…');

  // Work schedule
  await supabase.from('work_schedule').insert({
    start_time: '09:00', end_time: '18:00',
    late_threshold: '09:30', early_exit_threshold: '17:00',
    half_day_hours: 4.5, work_days: '1,2,3,4,5'
  });

  // Clockify config placeholder
  await supabase.from('clockify_config').insert({ api_key: '', workspace_id: '' });

  // Users
  const avatarColors = ['#4F46E5','#10B981','#F59E0B','#EF4444','#8B5CF6','#F97316'];
  const rawUsers = [
    { name:'Admin HR',       email:'admin@company.com',  password:'admin123',    role:'admin',     department:'Human Resources', position:'HR Manager',        avatar_color: avatarColors[0] },
    { name:'Alice Johnson',  email:'alice@company.com',  password:'password123', role:'employee',  department:'Engineering',     position:'Senior Developer',   avatar_color: avatarColors[1] },
    { name:'Bob Martinez',   email:'bob@company.com',    password:'password123', role:'employee',  department:'Engineering',     position:'Frontend Developer', avatar_color: avatarColors[2] },
    { name:'Carol Williams', email:'carol@company.com',  password:'password123', role:'employee',  department:'Design',          position:'UI/UX Designer',     avatar_color: avatarColors[3] },
    { name:'David Chen',     email:'david@company.com',  password:'password123', role:'employee',  department:'Marketing',       position:'Marketing Lead',     avatar_color: avatarColors[4] },
    { name:'Eve Thompson',   email:'eve@company.com',    password:'password123', role:'employee',  department:'Sales',           position:'Sales Executive',    avatar_color: avatarColors[5] },
  ];

  const usersToInsert = rawUsers.map(u => ({
    ...u, password: bcrypt.hashSync(u.password, 10)
  }));

  const { data: insertedUsers } = await supabase.from('users').insert(usersToInsert).select();
  const admin    = insertedUsers.find(u => u.role === 'admin');
  const [alice, bob, carol, david, eve] = insertedUsers.filter(u => u.role === 'employee');

  // Attendance records — working days April 1–12, 2026 (skip weekends Apr 4-5, 11-12)
  const attendance = [
    // Alice: present, 1 late, 1 half-day, then on_leave Apr 6-9
    { user_id: alice.id, date:'2026-04-01', check_in:'09:05', check_out:'18:30', status:'present',  is_late:false, is_early_exit:false, work_hours:9.42 },
    { user_id: alice.id, date:'2026-04-02', check_in:'09:45', check_out:'18:00', status:'present',  is_late:true,  is_early_exit:false, work_hours:8.25 },
    { user_id: alice.id, date:'2026-04-03', check_in:'09:00', check_out:'13:30', status:'half_day', is_late:false, is_early_exit:true,  work_hours:4.5  },
    { user_id: alice.id, date:'2026-04-06', status:'on_leave' },
    { user_id: alice.id, date:'2026-04-07', status:'on_leave' },
    { user_id: alice.id, date:'2026-04-08', status:'on_leave' },
    { user_id: alice.id, date:'2026-04-09', status:'on_leave' },
    { user_id: alice.id, date:'2026-04-10', check_in:'09:15', check_out:'18:45', status:'present',  is_late:false, is_early_exit:false, work_hours:9.5  },
    // Bob: 2 absents, otherwise present
    { user_id: bob.id,   date:'2026-04-01', check_in:'09:20', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:8.67 },
    { user_id: bob.id,   date:'2026-04-02', status:'absent' },
    { user_id: bob.id,   date:'2026-04-03', check_in:'10:15', check_out:'18:30', status:'present',  is_late:true,  is_early_exit:false, work_hours:8.25 },
    { user_id: bob.id,   date:'2026-04-06', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: bob.id,   date:'2026-04-07', check_in:'09:10', check_out:'18:15', status:'present',  is_late:false, is_early_exit:false, work_hours:9.08 },
    { user_id: bob.id,   date:'2026-04-08', status:'absent' },
    { user_id: bob.id,   date:'2026-04-09', check_in:'09:30', check_out:'16:30', status:'half_day', is_late:false, is_early_exit:true,  work_hours:7.0  },
    { user_id: bob.id,   date:'2026-04-10', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    // Carol: great attendance
    { user_id: carol.id, date:'2026-04-01', check_in:'09:05', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-02', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-03', check_in:'09:10', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-06', check_in:'08:55', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-07', check_in:'09:20', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-08', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-09', check_in:'09:05', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: carol.id, date:'2026-04-10', check_in:'09:15', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    // David: often late
    { user_id: david.id, date:'2026-04-01', check_in:'09:45', check_out:'18:30', status:'present',  is_late:true,  is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-02', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-03', check_in:'09:55', check_out:'18:30', status:'present',  is_late:true,  is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-06', check_in:'09:35', check_out:'18:30', status:'present',  is_late:true,  is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-07', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-08', check_in:'10:00', check_out:'19:00', status:'present',  is_late:true,  is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-09', check_in:'09:10', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: david.id, date:'2026-04-10', check_in:'09:40', check_out:'18:30', status:'present',  is_late:true,  is_early_exit:false, work_hours:9.0  },
    // Eve: early exits and half days
    { user_id: eve.id,   date:'2026-04-01', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: eve.id,   date:'2026-04-02', check_in:'09:05', check_out:'16:00', status:'present',  is_late:false, is_early_exit:true,  work_hours:6.92 },
    { user_id: eve.id,   date:'2026-04-03', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: eve.id,   date:'2026-04-06', check_in:'09:30', check_out:'14:00', status:'half_day', is_late:false, is_early_exit:true,  work_hours:4.5  },
    { user_id: eve.id,   date:'2026-04-07', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: eve.id,   date:'2026-04-08', check_in:'09:10', check_out:'18:30', status:'present',  is_late:false, is_early_exit:false, work_hours:9.33 },
    { user_id: eve.id,   date:'2026-04-09', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
    { user_id: eve.id,   date:'2026-04-10', check_in:'09:00', check_out:'18:00', status:'present',  is_late:false, is_early_exit:false, work_hours:9.0  },
  ];

  await supabase.from('attendance').insert(attendance);

  // Leaves
  const now = new Date().toISOString();
  await supabase.from('leaves').insert([
    { user_id: alice.id, start_date:'2026-04-06', end_date:'2026-04-09', leave_type:'annual',  reason:'Family vacation',    status:'approved', approved_by: admin.id, approved_at: '2026-04-01T10:00:00Z' },
    { user_id: carol.id, start_date:'2026-04-17', end_date:'2026-04-18', leave_type:'sick',    reason:'Medical appointment', status:'pending'  },
    { user_id: eve.id,   start_date:'2026-04-14', end_date:'2026-04-15', leave_type:'casual',  reason:'Personal work',      status:'rejected', approved_by: admin.id, approved_at: '2026-04-05T14:00:00Z' },
    { user_id: bob.id,   start_date:'2026-04-14', end_date:'2026-04-14', leave_type:'sick',    reason:'Not feeling well',   status:'pending'  },
  ]);

  console.log('✓ Database seeded successfully');
  console.log('  Admin:    admin@company.com / admin123');
  console.log('  Employee: alice@company.com / password123\n');
}

module.exports = { supabase, seed };
