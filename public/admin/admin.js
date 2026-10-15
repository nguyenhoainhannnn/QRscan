/**
 * admin.js – Admin Dashboard Client Logic
 * ─────────────────────────────────────────
 * - Socket.io realtime feed (join admin_room)
 * - 4 Tab navigation
 * - Stats, Donations, Raw Logs (với pagination)
 * - Test Alert, OBS URL copy/rotate
 * - Settings form
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let donationsPage  = 0;
let rawLogsPage    = 0;
const PAGE_SIZE    = 50;

let currentSettings = null;
let obsUrlFull      = '';

// ─────────────────────────────────────────────────────────────────────────────
// Toast helper
// ─────────────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', ms = 3500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    t.style.transition = '.3s';
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmtVnd(n) {
  return new Intl.NumberFormat('vi-VN').format(Number(n) || 0) + 'đ';
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('vi-VN', { hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
function statusBadge(status) {
  const map = {
    QUEUED:       ['badge-blue',   '⏳ QUEUED'],
    PLAYED:       ['badge-green',  '✅ PLAYED'],
    REPLAYED:     ['badge-purple', '🔁 REPLAYED'],
    SKIPPED:      ['badge-gray',   '⏭ SKIPPED'],
    PARSED:       ['badge-green',  '✅ PARSED'],
    FAILED_REGEX: ['badge-red',    '❌ FAILED'],
    DUPLICATE:    ['badge-yellow', '🟡 DUPLICATE'],
    IGNORED:      ['badge-gray',   '⚪ IGNORED'],
    PENDING:      ['badge-blue',   '🔵 PENDING'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab navigation
// ─────────────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${tab}`)?.classList.add('active');

    // Lazy-load data on tab open
    if (tab === 'rawlogs' && rawLogsPage === 0) loadRawLogs();
    if (tab === 'tools') loadObsUrl();
    if (tab === 'settings') loadSettings();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    // Session expired
    toast('Phiên đăng nhập hết hạn. Đang chuyển về trang đăng nhập…', 'error', 4000);
    setTimeout(() => { window.location.href = '/admin/login'; }, 2000);
    throw new Error('SESSION_EXPIRED');
  }
  const data = await res.json().catch(() => ({ ok: false, error: 'PARSE_ERROR' }));
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io – Realtime
// ─────────────────────────────────────────────────────────────────────────────
const socket = io({ credentials: 'include' });

socket.on('connect', () => {
  setConnBadge(true);
  // Join admin room với password từ cookie session (server dùng cookie để auth)
  // Admin join bằng cơ chế riêng – server nhận event này và kiểm tra session
  socket.emit('join_admin_session', {});
});

socket.on('disconnect', () => setConnBadge(false));
socket.on('connect_error', () => setConnBadge(false));

// Nhận sự kiện donate mới realtime
socket.on('new_donation', (data) => {
  if (data._isTest) {
    toast(`🧪 Test alert: ${data.senderName} – ${fmtVnd(data.amount)}`, 'info');
    return;
  }
  document.getElementById('s-last-event').textContent =
    `Vừa: ${data.senderName} – ${fmtVnd(data.amount)}`;
  toast(`💜 Donate mới: ${data.senderName} – ${fmtVnd(data.amount)}`, 'success');

  // Nếu đang ở tab dashboard, prepend row vào bảng
  const tbody = document.getElementById('donations-tbody');
  if (document.getElementById('panel-dashboard').classList.contains('active')) {
    prependDonationRow(data, tbody);
    loadStats(); // cập nhật stats
  }
});

socket.on('donation_replayed', () => {
  toast('🔁 Đã phát lại lên OBS thành công!', 'success');
});

socket.on('test_alert_sent', () => {
  toast('🚀 Test alert đã bắn lên OBS!', 'info');
});

// Server emit khi join admin thành công
socket.on('joined_admin', () => {
  console.log('[Admin] Joined admin room via socket');
});

function setConnBadge(connected) {
  const badge = document.getElementById('conn-badge');
  const text  = document.getElementById('conn-text');
  badge.classList.toggle('disconnected', !connected);
  text.textContent = connected ? 'Realtime Online' : 'Mất kết nối';
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Stats
// ─────────────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const data = await api('/api/v1/admin/stats');
    if (!data.ok) return;
    const { today, month, topDonors } = data.data;

    document.getElementById('s-today-amount').textContent = fmtVnd(today.amount);
    document.getElementById('s-today-count').textContent  = `${today.count} lượt donate`;
    document.getElementById('s-month-amount').textContent = fmtVnd(month.amount);
    document.getElementById('s-month-count').textContent  = `${month.count} giao dịch`;
    document.getElementById('s-pending').textContent      = today.pendingCount;

    // Update tab badge
    const badge = document.getElementById('badge-pending');
    if (today.pendingCount > 0) {
      badge.textContent = today.pendingCount;
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }

    // Top donors
    renderTopDonors(topDonors);
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') console.error(e); }
}

function renderTopDonors(donors) {
  const el = document.getElementById('top-donors');
  if (!donors?.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>Chưa có dữ liệu</p></div>';
    return;
  }
  const rankClass = ['top1','top2','top3','',''];
  el.innerHTML = donors.map((d, i) => `
    <div class="donor-item">
      <div class="donor-rank ${rankClass[i]}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i+1}</div>
      <div class="donor-info">
        <div class="donor-name">${escHtml(d.name)}</div>
        <div class="donor-meta">${d.count} lần · Cao nhất: ${fmtVnd(d.maxSingle)}</div>
      </div>
      <div class="donor-amount">${fmtVnd(d.totalAmount)}</div>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Donations
// ─────────────────────────────────────────────────────────────────────────────
async function loadDonations(page = 0) {
  donationsPage = page;
  const search   = document.getElementById('search-q')?.value || '';
  const dateFrom = document.getElementById('filter-date-from')?.value || '';
  const dateTo   = document.getElementById('filter-date-to')?.value   || '';
  const status   = document.getElementById('filter-status')?.value    || '';

  const params = new URLSearchParams({
    limit:  PAGE_SIZE, offset: page * PAGE_SIZE,
    ...(search   && { search }),
    ...(dateFrom && { date_from: dateFrom }),
    ...(dateTo   && { date_to: dateTo }),
    ...(status   && { status }),
  });

  const tbody = document.getElementById('donations-tbody');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text3)">Đang tải…</td></tr>`;

  try {
    const data = await api(`/api/v1/admin/donations?${params}`);
    if (!data.ok) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);padding:1rem">${escHtml(data.message)}</td></tr>`; return; }

    if (!data.data?.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">📭</div><p>Không có dữ liệu</p></div></td></tr>`;
    } else {
      tbody.innerHTML = data.data.map(d => donationRow(d)).join('');
    }

    // Pagination
    const total = data.pagination?.total || 0;
    renderPagination('donations', page, total, PAGE_SIZE, loadDonations);
    document.getElementById('donations-info').textContent =
      `Hiển thị ${data.data.length} / ${total} giao dịch`;
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') console.error(e); }
}

function donationRow(d, isNew = false) {
  const statusEl = statusBadge(d.alert_status);
  return `
    <tr class="${isNew ? 'tr-new' : ''}" id="drow-${d.id}">
      <td style="color:var(--text3);font-family:'JetBrains Mono',monospace">#${d.id}</td>
      <td class="name-cell" title="${escHtml(d.sender_name)}">${escHtml(d.sender_name)}</td>
      <td class="amount-cell">${fmtVnd(d.amount)}</td>
      <td class="msg-cell" title="${escHtml(d.message||'')}">${escHtml(d.message||'—')}</td>
      <td>${statusEl}</td>
      <td class="time-cell">${fmtTime(d.created_at)}</td>
      <td>
        <button class="btn btn-success btn-sm" onclick="replayDonation(${d.id})">🔁 Replay</button>
      </td>
    </tr>`;
}

function prependDonationRow(data, tbody) {
  const firstRow = tbody.querySelector('tr');
  const newTr = document.createElement('tbody');
  newTr.innerHTML = donationRow({ ...data, sender_name: data.senderName,
    alert_status: 'QUEUED', created_at: new Date().toISOString() }, true);
  const tr = newTr.querySelector('tr');
  if (firstRow) tbody.insertBefore(tr, firstRow);
  else tbody.appendChild(tr);
}

async function replayDonation(id) {
  const btn = document.querySelector(`#drow-${id} .btn-success`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const data = await api(`/api/v1/admin/donations/${id}/replay`, { method: 'POST' });
    if (data.ok) {
      toast('🔁 Đã gửi lại lên OBS!', 'success');
      // Cập nhật badge trên row
      const row = document.getElementById(`drow-${id}`);
      const statusTd = row?.children[4];
      if (statusTd) statusTd.innerHTML = statusBadge('REPLAYED');
    } else {
      toast(`❌ ${data.message || 'Lỗi replay'}`, 'error');
    }
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') toast('❌ Lỗi kết nối', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔁 Replay'; } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Raw Logs
// ─────────────────────────────────────────────────────────────────────────────
async function loadRawLogs(page = 0) {
  rawLogsPage = page;
  const status = document.getElementById('rawlog-filter')?.value || 'ALL';
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, status });
  const tbody  = document.getElementById('rawlogs-tbody');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text3)">Đang tải…</td></tr>`;

  try {
    const data = await api(`/api/v1/admin/raw-logs?${params}`);
    if (!data.ok) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red)">${escHtml(data.message)}</td></tr>`; return; }

    // Update failed badge
    const failed = (data.data || []).filter(r => r.parse_status === 'FAILED_REGEX').length;
    const badge  = document.getElementById('badge-failed');
    if (failed) { badge.textContent = failed; badge.classList.add('show'); }
    else badge.classList.remove('show');

    if (!data.data?.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">📭</div><p>Không có log</p></div></td></tr>`;
    } else {
      tbody.innerHTML = data.data.map(r => rawLogRow(r)).join('');
    }

    const total = data.pagination?.total || 0;
    renderPagination('rawlogs', page, total, PAGE_SIZE, loadRawLogs);
    document.getElementById('rawlogs-info').textContent = `${total} bản ghi`;
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') console.error(e); }
}

function rawLogRow(r) {
  const canReparse = ['FAILED_REGEX', 'IGNORED'].includes(r.parse_status);
  return `
    <tr>
      <td style="color:var(--text3);font-family:'JetBrains Mono',monospace">#${r.id}</td>
      <td>${statusBadge(r.parse_status)}</td>
      <td><div class="raw-text" title="${escHtml(r.raw_text)}">${escHtml(r.raw_text)}</div></td>
      <td style="color:var(--red);font-size:.75rem;max-width:180px">${escHtml(r.error_reason||'—')}</td>
      <td style="color:var(--text3);font-size:.75rem">${escHtml(r.client_ip||'—')}</td>
      <td class="time-cell">${fmtTime(r.created_at)}</td>
      <td>
        ${canReparse
          ? `<button class="btn btn-secondary btn-sm" onclick="reparsLog(${r.id}, this)">🔄 Reparse</button>`
          : '—'}
      </td>
    </tr>`;
}

async function reparsLog(id, btn) {
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const data = await api(`/api/v1/admin/raw-logs/${id}/reparse`, { method: 'POST' });
    if (data.ok && data.result === 'CREATED') {
      toast(`✅ Reparse thành công! Donation #${data.donationId} đã tạo & gửi lên OBS`, 'success', 5000);
      loadRawLogs(rawLogsPage);
    } else if (data.result === 'DUPLICATE') {
      toast(`🟡 Đã tồn tại trước đó (donation #${data.existingId})`, 'info');
    } else {
      toast(`⚠️ ${data.message || data.reason || 'Thất bại'}`, 'error');
    }
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') toast('❌ Lỗi kết nối', 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔄 Reparse'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination renderer
// ─────────────────────────────────────────────────────────────────────────────
function renderPagination(key, current, total, pageSize, loader) {
  const totalPages = Math.ceil(total / pageSize);
  const el = document.getElementById(`${key}-pages`);
  if (!el) return;

  const pages = [];
  // Prev
  pages.push(`<button class="btn btn-secondary btn-sm" ${current===0?'disabled':''} onclick="${loader.name}(${current-1})">‹</button>`);
  // Page numbers (max 5 visible)
  const start = Math.max(0, current - 2);
  const end   = Math.min(totalPages - 1, start + 4);
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="btn btn-sm ${i===current?'btn-primary':'btn-secondary'}" onclick="${loader.name}(${i})">${i+1}</button>`);
  }
  // Next
  pages.push(`<button class="btn btn-secondary btn-sm" ${current>=totalPages-1?'disabled':''} onclick="${loader.name}(${current+1})">›</button>`);
  el.innerHTML = pages.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// OBS URL
// ─────────────────────────────────────────────────────────────────────────────
async function loadObsUrl() {
  try {
    const data = await api('/api/v1/admin/obs-url');
    if (!data.ok) return;
    obsUrlFull = data.url;
    document.getElementById('obs-url-text').textContent = data.url;
  } catch(e) { /* ignore */ }
}

