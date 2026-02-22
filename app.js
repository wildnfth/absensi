const SUPABASE_URL      = 'https://rzynbnftppgpiofnqcuc.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6eW5ibmZ0cHBncGlvZm5xY3VjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzOTg3OTYsImV4cCI6MjA4Njk3NDc5Nn0.l0xS2NeZ8jf7M44kwkauh34iG5uWaBbGBU6braSiFdo'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let currentUser    = null
let currentDate    = new Date()
let attendanceData = {}
let withdrawalData = []   // tarikan uang makan periode ini
let selectedDate   = null
let periodeStart   = 16   // tanggal mulai
let periodeEnd     = 15   // tanggal akhir (bulan berikutnya jika < periodeStart)

// ── DEBUG ──
const logs = []
function dbg(level, ctx, msg, detail) {
  const t = new Date().toLocaleTimeString('id-ID')
  logs.unshift({ t, level, ctx, msg, detail })
  if (logs.length > 50) logs.pop()
  const el = document.getElementById('debug-log')
  if (!el) return
  const c = { INFO:'#C6EDA5', WARN:'#F9E2A0', ERROR:'#FFB4AB' }
  el.innerHTML = logs.slice(0,15).map(e =>
    `<div style="border-bottom:1px solid #3a2a4a;padding:3px 0;color:${c[e.level]||'#D0BCFF'}">
      <span style="color:#7a5a8a">${e.t}</span>
      <span style="color:#EDE0FF"> [${e.ctx}]</span> ${e.msg}
      ${e.detail ? `<div style="color:#7a5a8a;word-break:break-all;padding-left:8px">${JSON.stringify(e.detail)}</div>` : ''}
    </div>`
  ).join('')
}

function toggleDebug() {
  const p = document.getElementById('debug-panel')
  const b = document.getElementById('debug-toggle')
  const open = p.style.display === 'block'
  p.style.display = open ? 'none' : 'block'
  b.textContent = open ? '🐛' : '✕'
}

// ── AUTH ──
async function login() {
  const email = document.getElementById('email').value.trim()
  const pw    = document.getElementById('password').value
  if (!email || !pw) return showMsg('Isi semua kolom.', false)
  const { data, error } = await db.auth.signInWithPassword({ email, password: pw })
  if (error) { dbg('ERROR','login','Gagal',error); return showMsg(error.message, false) }
  dbg('INFO','login','OK: '+data.user.email)
  onLogin(data.user)
}

async function register() {
  const username = document.getElementById('reg-username').value.trim()
  const email    = document.getElementById('reg-email').value.trim()
  const pw       = document.getElementById('reg-password').value
  if (!username) return showMsg('Isi username terlebih dahulu.', false)
  if (!email || !pw) return showMsg('Isi semua kolom.', false)
  if (pw.length < 6)  return showMsg('Kata sandi min. 6 karakter.', false)
  const { error } = await db.auth.signUp({ email, password: pw, options: { data: { username } } })
  if (error) return showMsg(error.message, false)
  showMsg('✓ Akun dibuat! Silakan masuk.', true)
  showLogin()
}

async function logout() {
  await db.auth.signOut()
  currentUser = null; attendanceData = {}
  document.getElementById('auth-screen').style.display = 'flex'
  document.getElementById('app').style.display = 'none'
}

function showRegister() {
  document.getElementById('login-form').style.display = 'none'
  document.getElementById('register-form').style.display = 'block'
  clearMsg()
}

function showLogin() {
  document.getElementById('login-form').style.display = 'block'
  document.getElementById('register-form').style.display = 'none'
  clearMsg()
}

function showMsg(msg, ok) {
  const el = document.getElementById('auth-msg')
  el.textContent = msg
  el.className = 'auth-msg ' + (ok ? 'ok' : 'err')
  el.style.display = 'block'
}

function clearMsg() { document.getElementById('auth-msg').style.display = 'none' }

