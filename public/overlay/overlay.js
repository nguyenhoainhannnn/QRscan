/**
 * overlay.js – OBS Browser Source Overlay Client
 * ─────────────────────────────────────────────────────────────
 * Giai đoạn 2: FIFO Alert Queue + TTS + Web Audio Chime
 *
 * Luồng xử lý:
 *   Socket.io new_donation → alertQueue.push() → processQueue()
 *   processQueue():
 *     1. showAlert()          – Hiện Alert Box (bounce-in)
 *     2. playChime()          – Phát âm thanh Web Audio API
 *     3. playTts()            – TTS nếu tts_enabled
 *     4. Đợi max(duration, tts_end) hoặc timeout 15s
 *     5. hideAlert()          – Ẩn Alert Box (fade-out)
 *     6. markPlayed(id)       – POST /api/v1/donations/:id/mark-played
 *     7. Nghỉ 1.5s → next()
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// Cấu hình
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  /** URL ảnh GIF mặc định – dùng file nội bộ /overlay/alert.gif cực nhanh, fallback Giphy online */
  defaultGifUrl: '/overlay/alert.gif',
  fallbackGifUrl: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZmV4cHU4eHY5ZnVobmEzcnBwaHYxdHRhMnRuaGI2eDM4MjExdHlxcCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/WykUqckDqi95YIqtFZ/giphy.gif',

  /** Thời gian hiển thị tối thiểu nếu server không gửi alertDurationMs */
  fallbackDurationMs: 8000,

  /** Timeout an toàn khi chờ TTS (ms) */
  ttsSafetyTimeoutMs: 15000,

  /** Khoảng nghỉ giữa 2 thông báo liên tiếp (ms) */
  gapBetweenAlertMs: 1500,

  /** Độ dài animation fade-out (ms) – phải khớp CSS */
  fadeOutDurationMs: 700,

  /** Độ dài animation bounce-in (ms) */
  bounceInDurationMs: 600,
};

// Preload GIF ngay khi mở trang để luôn sẵn sàng trong RAM
try {
  const _preload = new Image();
  _preload.src = CONFIG.defaultGifUrl;
} catch (_) {}

// ─────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────
const alertBox = document.getElementById('alert-box');
const alertGif = document.getElementById('alert-gif');
const alertDonor = document.getElementById('alert-donor');
const alertMsg = document.getElementById('alert-message');
const alertMsgWrap = document.getElementById('alert-message-wrap');
const alertProgress = document.getElementById('alert-progress');
const connDot = document.getElementById('conn-dot');

// ─────────────────────────────────────────────────────────────
// Hàng đợi FIFO
// ─────────────────────────────────────────────────────────────
/** @type {Array<Object>} */
const alertQueue = [];
let isPlaying = false;

// ─────────────────────────────────────────────────────────────
// Lấy token từ URL ?token=...
// ─────────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const OVERLAY_TOKEN = urlParams.get('token') || '';

// ─────────────────────────────────────────────────────────────
// Socket.io – kết nối với token xác thực
// ─────────────────────────────────────────────────────────────
const socket = io({
  auth: { token: OVERLAY_TOKEN },
  query: { token: OVERLAY_TOKEN },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});

socket.on('connect', () => {
  console.log('[Overlay] Socket kết nối:', socket.id);
  hideConnDot();
});

socket.on('disconnect', (reason) => {
  console.warn('[Overlay] Socket ngắt kết nối:', reason);
  showConnDot();
});

socket.on('connect_error', (err) => {
  console.error('[Overlay] Lỗi kết nối:', err.message);
  showConnDot();
});

// ─── Nhận sự kiện donate mới ─────────────────────────────────
socket.on('new_donation', (data) => {
  console.log('[Overlay] new_donation:', data);

  // Client-side guard: lọc lại theo min_donate_amount nếu server gửi kèm
  // (server đã lọc, nhưng phòng hờ)
  const minAmount = data.minDonateAmount || 0;
  if (data.amount < minAmount) {
    console.log('[Overlay] Bỏ qua donate dưới ngưỡng:', data.amount, '<', minAmount);
    return;
  }

  alertQueue.push(data);
  processQueue();
});

// ─── Nhận sự kiện phát lại (admin replay) ────────────────────
socket.on('replay_donation', (data) => {
  console.log('[Overlay] replay_donation:', data);
  alertQueue.push({ ...data, _replay: true });
  processQueue();
});

// ─────────────────────────────────────────────────────────────
// FIFO Queue Processor
// ─────────────────────────────────────────────────────────────
async function processQueue() {
  if (isPlaying || alertQueue.length === 0) return;
  isPlaying = true;

  while (alertQueue.length > 0) {
    const donation = alertQueue.shift();
    await playAlert(donation);

    // Nghỉ 1.5s giữa 2 thông báo
    await sleep(CONFIG.gapBetweenAlertMs);
  }

  isPlaying = false;
}