function copyObsUrl() {
  if (!obsUrlFull) return;
  navigator.clipboard.writeText(obsUrlFull)
    .then(() => toast('📋 Đã copy URL vào clipboard!', 'success'))
    .catch(() => toast('❌ Không thể copy. Hãy copy thủ công.', 'error'));
}

async function rotateToken() {
  if (!confirm('⚠️ Đổi token sẽ làm hỏng kết nối OBS hiện tại. Tiếp tục?')) return;
  const btn = document.getElementById('btn-rotate-token');
  btn.disabled = true; btn.textContent = '⏳ Đang đổi…';
  try {
    const data = await api('/api/v1/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ rotate_token: true }),
    });
    if (data.ok) {
      toast(`✅ Token mới: ${data.newToken}`, 'info', 8000);
      loadObsUrl();
    } else {
      toast(`❌ ${data.message}`, 'error');
    }
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') toast('❌ Lỗi', 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔄 Đổi Token mới'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Alert
// ─────────────────────────────────────────────────────────────────────────────
async function sendTestAlert(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = '⏳ Đang gửi…';

  const body = {
    sender_name: document.getElementById('ta-name').value,
    amount:      document.getElementById('ta-amount').value,
    message:     document.getElementById('ta-message').value,
  };

  try {
    const data = await api('/api/v1/admin/test-alert', {
      method: 'POST',
      body:   JSON.stringify(body),
    });
    if (data.ok) {
      toast('🚀 Test alert đã bắn lên OBS!', 'success');
      e.target.reset();
    } else {
      toast(`❌ ${data.message || 'Lỗi'}`, 'error');
    }
  } catch(e2) { if (e2.message !== 'SESSION_EXPIRED') toast('❌ Lỗi kết nối', 'error'); }
  finally { btn.disabled = false; btn.textContent = '🚀 Bắn lên OBS ngay'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const data = await api('/api/v1/admin/settings');
    if (!data.ok) return;
    currentSettings = data.data;
    const s = data.data;
    document.getElementById('cfg-min-amount').value   = s.min_donate_amount || '';
    document.getElementById('cfg-duration').value     = s.alert_duration_ms || '';
    document.getElementById('cfg-tts-enabled').checked = !!s.tts_enabled;
    document.getElementById('cfg-tts-template').value  = s.tts_template || '';
    document.getElementById('cfg-bad-words').value =
      Array.isArray(s.bad_words_list) ? s.bad_words_list.join('\n') : '';
  } catch(e) { if (e.message !== 'SESSION_EXPIRED') console.error(e); }
}

async function saveSettings(e) {
  e.preventDefault();
  const btn     = e.target.querySelector('button[type=submit]');
  const msgEl   = document.getElementById('settings-msg');
  btn.disabled  = true; btn.textContent = '⏳ Đang lưu…';
  msgEl.textContent = '';

  // bad_words_list: textarea → mảng (lọc dòng trống)
  const rawBadWords = document.getElementById('cfg-bad-words').value;
  const badWordArr  = rawBadWords.split('\n').map(w => w.trim()).filter(Boolean);

  const body = {
    min_donate_amount: parseFloat(document.getElementById('cfg-min-amount').value) || null,
    alert_duration_ms: parseInt(document.getElementById('cfg-duration').value)      || null,
    tts_enabled:       document.getElementById('cfg-tts-enabled').checked,
    tts_template:      document.getElementById('cfg-tts-template').value || null,
    bad_words_list:    badWordArr,
  };

  try {
    const data = await api('/api/v1/admin/settings', {
      method: 'PUT', body: JSON.stringify(body),
    });
    if (data.ok) {
      toast('💾 Cài đặt đã lưu thành công!', 'success');
      msgEl.textContent = '✅ Đã lưu';
      setTimeout(() => { msgEl.textContent = ''; }, 3000);
    } else {
      toast(`❌ ${data.message}`, 'error');
    }
  } catch(e2) { if (e2.message !== 'SESSION_EXPIRED') toast('❌ Lỗi kết nối', 'error'); }
  finally { btn.disabled = false; btn.textContent = '💾 Lưu cài đặt'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search debounce
// ─────────────────────────────────────────────────────────────────────────────
let searchTimer;
document.getElementById('search-q')?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadDonations(0), 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await loadStats();
  await loadDonations();

  // Auto-refresh stats every 30s
  setInterval(loadStats, 30_000);
})();