function onLogin(user) {
  dbg('INFO','onLogin','User: '+user.email)
  currentUser = user
  document.getElementById('auth-screen').style.display = 'none'
  document.getElementById('app').style.display = 'block'
  document.getElementById('user-email-display').textContent = user.email
  // Restore periode dari localStorage (cepat, offline)
  const lsPS = localStorage.getItem('absensi_ps')
  const lsPE = localStorage.getItem('absensi_pe')
  if (lsPS) periodeStart = parseInt(lsPS)
  if (lsPE) periodeEnd   = parseInt(lsPE)
  // Sinkron dari Supabase user metadata
  db.auth.getUser().then(({ data }) => {
    const meta = data?.user?.user_metadata
    if (meta?.periode_start) { periodeStart = meta.periode_start; localStorage.setItem('absensi_ps', periodeStart) }
    if (meta?.periode_end)   { periodeEnd   = meta.periode_end;   localStorage.setItem('absensi_pe', periodeEnd) }
    // Username
    if (meta?.username) {
      applyUsername(meta.username)
    } else {
      // Belum punya username — tampilkan popup sekali
      openUsernameDialog()
    }
    updatePeriodeLabel()
    renderCalendar()
    loadAttendance()
  }).catch(() => {
    updatePeriodeLabel()
    renderCalendar()
    loadAttendance()
  })
}

function applyUsername(name) {
  const el = document.getElementById('header-username')
  if (el) el.textContent = name
}

// ── PERIODE ──
function getPeriode() {
  const y  = currentDate.getFullYear()
  const m  = currentDate.getMonth()
  const ps = periodeStart
  const pe = periodeEnd
  const start = new Date(y, m, ps)
  // Jika hari akhir < hari mulai → akhir di bulan berikutnya
  const endMonth = pe < ps ? m + 1 : m
  const lastDay  = new Date(y, endMonth + 1, 0).getDate()  // hari terakhir bulan tujuan
  const end = new Date(y, endMonth, Math.min(pe, lastDay))
  return { start, end }
}

// ── DATABASE ──
async function loadAttendance() {
  const { start, end } = getPeriode()
  const from = start.toLocaleDateString('sv-SE')
  const to   = end.toLocaleDateString('sv-SE')
  dbg('INFO','load',`${from} → ${to}`)
  try {
    const { data: s } = await db.auth.getSession()
    dbg('INFO','auth','Session: '+(s?.session?.user?.id?.slice(0,8)||'none'))
    const { data, error } = await db.from('attendance').select('date,status,note,lembur_count').gte('date',from).lte('date',to)
    if (error) { dbg('ERROR','load','Query gagal',error); showToast('Gagal memuat data'); return }
    dbg('INFO','load',`${data?.length??0} baris`)
    attendanceData = {}
    data?.forEach(r => { attendanceData[r.date] = { status: r.status, note: r.note || '', lembur_count: r.lembur_count ?? null } })
    renderCalendar()
    await loadWithdrawals()
  } catch(e) { dbg('ERROR','load','Exception',{msg:e.message}) }
}

async function saveAttendance(dateStr, status, note = '', lembur_count = null) {
  dbg('INFO','save',`${dateStr} → ${status??'hapus'} note="${note}" lembur=${lembur_count}`)
  if (status === null) {
    const { error } = await db.from('attendance').delete().eq('user_id',currentUser.id).eq('date',dateStr)
    if (error) { dbg('ERROR','save','Hapus gagal',error); showToast('Gagal menghapus'); return }
    delete attendanceData[dateStr]
  } else {
    const payload = { user_id: currentUser.id, date: dateStr, status, note: note || null }
    if (lembur_count !== null) payload.lembur_count = lembur_count
    const { error } = await db.from('attendance').upsert(payload, { onConflict:'user_id,date' })
    if (error) { dbg('ERROR','save','Simpan gagal',error); showToast('Gagal menyimpan'); return }
    attendanceData[dateStr] = { status, note: note || '', lembur_count }
  }
  dbg('INFO','save','OK')
  renderCalendar()
  updateStats()
}