// ─────────────────────────────────────────────────────────────
// Phát 1 thông báo đầy đủ
// ─────────────────────────────────────────────────────────────
async function playAlert(donation) {
  const durationMs = donation.alertDurationMs || CONFIG.fallbackDurationMs;

  // ── Bước 1: Hiện Alert Box ──────────────────────────────
  showAlert(donation, durationMs);

  // ── Bước 2: Phát âm thanh chuông ───────────────────────
  try {
    await playChime();
  } catch (e) {
    console.warn('[Overlay] Lỗi chime:', e);
  }

  // ── Bước 3 & 4: Đợi duration + TTS ─────────────────────
  const waitMs = await waitForDurationAndTts(donation, durationMs);
  console.log(`[Overlay] Tổng thời gian hiển thị: ${waitMs}ms`);

  // ── Bước 5: Ẩn Alert Box ────────────────────────────────
  await hideAlert();

  // ── Bước 6: Báo server đã phát xong ─────────────────────
  if (donation.id && !donation._replay) {
    await markPlayed(donation.id);
  }
  if (donation.id && donation._replay) {
    // Với replay ta cũng dùng socket event
    socket.emit('alert_played', { donationId: donation.id });
  }
}

// ─────────────────────────────────────────────────────────────
// Hiển thị Alert Box
// ─────────────────────────────────────────────────────────────
function showAlert(donation, durationMs) {
  // ── Điền nội dung (chống XSS bằng textContent) ───────────
  const amountStr = formatAmount(donation.amount);

  // Sử dụng DOM API thay vì innerHTML để chống XSS
  alertDonor.textContent = '';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = donation.senderName || 'Người ẩn danh';

  const textNode1 = document.createTextNode(' vừa ủng hộ ');

  const amountSpan = document.createElement('span');
  amountSpan.className = 'amount-highlight';
  amountSpan.textContent = amountStr + 'đ';

  alertDonor.appendChild(nameSpan);
  alertDonor.appendChild(textNode1);
  alertDonor.appendChild(amountSpan);

  // Lời nhắn
  const msgText = (donation.message || '').trim();
  alertMsg.textContent = msgText ? '💬 ' + msgText : '';
  if (msgText) {
    alertMsgWrap.classList.add('has-message');
  } else {
    alertMsgWrap.classList.remove('has-message');
  }

  // GIF
  const gifUrl = donation.gifUrl || CONFIG.defaultGifUrl;
  if (gifUrl) {
    alertGif.onload = () => {
      alertGif.classList.remove('is-error');
      alertGif.classList.add('loaded');
    };
    alertGif.onerror = () => {
      console.warn('[Overlay] Lỗi tải ảnh GIF:', gifUrl);
      if (CONFIG.fallbackGifUrl && alertGif.src !== CONFIG.fallbackGifUrl) {
        alertGif.src = CONFIG.fallbackGifUrl;
      } else {
        alertGif.classList.add('is-error');
      }
    };

    if (alertGif.getAttribute('src') !== gifUrl) {
      alertGif.src = gifUrl;
    }
    if (alertGif.complete && alertGif.naturalWidth > 0) {
      alertGif.classList.remove('is-error');
      alertGif.classList.add('loaded');
    }
  } else {
    alertGif.classList.add('is-error');
    alertGif.src = '';
  }

  // ── Progress bar ──────────────────────────────────────────
  alertProgress.style.transition = 'none';
  alertProgress.style.transform = 'scaleX(1)';

  // Bật visibility trước khi animate
  alertBox.classList.remove('is-hiding');
  alertBox.setAttribute('aria-hidden', 'false');
  alertBox.classList.add('is-visible');

  // Kích hoạt progress bar sau bounce-in
  setTimeout(() => {
    alertProgress.style.transition = `transform ${durationMs}ms linear`;
    alertProgress.style.transform = 'scaleX(0)';
  }, CONFIG.bounceInDurationMs);
}

// ─────────────────────────────────────────────────────────────
// Ẩn Alert Box
// ─────────────────────────────────────────────────────────────
function hideAlert() {
  return new Promise((resolve) => {
    alertBox.classList.remove('is-visible');
    alertBox.classList.add('is-hiding');
    alertBox.setAttribute('aria-hidden', 'true');

    setTimeout(() => {
      alertBox.classList.remove('is-hiding');
      resolve();
    }, CONFIG.fadeOutDurationMs + 50);
  });
}

// ─────────────────────────────────────────────────────────────
// Đợi duration + TTS
// ─────────────────────────────────────────────────────────────
async function waitForDurationAndTts(donation, durationMs) {
  const startMs = Date.now();

  // Luôn đợi ít nhất durationMs
  const durationPromise = sleep(durationMs);

  // TTS nếu được bật và có text
  let ttsPromise = Promise.resolve();
  if (donation.ttsText) {
    ttsPromise = playTts(donation.ttsText).catch((e) => {
      console.warn('[Overlay] TTS lỗi, bỏ qua:', e);
    });
  }

  // Timeout an toàn 15s phòng lỗi mạng
  const safetyTimeout = sleep(CONFIG.ttsSafetyTimeoutMs);

  // Đợi cả duration VÀ tts xong, nhưng không quá safety timeout
  await Promise.race([
    Promise.all([durationPromise, ttsPromise]),
    safetyTimeout,
  ]);

  return Date.now() - startMs;
}