// ── WITHDRAWALS ──
async function loadWithdrawals() {
  const { start, end } = getPeriode()
  const from = start.toLocaleDateString('sv-SE')
  const to   = end.toLocaleDateString('sv-SE')
  const { data, error } = await db.from('withdrawals')
    .select('id,amount,note,withdrawn_at')
    .gte('withdrawn_at', from)
    .lte('withdrawn_at', to)
    .order('withdrawn_at', { ascending: false })
  if (error) { dbg('ERROR','withdrawals','Load gagal',error); return }
  withdrawalData = data || []
  dbg('INFO','withdrawals',`${withdrawalData.length} tarikan`)
  updateWithdrawalStats()
}

async function saveWithdrawal(amount, note, date) {
  const { start } = getPeriode()
  const periodeStartStr = start.toLocaleDateString('sv-SE')
  const { data, error } = await db.from('withdrawals').insert({
    user_id: currentUser.id,
    amount,
    note: note || null,
    withdrawn_at: date || new Date().toLocaleDateString('sv-SE'),
    periode_start: periodeStartStr
  }).select().single()
  if (error) { dbg('ERROR','withdrawals','Simpan gagal',error); showToast('Gagal menyimpan tarikan'); return }
  withdrawalData.unshift(data)
  updateWithdrawalStats()
  showToast(`Tarikan ${formatRp(amount)} dicatat`)
}

async function deleteWithdrawal(id) {
  const { error } = await db.from('withdrawals').delete().eq('id', id)
  if (error) { showToast('Gagal menghapus'); return }
  withdrawalData = withdrawalData.filter(w => w.id !== id)
  updateWithdrawalStats()
  renderHistoryList()
  showToast('Tarikan dihapus')
}

function updateWithdrawalStats() {
  const totalTarik = withdrawalData.reduce((sum, w) => sum + w.amount, 0)
  const nilaiMakan = parseInt(document.getElementById('gaji-makan').textContent.replace(/[^0-9]/g,'')) || 0

  // Hitung dari updateStats agar sinkron
  const entries  = Object.values(attendanceData)
  const statuses = entries.map(e => e?.status ?? e)
  const totalMasuk = statuses.filter(s => s === 'hadir').length + statuses.filter(s => s === 'lembur').length
  const makan = totalMasuk * UANG_MAKAN
  const sisa  = makan - totalTarik

  const tarikCount = withdrawalData.length
  document.getElementById('gaji-tarik').textContent       = formatRp(totalTarik)
  document.getElementById('gaji-tarik-detail').textContent = tarikCount > 0 ? `${tarikCount}× tarikan` : ''
  document.getElementById('gaji-sisa').textContent        = formatRp(Math.max(0, sisa))
  document.getElementById('gaji-sisa').style.color        = sisa < 0 ? '#B3261E' : '#2E7D32'
}

// ── CALENDAR ──
const MN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']

function renderCalendar() {
  const today = new Date()
  const { start, end } = getPeriode()
  const lbl = `${start.getDate()} ${MN[start.getMonth()]} — ${end.getDate()} ${MN[end.getMonth()]} ${end.getFullYear()}`
  document.getElementById('period-label').textContent = lbl

  const grid = document.getElementById('cal-grid')
  grid.innerHTML = ''

  // Padding cells
  for (let i = 0; i < start.getDay(); i++) {
    const e = document.createElement('div')
    e.className = 'cal-cell empty'
    grid.appendChild(e)
  }

  const cursor = new Date(start)
  while (cursor <= end) {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    const d = cursor.getDate()
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = cursor.getDay()
    const isWE    = dow === 0 || dow === 6
    const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate()
    const entry  = attendanceData[dateStr]
    const status = entry?.status
    const note   = entry?.note || ''

    const cell = document.createElement('div')
    cell.className = `cal-cell${isWE?' weekend':''}${isToday&&!status?' today':''}${status?' '+status:''}`

    const badge = d === 1 ? `<div class="month-badge">${MN[m]}</div>` : ''
    const dot   = status ? `<div class="cal-dot"></div>` : ''
    const noteDot = (status === 'cuti' && note) ? `<div class="note-dot"></div>` : ''
    cell.innerHTML = `${badge}<span class="cal-date">${d}</span>${dot}${noteDot}`
    if (note) cell.title = note

    cell.addEventListener('click', e => { e.stopPropagation(); openMenu(e, dateStr) })
    cell.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e, dateStr) })

    grid.appendChild(cell)
    cursor.setDate(cursor.getDate() + 1)
  }

  updateStats()
}

const UANG_MAKAN  = 40000   // per hari hadir (hadir + lembur)
const UANG_LEMBUR = 50000   // per kali lembur

function formatRp(n) {
  return 'Rp ' + n.toLocaleString('id-ID')
}

function updateStats() {
  const entries = Object.values(attendanceData)
  const statuses = entries.map(e => e?.status ?? e)

  // Hitung hari masuk (hadir + lembur)
  const hariHadir  = statuses.filter(s => s === 'hadir').length
  const hariLembur = statuses.filter(s => s === 'lembur').length
  const totalMasuk = hariHadir + hariLembur

  // Lembur: total kali (sum lembur_count)
  const totalLembur = entries
    .filter(e => e?.status === 'lembur')
    .reduce((sum, e) => sum + (e.lembur_count ?? 1), 0)

  document.getElementById('stat-hadir').textContent  = totalMasuk
  document.getElementById('stat-lembur').textContent = totalLembur
  document.getElementById('stat-libur').textContent  = statuses.filter(s => s === 'libur').length
  document.getElementById('stat-cuti').textContent   = statuses.filter(s => s === 'cuti').length

  const { start, end } = getPeriode()
  document.getElementById('stat-periode').textContent =
    `${start.getDate()} ${MN[start.getMonth()]} — ${end.getDate()} ${MN[end.getMonth()]} ${end.getFullYear()}`

  // ── Estimasi Gaji ──
  const nilaiMakan  = totalMasuk  * UANG_MAKAN
  const nilaiLembur = totalLembur * UANG_LEMBUR
  const total       = nilaiMakan + nilaiLembur

  document.getElementById('gaji-makan').textContent        = formatRp(nilaiMakan)
  document.getElementById('gaji-makan-detail').textContent = totalMasuk > 0 ? `${totalMasuk}× 40rb` : ''
  document.getElementById('gaji-lembur-val').textContent   = formatRp(nilaiLembur)
  document.getElementById('gaji-lembur-detail').textContent= totalLembur > 0 ? `${totalLembur}× 50rb` : ''
  document.getElementById('gaji-total').textContent        = formatRp(total)

  updateWithdrawalStats()
  renderNotesPanel()
}

async function changePeriode(dir) {
  currentDate.setMonth(currentDate.getMonth() + dir)
  attendanceData = {}
  withdrawalData = []
  updateWithdrawalStats()
  renderCalendar()
  await loadAttendance()
}

// ── CONTEXT MENU ──
function openMenu(e, dateStr) {
  e.preventDefault()
  selectedDate = dateStr
  const menu = document.getElementById('ctx-menu')
  menu.classList.add('show')

  // Anchor to the cell element (sticky to tanggal, not cursor)
  const cell = e.currentTarget
  const rect = cell.getBoundingClientRect()
  const menuW = 210, menuH = 240

  // Prefer below-right of cell
  let x = rect.left
  let y = rect.bottom + 4

  // Flip left if overflows right
  if (x + menuW > window.innerWidth)  x = rect.right - menuW
  // Flip above if overflows bottom
  if (y + menuH > window.innerHeight) y = rect.top - menuH - 4

  // Store anchor so we can reposition on scroll
  menu._anchorCell = cell
  menu._offsetX    = x - rect.left
  menu._offsetY    = y - rect.bottom

  menu.style.left = x + 'px'
  menu.style.top  = y + 'px'
}