// ─────────────────────────────────────────────────────────────
// Web Audio API – Tạo âm thanh "Ting-dong" mà không cần file MP3
// ─────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume nếu bị suspend (autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Tạo tiếng chuông "Ting-Dong" trong trẻo bằng Web Audio API
 * Không cần file MP3 ngoài.
 */
function playChime() {
  return new Promise((resolve) => {
    try {
      const ctx = getAudioContext();
      const now = ctx.currentTime;

      // ── Nốt "Ting" (cao, ngắn) ───────────────────────────
      playTone(ctx, 1318.5, now, 0.06, 0.6, 'sine');   // E6
      playTone(ctx, 1760.0, now + 0.01, 0.04, 0.5, 'sine');  // A6 (overtone)

      // ── Nốt "Dong" (trầm hơn, dài hơn) ──────────────────
      playTone(ctx, 880.0, now + 0.25, 0.08, 0.9, 'sine');  // A5
      playTone(ctx, 659.25, now + 0.27, 0.05, 0.8, 'sine');  // E5 (overtone)

      // Resolve sau khi âm thanh kết thúc (~1.3s)
      setTimeout(resolve, 1300);
    } catch (e) {
      resolve(); // Không chặn queue nếu audio lỗi
    }
  });
}

/**
 * @param {AudioContext} ctx
 * @param {number} freq    – Hz
 * @param {number} startAt – ctx.currentTime offset
 * @param {number} gain    – 0..1 peak gain
 * @param {number} decay   – decay time (seconds)
 * @param {OscillatorType} type
 */
function playTone(ctx, freq, startAt, gain, decay, type = 'sine') {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  // Pitch bend nhẹ để thêm cảm giác chuông thật
  osc.frequency.exponentialRampToValueAtTime(freq * 0.98, startAt + decay);

  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.01);  // attack
  gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + decay);

  osc.start(startAt);
  osc.stop(startAt + decay + 0.05);
}

// ─────────────────────────────────────────────────────────────
// TTS – Phát giọng đọc qua proxy /api/v1/tts
// ─────────────────────────────────────────────────────────────
function playTts(text) {
  return new Promise((resolve, reject) => {
    if (!text || text.trim().length === 0) { resolve(); return; }

    const ttsUrl = `/api/v1/tts?text=${encodeURIComponent(text.trim())}&lang=vi`;
    const audio = new Audio(ttsUrl);

    audio.onended = () => resolve();
    audio.onerror = (e) => reject(new Error('TTS audio error: ' + e.type));
    audio.oncanplaythrough = () => {
      audio.play().catch(reject);
    };

    // Nếu không load được trong 5s thì fallback
    setTimeout(() => reject(new Error('TTS load timeout')), 5000);
  });
}

// ─────────────────────────────────────────────────────────────
// Mark Played – REST API
// ─────────────────────────────────────────────────────────────
async function markPlayed(donationId) {
  try {
    const res = await fetch(`/api/v1/donations/${donationId}/mark-played`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn('[Overlay] markPlayed thất bại:', res.status, body);
    } else {
      console.log('[Overlay] markPlayed OK:', donationId);
    }
  } catch (e) {
    console.error('[Overlay] markPlayed lỗi mạng:', e);
    // Fallback: dùng Socket.io event
    socket.emit('alert_played', { donationId });
  }
}

// ─────────────────────────────────────────────────────────────
// Connection status dot
// ─────────────────────────────────────────────────────────────
function showConnDot() {
  connDot.classList.remove('conn-dot--hidden');
}

function hideConnDot() {
  connDot.classList.add('conn-dot--hidden');
}

// ─────────────────────────────────────────────────────────────
// Helper: Format số tiền VNĐ
// ─────────────────────────────────────────────────────────────
function formatAmount(amount) {
  if (!amount && amount !== 0) return '?';
  return new Intl.NumberFormat('vi-VN').format(Number(amount));
}

// ─────────────────────────────────────────────────────────────
// Helper: sleep(ms)
// ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// Unlock AudioContext khi người dùng tương tác lần đầu
// (cần thiết với Chrome autoplay policy)
// ─────────────────────────────────────────────────────────────
document.addEventListener('click', () => {
  try { getAudioContext(); } catch (_) { /* ignore */ }
}, { once: true });

console.log('[Overlay] Giai đoạn 2 – OBS Overlay đã khởi tạo. Token:', OVERLAY_TOKEN ? '***' : '(trống)');