function closeMenu() { document.getElementById('ctx-menu').classList.remove('show') }

function renderNotesPanel() {
  const body = document.getElementById('notes-list-body')
  const MN   = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  const { start, end } = getPeriode()

  const entries = Object.entries(attendanceData)
    .filter(([date, entry]) => {
      const d = new Date(date + 'T00:00:00')
      if (d < start || d > end) return false
      if (entry.status === 'cuti' || entry.status === 'bonus') return true
      // Lembur hanya tampil jika >1× atau ada keterangan
      if (entry.status === 'lembur') return (entry.lembur_count ?? 1) > 1 || !!entry.note
      return false
    })
    .sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    body.innerHTML = '<span class="note-empty">Belum ada catatan untuk periode ini</span>'
    return
  }

  body.innerHTML = entries.map(([date, entry]) => {
    const [y, m, d] = date.split('-')
    const tgl = `${parseInt(d)} ${MN[parseInt(m)-1]}`
    if (entry.status === 'lembur') {
      const cnt = entry.lembur_count ?? 1
      // 1× lembur tanpa keterangan → tidak perlu ditampilkan
      if (cnt === 1 && !entry.note) return null
      const badge = `<span class="note-lembur-badge">${cnt}× lembur</span>`
      const note  = entry.note ? `<div class="note-entry-text">${entry.note}</div>` : ''
      return `<div class="note-entry e-lembur">
        <span class="note-entry-icon">⏰</span>
        <div class="note-entry-content"><div class="note-entry-date">${tgl}</div>${badge}${note}</div>
      </div>`
    } else if (entry.status === 'bonus') {
      const note = entry.note || '<em style="opacity:0.5">tidak ada keterangan</em>'
      return `<div class="note-entry e-bonus">
        <span class="note-entry-icon">🎁</span>
        <div class="note-entry-content"><div class="note-entry-date">${tgl}</div><div class="note-entry-text">${note}</div></div>
      </div>`
    } else {
      const note = entry.note || '<em style="opacity:0.5">tidak ada keterangan</em>'
      return `<div class="note-entry e-cuti">
        <span class="note-entry-icon">🤒</span>
        <div class="note-entry-content"><div class="note-entry-date">${tgl}</div><div class="note-entry-text">${note}</div></div>
      </div>`
    }
  }).filter(Boolean).join('')
}

function showNotePanel() { renderNotesPanel() }

// Reposition menu on scroll so it stays anchored to the cell
document.addEventListener('scroll', () => {
  const menu = document.getElementById('ctx-menu')
  if (!menu.classList.contains('show') || !menu._anchorCell) return
  const rect = menu._anchorCell.getBoundingClientRect()
  const menuW = 210, menuH = 240
  let x = rect.left + menu._offsetX
  let y = rect.bottom + menu._offsetY
  if (x + menuW > window.innerWidth)  x = rect.right - menuW
  if (y + menuH > window.innerHeight) y = rect.top - menuH - 4
  if (y < 0) y = rect.bottom + 4
  menu.style.left = x + 'px'
  menu.style.top  = y + 'px'
}, true)

async function setStatus(status) {
  if (!selectedDate) return
  closeMenu()

  if (status === 'cuti') {
    openNoteDialog(selectedDate)
    return
  }

  if (status === 'lembur') {
    openLemburDialog(selectedDate)
    return
  }

  if (status === 'bonus') {
    openBonusDialog(selectedDate)
    return
  }

  await saveAttendance(selectedDate, status, null, null)
  const labels = { hadir:'Hadir', libur:'Libur Resmi' }
  showToast(status ? `Ditandai: ${labels[status]}` : 'Tanda dihapus')
}

// ── NOTE DIALOG ──
let pendingNoteDate = null

function openNoteDialog(dateStr) {
  pendingNoteDate = dateStr
  const MN_FULL = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  const [y, m, d] = dateStr.split('-')
  document.getElementById('note-dialog-date').textContent = `${parseInt(d)} ${MN_FULL[parseInt(m)-1]} ${y}`
  // Pre-fill existing note if any
  document.getElementById('note-input').value = attendanceData[dateStr]?.note || ''
  document.getElementById('note-dialog').classList.add('show')
  setTimeout(() => document.getElementById('note-input').focus(), 200)
}

function closeNoteDialog() {
  document.getElementById('note-dialog').classList.remove('show')
  pendingNoteDate = null
}

async function confirmCuti() {
  if (!pendingNoteDate) return
  const dateToSave = pendingNoteDate   // simpan sebelum closeNoteDialog() menghapusnya
  const note = document.getElementById('note-input').value.trim()
  closeNoteDialog()
  await saveAttendance(dateToSave, 'cuti', note)
  showToast('Ditandai: Izin/Cuti/Sakit')
}

// ── TARIK UANG MAKAN ──
function openTarikDialog() {
  const { start, end } = getPeriode()
  const MN_FULL = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  document.getElementById('tarik-dialog-periode').textContent =
    `${start.getDate()} ${MN_FULL[start.getMonth()]} — ${end.getDate()} ${MN_FULL[end.getMonth()]} ${end.getFullYear()}`
  document.getElementById('tarik-date').value   = new Date().toLocaleDateString('sv-SE')
  document.getElementById('tarik-amount').value = ''
  document.getElementById('tarik-note').value   = ''
  document.getElementById('tarik-preview').textContent = ''
  document.getElementById('tarik-dialog').classList.add('show')
  setTimeout(() => document.getElementById('tarik-amount').focus(), 200)
}

function closeTarikDialog() {
  document.getElementById('tarik-dialog').classList.remove('show')
}

function updateTarikPreview() {
  const val = parseInt(document.getElementById('tarik-amount').value) || 0
  const el  = document.getElementById('tarik-preview')
  if (val <= 0) { el.textContent = ''; return }
  // Berapa hari makan setara
  const hari = Math.round(val / UANG_MAKAN * 10) / 10
  el.textContent = `≈ ${hari} hari uang makan`
}

async function confirmTarik() {
  const amount = parseInt(document.getElementById('tarik-amount').value)
  if (!amount || amount <= 0) { showToast('Masukkan jumlah yang valid'); return }
  const date = document.getElementById('tarik-date').value || new Date().toLocaleDateString('sv-SE')
  const note = document.getElementById('tarik-note').value.trim()
  closeTarikDialog()
  await saveWithdrawal(amount, note, date)
}

document.getElementById('tarik-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('tarik-dialog')) closeTarikDialog()
})

// ── HISTORY TARIKAN ──
function openHistoryDialog() {
  const { start, end } = getPeriode()
  const MN_FULL = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  document.getElementById('history-dialog-periode').textContent =
    `${start.getDate()} ${MN_FULL[start.getMonth()]} — ${end.getDate()} ${MN_FULL[end.getMonth()]} ${end.getFullYear()}`
  renderHistoryList()
  document.getElementById('history-dialog').classList.add('show')
}

function closeHistoryDialog() {
  document.getElementById('history-dialog').classList.remove('show')
}

function renderHistoryList() {
  const el = document.getElementById('history-list')
  if (!withdrawalData.length) {
    el.innerHTML = '<span class="note-empty">Belum ada tarikan periode ini</span>'
    return
  }
  const MN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  el.innerHTML = withdrawalData.map(w => {
    const d   = new Date(w.withdrawn_at + 'T00:00:00')
    const tgl = `${d.getDate()} ${MN[d.getMonth()]} ${d.getFullYear()}`
    const note = w.note ? `<div class="history-entry-note">${w.note}</div>` : ''
    return `<div class="history-entry">
      <div class="history-entry-left">
        <div class="history-entry-date">${tgl}</div>
        ${note}
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem">
        <span class="history-entry-amount">${formatRp(w.amount)}</span>
        <button class="history-delete-btn" onclick="deleteWithdrawal('${w.id}')" title="Hapus">✕</button>
      </div>
    </div>`
  }).join('')
}

document.getElementById('history-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('history-dialog')) closeHistoryDialog()
})

// ── SHOW / HIDE PASSWORD ──
function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId)
  if (!inp) return
  const show = inp.type === 'password'
  inp.type = show ? 'text' : 'password'
  btn.textContent = show ? '🙈' : '👁'
}

// ── USERNAME SETUP ──
function openUsernameDialog() {
  document.getElementById('username-input').value = ''
  document.getElementById('username-dialog').classList.add('show')
  setTimeout(() => document.getElementById('username-input').focus(), 200)
}

function closeUsernameDialog() {
  document.getElementById('username-dialog').classList.remove('show')
}

async function confirmUsername() {
  const name = document.getElementById('username-input').value.trim()
  if (!name) return
  closeUsernameDialog()
  applyUsername(name)
  try {
    await db.auth.updateUser({ data: { username: name } })
    dbg('INFO','username','Tersimpan: '+name)
    showToast('Username disimpan: '+name)
  } catch(e) { dbg('WARN','username','Gagal simpan',{msg:e.message}) }
}

document.getElementById('username-dialog').addEventListener('click', e => {
  // Tidak bisa dismiss dengan klik luar — harus isi username
})

document.getElementById('username-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); confirmUsername() }
})

// ── PERIODE SETTINGS ──
let tempPS = 16
let tempPE = 15

function openPeriodeDialog() {
  tempPS = periodeStart
  tempPE = periodeEnd
  document.getElementById('ps-val').textContent = tempPS
  document.getElementById('pe-val').textContent = tempPE
  updatePeriodePreview()
  document.getElementById('periode-dialog').classList.add('show')
}

function closePeriodeDialog() {
  document.getElementById('periode-dialog').classList.remove('show')
}

function adjustDay(which, delta) {
  if (which === 'start') {
    tempPS = Math.max(1, Math.min(31, tempPS + delta))
    document.getElementById('ps-val').textContent = tempPS
  } else {
    tempPE = Math.max(1, Math.min(31, tempPE + delta))
    document.getElementById('pe-val').textContent = tempPE
  }
  updatePeriodePreview()
}

function updatePeriodePreview() {
  const MN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  const m  = currentDate.getMonth()
  const y  = currentDate.getFullYear()
  const crossMonth = tempPE < tempPS
  const endM = crossMonth ? (m + 1) % 12 : m
  const endY = (crossMonth && m === 11) ? y + 1 : y
  document.getElementById('periode-preview-text').textContent =
    `${tempPS} ${MN[m]} — ${tempPE} ${MN[endM]} ${endY}`
  document.getElementById('periode-preview-hint').textContent =
    crossMonth ? 'Akhir di bulan berikutnya' : 'Dalam bulan yang sama'
}

async function confirmPeriode() {
  periodeStart = tempPS
  periodeEnd   = tempPE
  closePeriodeDialog()
  localStorage.setItem('absensi_ps', periodeStart)
  localStorage.setItem('absensi_pe', periodeEnd)
  try {
    await db.auth.updateUser({ data: { periode_start: periodeStart, periode_end: periodeEnd } })
    dbg('INFO','periode',`Tersimpan: ${periodeStart}→${periodeEnd}`)
  } catch(e) { dbg('WARN','periode','Gagal simpan ke server',{msg:e.message}) }
  updatePeriodeLabel()
  attendanceData = {}
  renderCalendar()
  await loadAttendance()
  showToast(`Periode: tgl ${periodeStart} s/d tgl ${periodeEnd}`)
}

function updatePeriodeLabel() {
  const e1 = document.getElementById('periode-start-label')
  const e2 = document.getElementById('periode-end-label')
  if (e1) e1.textContent = periodeStart
  if (e2) e2.textContent = periodeEnd
}

document.getElementById('periode-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('periode-dialog')) closePeriodeDialog()
})

// ── BONUS DIALOG ──
let pendingBonusDate = null

function openBonusDialog(dateStr) {
  pendingBonusDate = dateStr
  const MN_FULL = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  const [y, m, d] = dateStr.split('-')
  document.getElementById('bonus-dialog-date').textContent = `${parseInt(d)} ${MN_FULL[parseInt(m)-1]} ${y}`
  document.getElementById('bonus-note-input').value = attendanceData[dateStr]?.note || ''
  document.getElementById('bonus-dialog').classList.add('show')
  setTimeout(() => document.getElementById('bonus-note-input').focus(), 200)
}

function closeBonusDialog() {
  document.getElementById('bonus-dialog').classList.remove('show')
  pendingBonusDate = null
}

async function confirmBonus() {
  if (!pendingBonusDate) return
  const dateToSave = pendingBonusDate
  const note = document.getElementById('bonus-note-input').value.trim()
  closeBonusDialog()
  await saveAttendance(dateToSave, 'bonus', note, null)
  showToast('Libur Bonus dicatat 🎁')
}

document.getElementById('bonus-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('bonus-dialog')) closeBonusDialog()
})

document.getElementById('bonus-note-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmBonus()
})

// ── LEMBUR DIALOG ──
let pendingLemburDate = null
let lemburCount = 1

function openLemburDialog(dateStr) {
  pendingLemburDate = dateStr
  const MN_FULL = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  const [y, m, d] = dateStr.split('-')
  document.getElementById('lembur-dialog-date').textContent = `${parseInt(d)} ${MN_FULL[parseInt(m)-1]} ${y}`
  const existing = attendanceData[dateStr]
  lemburCount = existing?.lembur_count ?? 1
  document.getElementById('lembur-count-display').textContent = lemburCount
  document.getElementById('lembur-note-input').value = existing?.note || ''
  // Tampilkan textarea hanya jika sudah ≥ 2×
  document.getElementById('lembur-note-field').style.display = lemburCount >= 2 ? 'block' : 'none'
  document.getElementById('lembur-dialog').classList.add('show')
}

function closeLemburDialog() {
  document.getElementById('lembur-dialog').classList.remove('show')
  pendingLemburDate = null
}

function adjustLembur(delta) {
  lemburCount = Math.max(1, Math.min(10, lemburCount + delta))
  document.getElementById('lembur-count-display').textContent = lemburCount
  // Tampilkan textarea keterangan hanya jika ≥ 2×
  document.getElementById('lembur-note-field').style.display = lemburCount >= 2 ? 'block' : 'none'
}

async function confirmLembur() {
  if (!pendingLemburDate) return
  const dateToSave = pendingLemburDate
  const note = document.getElementById('lembur-note-input').value.trim()
  const count = lemburCount
  closeLemburDialog()
  await saveAttendance(dateToSave, 'lembur', note, count)
  showToast(`Lembur ${count}× dicatat`)
}

document.getElementById('lembur-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('lembur-dialog')) closeLemburDialog()
})

document.addEventListener('click', e => {
  if (!document.getElementById('ctx-menu').contains(e.target)) closeMenu()
})

// Close note dialog on scrim click
document.getElementById('note-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('note-dialog')) closeNoteDialog()
})

// Enter key in note textarea = confirm
document.getElementById('note-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmCuti()
})

// ── TOAST ──
let toastTimer
function showToast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// ── INIT ──
db.auth.getSession().then(({ data: { session } }) => {
  if (session) onLogin(session.user)
})

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  document.getElementById('register-form').style.display !== 'none' ? register() : login()
})
