// ==========================================
// 1. CẤU HÌNH FIREBASE
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyCyvtF4NenZrhmU-v0KGegN1yJcL7gad0s",
  authDomain: "smart-lock-group3.firebaseapp.com",
  databaseURL: "https://smart-lock-group3-default-rtdb.firebaseio.com",
  projectId: "smart-lock-group3"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const auth = firebase.auth();

const FACE_MATCH_THRESHOLD = 0.38;
const MAX_SCAN_ATTEMPTS = 80;
const SCAN_INTERVAL_MS = 150;

let currentUser = null;
let masterPin = "1234";

let isLocked = true;
let isESPOnline = false;
let isBuzzerActive = false;

let autoLockCountdown = 10;
let countdownInterval = null;
let currentInputPin = "";
let failedAttempts = 0;
let isLockedOut = false;

let isAiModelLoaded = false;
let faceDescriptorsDB = {};
let ownerFaceName = null;
let faceWorkflowMode = "unlock";
let targetRegisterName = null;

let fingerprintsDB = {}; 

let cameraStream = null;
let faceDetectionInterval = null;
let registrationCountdownTimer = null;
let registrationReady = false;
let scanSessionId = 0;

let localClearedAt = Number(localStorage.getItem('smartLock_clearedAt') || 0);

function getFullDateTime() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

function addLogToFirebase(message, actor) {
  database.ref('logs').push({
    timestamp: getFullDateTime(),
    message: message,
    actor: actor,
    order: Date.now()
  });
}

window.addEventListener('load', () => {
  initFirebaseListeners();
  initAuthStateObserver();
  loadFaceApiModels();
});

// ==========================================
// 2. CHUYỂN TAB ỨNG DỤNG (3 TAB)
// ==========================================
function switchAppTab(tabId) {
  document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('tabContentControl').style.display = 'none';
  document.getElementById('tabContentFingerprint').style.display = 'none';
  document.getElementById('tabContentMembers').style.display = 'none';

  if (tabId === 'control') {
    document.querySelectorAll('.nav-tab-btn')[0].classList.add('active');
    document.getElementById('tabContentControl').style.display = 'flex';
    if (typeof resize3DCanvas === 'function') resize3DCanvas();
  } else if (tabId === 'fingerprint') {
    document.querySelectorAll('.nav-tab-btn')[1].classList.add('active');
    document.getElementById('tabContentFingerprint').style.display = 'flex';
    renderFingerprintsUI();
  } else if (tabId === 'members') {
    document.querySelectorAll('.nav-tab-btn')[2].classList.add('active');
    document.getElementById('tabContentMembers').style.display = 'flex';
    renderRegisteredFacesUI();
    renderAppUsersUI();
  }
}

// ==========================================
// 3. AUTHENTICATION & XỬ LÝ LỖI
// ==========================================
function initAuthStateObserver() {
  auth.onAuthStateChanged(async (firebaseUser) => {
    if (firebaseUser) {
      let displayName = firebaseUser.displayName || "";
      try {
        const snap = await database.ref('users/' + firebaseUser.uid).once('value');
        if (snap.exists() && snap.val().name) displayName = snap.val().name;
      } catch (e) {}

      if (!displayName) {
        displayName = firebaseUser.email.split('@')[0];
        await database.ref('users/' + firebaseUser.uid).set({
          name: displayName,
          email: firebaseUser.email
        });
      }

      currentUser = { uid: firebaseUser.uid, email: firebaseUser.email, name: displayName };
      showMainAppUI();
    } else {
      currentUser = null;
      document.getElementById('appContainer').style.display = 'none';
      document.getElementById('authContainer').style.display = 'block';
    }
  });
}

function switchAuthTab(tab) {
  document.getElementById('loginError').innerText = "";
  document.getElementById('registerError').innerText = "";
  const forgotMsg = document.getElementById('forgotMsg');
  forgotMsg.innerText = "";
  forgotMsg.className = "auth-msg";

  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const forgotForm = document.getElementById('forgotForm');
  const authTabs = document.getElementById('authTabs');

  if (tab === 'login') {
    authTabs.style.display = 'grid';
    loginForm.style.display = 'flex';
    registerForm.style.display = 'none';
    forgotForm.style.display = 'none';
    document.getElementById('tabLoginBtn').classList.add('active');
    document.getElementById('tabRegisterBtn').classList.remove('active');
  } else if (tab === 'register') {
    authTabs.style.display = 'grid';
    loginForm.style.display = 'none';
    registerForm.style.display = 'flex';
    forgotForm.style.display = 'none';
    document.getElementById('tabLoginBtn').classList.remove('active');
    document.getElementById('tabRegisterBtn').classList.add('active');
  } else if (tab === 'forgot') {
    authTabs.style.display = 'none';
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    forgotForm.style.display = 'flex';
    document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value;
  }
}

function parseAuthErrorMessage(error) {
  let codeStr = String(error && error.code ? error.code : "");
  let messageStr = String(error && error.message ? error.message : "");

  if (messageStr.includes("{") && messageStr.includes("}")) {
    try {
      const jsonStart = messageStr.indexOf("{");
      const jsonEnd = messageStr.lastIndexOf("}") + 1;
      const parsed = JSON.parse(messageStr.substring(jsonStart, jsonEnd));
      if (parsed && parsed.error && parsed.error.message) messageStr += " " + parsed.error.message;
    } catch (e) {}
  }
  const combined = (codeStr + " " + messageStr).toUpperCase();
  if (combined.includes("API_KEY_NOT_VALID") || combined.includes("INVALID_API_KEY")) return "LỖI_API_KEY";
  if (combined.includes("USER_NOT_FOUND") || combined.includes("EMAIL_NOT_FOUND")) return "EMAIL_KHONG_TON_TAI";
  if (combined.includes("WRONG_PASSWORD") || combined.includes("INVALID_LOGIN_CREDENTIALS")) return "SAI_THONG_TIN";
  return "LỖI_KHAC";
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass = document.getElementById('loginPassword').value.trim();
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('btnLoginSubmit');

  errEl.innerText = "";
  btn.disabled = true;

  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    const snap = await database.ref('users/' + cred.user.uid).once('value');
    const uName = (snap.exists() && snap.val().name) ? snap.val().name : email;
    addLogToFirebase(`👤 Đăng nhập vào ứng dụng`, uName);
  } catch (err) {
    const errType = parseAuthErrorMessage(err);
    if (errType === "LỖI_API_KEY") errEl.innerText = "🔑 Lỗi API Key Firebase trong app.js!";
    else if (errType === "EMAIL_KHONG_TON_TAI") errEl.innerText = "📭 Gmail này không tồn tại trong hệ thống!";
    else if (errType === "SAI_THONG_TIN") errEl.innerText = "❌ Tên tài khoản hoặc mật khẩu chưa chính xác!";
    else errEl.innerText = "⚠️ Lỗi: " + (err.message || "Không thể đăng nhập");
  } finally {
    btn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('regFullName').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const pass = document.getElementById('regPassword').value.trim();
  const errEl = document.getElementById('registerError');
  const btn = document.getElementById('btnRegisterSubmit');

  errEl.innerText = "";
  if (pass.length < 6) {
    errEl.innerText = "⚠️ Mật khẩu phải có ít nhất 6 ký tự!";
    return;
  }

  btn.disabled = true;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await database.ref('users/' + cred.user.uid).set({ name: name, email: email, createdAt: getFullDateTime() });
    addLogToFirebase(`🆕 Đăng ký tài khoản mới`, name);
  } catch (err) {
    errEl.innerText = "⚠️ Lỗi: " + (err.message || "");
  } finally {
    btn.disabled = false;
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim().toLowerCase();
  const msgEl = document.getElementById('forgotMsg');
  const btn = document.getElementById('btnForgotSubmit');

  msgEl.innerText = "";
  btn.disabled = true;
  try {
    await auth.sendPasswordResetEmail(email);
    msgEl.className = "auth-msg success";
    msgEl.innerText = `✅ Đã gửi link đặt lại mật khẩu tới ${email}!`;
  } catch (err) {
    msgEl.className = "auth-msg error";
    msgEl.innerText = "⚠️ Lỗi: " + (err.message || "");
  } finally {
    btn.disabled = false;
  }
}

function showMainAppUI() {
  document.getElementById('authContainer').style.display = 'none';
  document.getElementById('appContainer').style.display = 'block';
  document.getElementById('loggedInUserName').innerText = currentUser.name;
  document.getElementById('loggedInUserEmail').innerText = currentUser.email;
  updateOwnerUI();
  updateUIState();

  setTimeout(() => {
    if (typeof init3DScene === 'function') init3DScene();
    if (typeof resize3DCanvas === 'function') resize3DCanvas();
  }, 60);
}

function handleLogout() {
  if (currentUser) addLogToFirebase(`🚪 Đăng xuất khỏi ứng dụng`, currentUser.name);
  auth.signOut();
}

function updateOwnerUI() {
  const roleTag = document.getElementById('ownerRoleTag');
  const ownerLabel = document.getElementById('ownerFaceLabel');
  if (ownerLabel) ownerLabel.innerText = ownerFaceName ? ownerFaceName : "Chưa đăng ký Chủ nhà";
  if (roleTag && currentUser) {
    if (ownerFaceName && currentUser.name === ownerFaceName) {
      roleTag.innerText = "👑 Chủ nhà duy nhất";
      roleTag.className = "role-badge owner";
    } else {
      roleTag.innerText = "Thành viên";
      roleTag.className = "role-badge";
    }
  }
}

// ==========================================
// 4. MÔ HÌNH FACE ID
// ==========================================
async function loadFaceApiModels() {
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
  try {
    let retries = 0;
    while (typeof faceapi === 'undefined' && retries < 20) {
      await new Promise(r => setTimeout(r, 250));
      retries++;
    }
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    isAiModelLoaded = true;
  } catch (err) {}
}

// ==========================================
// 5. ĐỒNG BỘ REALTIME & HEARTBEAT (12 GIÂY)
// ==========================================
function initFirebaseListeners() {
  database.ref('settings/pin').on('value', (snap) => {
    masterPin = snap.exists() ? String(snap.val()) : "1234";
  });

  database.ref('settings/ownerFaceName').on('value', (snap) => {
    ownerFaceName = snap.exists() ? snap.val() : null;
    updateOwnerUI();
  });

  database.ref('faces').on('value', (snap) => {
    faceDescriptorsDB = {};
    if (snap.exists()) {
      snap.forEach((child) => {
        const item = child.val();
        if (item && item.label && Array.isArray(item.descriptor)) {
          faceDescriptorsDB[item.label] = new Float32Array(item.descriptor);
        }
      });
    }
    updateOwnerUI();
    renderRegisteredFacesUI();
  });

  database.ref('fingerprints').on('value', (snap) => {
    fingerprintsDB = snap.exists() ? snap.val() : {};
    renderFingerprintsUI();
  });

  database.ref('device/isLocked').on('value', (snap) => {
    const val = snap.val();
    if (val === null) return;
    if (val !== isLocked) {
      isLocked = val;
      updateUIState();
      if (!isLocked) startAutoLockTimer();
      else clearAutoLockTimer();
    }
  });

  // CƠ CHẾ HEARTBEAT AN TOÀN (12 GIÂY) - TRIỆT TIÊU LỖI NHẢY TRẠNG THÁI
  let lastHeartbeatReceived = 0;
  database.ref('device/heartbeat').on('value', (snap) => {
    if (snap.exists()) {
      lastHeartbeatReceived = Date.now();
      if (!isESPOnline) {
        isESPOnline = true;
        setESPStatusUI(true);
      }
    }
  });

  setInterval(() => {
    if (lastHeartbeatReceived > 0 && (Date.now() - lastHeartbeatReceived > 12000)) {
      if (isESPOnline) {
        isESPOnline = false;
        setESPStatusUI(false);
      }
    }
  }, 4000);

  // Lắng nghe sự kiện mở cửa bằng vân tay từ ESP
  let initialFingerLoaded = false;
  database.ref('device/fingerprint').on('value', (snap) => {
    if (!initialFingerLoaded) { initialFingerLoaded = true; return; }
    if (snap.exists()) {
      const data = snap.val();
      if (data && data.status === "success") {
        const memberName = fingerprintsDB[String(data.id)] || `Vân tay Slot #${data.id}`;
        addLogToFirebase(`👆 Mở cửa thành công bằng Vân tay`, `${memberName} (ID #${data.id})`);
      } else if (data && data.status === "failed") {
        addLogToFirebase(`⚠️ Quét vân tay không hợp lệ tại cửa`, `Cảm biến AS608`);
      }
    }
  });

  database.ref('device/alarm/active').on('value', (snap) => {
    const active = snap.val() || false;
    isBuzzerActive = active;
    updateBuzzerUI(active);
    document.getElementById('securityAlertModal').style.display = active ? 'flex' : 'none';
  });

  database.ref('logs').limitToLast(40).on('value', (snap) => {
    const logList = document.getElementById('logList');
    if (!logList) return;
    logList.innerHTML = '';
    const arr = [];
    snap.forEach((child) => {
      const item = child.val();
      const t = item.order || 0;
      if (!t || t > localClearedAt) arr.push(item);
    });
    arr.reverse().forEach((log) => {
      const div = document.createElement('div');
      div.className = 'log-item';
      div.innerHTML = `
        <span><strong>${log.timestamp || getFullDateTime()}</strong> - ${log.message}</span>
        <span style="color:var(--primary); font-weight:700;">${log.actor}</span>
      `;
      logList.appendChild(div);
    });
  });
}

// ==========================================
// 6. QUẢN LÝ VÂN TAY & THÀNH VIÊN
// ==========================================
function renderFingerprintsUI() {
  const container = document.getElementById('fingerprintList');
  if (!container) return;
  const ids = Object.keys(fingerprintsDB);
  if (ids.length === 0) {
    container.innerHTML = `<div style="font-size:11.5px; color:#64748b; padding:6px;">Chưa có vân tay nào được gán tên thành viên.</div>`;
    return;
  }
  container.innerHTML = ids.map(id => `
    <div class="data-item-row">
      <span><i class="fa-solid fa-fingerprint" style="color:#16a34a;"></i> <b>ID #${id}:</b> ${fingerprintsDB[id]}</span>
      <button class="btn-small-action" onclick="deleteFingerprintMap('${id}')">Xóa gán</button>
    </div>
  `).join('');
}

function saveFingerprintMemberMap() {
  const slot = document.getElementById('fpSlotId').value.trim();
  const name = document.getElementById('fpMemberName').value.trim();
  if (!slot || !name) {
    alert("⚠️ Vui lòng nhập số ID và Tên thành viên!");
    return;
  }
  database.ref('fingerprints/' + slot).set(name).then(() => {
    alert(`✅ Đã gán Vân tay ID #${slot} cho: ${name}`);
    document.getElementById('fpSlotId').value = "";
    document.getElementById('fpMemberName').value = "";
    addLogToFirebase(`📝 Gán Vân tay ID #${slot} cho [${name}]`, currentUser ? currentUser.name : "Admin");
  });
}

function deleteFingerprintMap(id) {
  if (confirm(`Xóa thông tin gán của Vân tay ID #${id}?`)) {
    database.ref('fingerprints/' + id).remove().then(() => {
      addLogToFirebase(`🗑️ Đã xóa liên kết Vân tay ID #${id}`, currentUser ? currentUser.name : "Admin");
    });
  }
}

function renderAppUsersUI() {
  const container = document.getElementById('appUsersList');
  if (!container) return;
  database.ref('users').once('value', (snap) => {
    if (!snap.exists()) return;
    let html = '';
    snap.forEach(c => {
      const u = c.val();
      html += `
        <div class="data-item-row">
          <span><i class="fa-solid fa-user"></i> <b>${u.name}</b> (${u.email})</span>
          <span style="font-size:10px; color:#64748b;">${u.createdAt || ""}</span>
        </div>
      `;
    });
    container.innerHTML = html;
  });
}

// ==========================================
// 7. ĐIỀU KHIỂN KHÓA & MÃ PIN
// ==========================================
function handleLockToggle() {
  if (!currentUser) return;
  if (!isESPOnline) {
    alert("⛔ Thiết bị ESP đang NGOẠI TUYẾN! Không thể gửi lệnh điều khiển.");
    return;
  }
  if (isLocked) {
    alert("⚠️ Vui lòng chọn 'Mở bằng Mã PIN' hoặc 'Quét Face ID Mở Cửa'!");
    return;
  }
  setLockState(true, `🔒 Khóa cửa thủ công trên App`, currentUser.name);
}

function setLockState(newLockedState, actionText, actorName) {
  isLocked = newLockedState;
  clearAutoLockTimer();
  updateUIState();
  addLogToFirebase(actionText, actorName);
  database.ref('device/isLocked').set(isLocked);
  if (!isLocked) startAutoLockTimer();
}

function startAutoLockTimer() {
  autoLockCountdown = 10;
  updateCountdownUI();
  clearAutoLockTimer();
  countdownInterval = setInterval(() => {
    autoLockCountdown--;
    updateCountdownUI();
    if (autoLockCountdown <= 0) {
      clearAutoLockTimer();
      setLockState(true, "🔒 Tự động khóa cửa sau 10s", "Hệ thống");
    }
  }, 1000);
}

function clearAutoLockTimer() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdownUI() {
  const stateTag = document.getElementById('doorStateTag');
  const lockBtnText = document.getElementById('lockBtnText');
  if (!isLocked && stateTag && lockBtnText) {
    stateTag.innerText = `CỬA ĐANG MỞ (${autoLockCountdown}s)`;
    lockBtnText.innerText = `BẤM ĐỂ KHÓA CỬA NGAY (${autoLockCountdown}s)`;
  }
}

function openPinModal() {
  if (!currentUser) return;
  if (!isESPOnline) {
    alert("⛔ Thiết bị ESP đang NGOẠI TUYẾN! Không thể mở cửa lúc này.");
    return;
  }
  if (!isLocked) { alert("Cửa đang mở sẵn!"); return; }
  if (isLockedOut) { alert("⛔ Bàn phím đang tạm khóa!"); return; }
  document.getElementById('pinModal').style.display = 'flex';
  clearPin();
}

function closePinModal() { document.getElementById('pinModal').style.display = 'none'; clearPin(); }

function pressNum(num) {
  if (currentInputPin.length < 4 && !isLockedOut) {
    currentInputPin += num;
    updatePinDots();
  }
}

function clearPin() {
  currentInputPin = "";
  updatePinDots();
  document.getElementById('pinErrorText').innerText = "";
}

function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((dot, idx) => {
    dot.classList.toggle('active', idx < currentInputPin.length);
  });
}

function submitNum() {
  if (!currentUser) return;
  if (currentInputPin.length < 4) {
    document.getElementById('pinErrorText').innerText = "Vui lòng nhập đủ 4 chữ số!";
    return;
  }

  if (currentInputPin === masterPin) {
    failedAttempts = 0;
    closePinModal();
    setLockState(false, `🔓 Mở cửa bằng Mã PIN nhà chung`, currentUser.name);
  } else {
    failedAttempts++;
    if (failedAttempts >= 3) {
      triggerSecurityAlarm();
    } else {
      document.getElementById('pinErrorText').innerText = `Sai PIN! Lần (${failedAttempts}/3)`;
      addLogToFirebase(`⚠️ Nhập sai PIN nhà lần ${failedAttempts}`, currentUser.name);
      clearPin();
    }
  }
}

function triggerSecurityAlarm() {
  isLockedOut = true;
  document.getElementById('pinErrorText').innerText = "⛔ Sai 3 lần! Khóa 30s & Hú còi.";
  addLogToFirebase(`🚨 BÁO ĐỘNG: Còi hú do nhập sai PIN 3 lần`, currentUser ? currentUser.name : "Người dùng");
  database.ref('device/alarm/active').set(true);

  let cd = 30;
  const timer = setInterval(() => {
    cd--;
    document.getElementById('pinErrorText').innerText = `⛔ Khóa bàn phím: ${cd}s`;
    if (cd <= 0) {
      clearInterval(timer);
      isLockedOut = false;
      failedAttempts = 0;
      clearPin();
    }
  }, 1000);
}

function dismissSecurityAlert() {
  document.getElementById('securityAlertModal').style.display = 'none';
  isBuzzerActive = false;
  addLogToFirebase(`🔕 Đã tắt còi báo động`, currentUser ? currentUser.name : "Hệ thống");
  database.ref('device/alarm/active').set(false);
  updateBuzzerUI(false);
}

function updateBuzzerUI(active) {
  const badge = document.getElementById('buzzerStatusBadge');
  if (!badge) return;
  if (active) {
    badge.className = 'buzzer-badge alarm';
    badge.innerHTML = '<i class="fa-solid fa-bell"></i> HÚ CÒI!';
  } else {
    badge.className = 'buzzer-badge quiet';
    badge.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> Tắt';
  }
}

function updateUIState() {
  const lockBtn = document.getElementById('lockBtn');
  const lockIcon = document.getElementById('lockIcon');
  const lockBtnText = document.getElementById('lockBtnText');
  const stateTag = document.getElementById('doorStateTag');
  const relayLed = document.getElementById('relayLed');

  if (!lockBtn) return;
  if (isLocked) {
    lockBtn.className = 'btn-lock locked';
    lockIcon.className = 'fa-solid fa-lock';
    lockBtnText.innerText = 'CỬA ĐANG KHÓA (CHỌN PHƯƠNG THỨC MỞ)';
    stateTag.className = 'state-tag locked';
    stateTag.innerText = 'CỬA ĐANG KHÓA';
    if (relayLed) { relayLed.className = 'ind-led locked'; relayLed.innerText = 'ĐANG KHÓA'; }
  } else {
    lockBtn.className = 'btn-lock unlocked';
    lockIcon.className = 'fa-solid fa-unlock';
    lockBtnText.innerText = `BẤM ĐỂ KHÓA CỬA NGAY (${autoLockCountdown}s)`;
    stateTag.className = 'state-tag unlocked';
    stateTag.innerText = `CỬA ĐANG MỞ (${autoLockCountdown}s)`;
    if (relayLed) { relayLed.className = 'ind-led unlocked'; relayLed.innerText = 'ĐANG MỞ'; }
  }
  if (typeof update3DDoorState === 'function') update3DDoorState(isLocked);
}

function setESPStatusUI(online) {
  const badge = document.getElementById('esp32Badge');
  const text = document.getElementById('esp32Text');
  if (!badge) return;
  badge.className = online ? 'esp-status online' : 'esp-status offline';
  text.innerText = online ? 'ESP: Trực tuyến' : 'ESP: Ngoại tuyến';
}

function clearLogs() {
  if (!currentUser) return;
  if (confirm("Xóa hiển thị nhật ký trên màn hình này?")) {
    localClearedAt = Date.now();
    localStorage.setItem('smartLock_clearedAt', String(localClearedAt));
    document.getElementById('logList').innerHTML = '';
  }
}

// ==========================================
// 8. FACE ID AI (THRESHOLD = 0.38)
// ==========================================
function renderRegisteredFacesUI() {
  const listEl = document.getElementById('registeredFaceList');
  if (!listEl) return;
  const names = Object.keys(faceDescriptorsDB);
  if (names.length === 0) {
    listEl.innerHTML = `<div style="font-size:11.5px; color:#dc2626; padding:4px;">Chưa có dữ liệu khuôn mặt nào.</div>`;
    return;
  }
  listEl.innerHTML = names.map(n => `
    <div class="data-item-row">
      <span><i class="fa-solid fa-face-smile" style="color:#16a34a;"></i> ${n}</span>
      ${n === ownerFaceName ? '<span class="role-badge owner">Chủ nhà</span>' : '<span class="role-badge">Thành viên</span>'}
    </div>
  `).join('');
}

function openFaceManagerModal() {
  if (!currentUser) return;
  document.getElementById('faceMainActions').style.display = 'flex';
  document.getElementById('faceStepAddNewSection').style.display = 'none';
  const hasOwner = Boolean(ownerFaceName && faceDescriptorsDB[ownerFaceName]);
  document.getElementById('noOwnerSection').style.display = hasOwner ? 'none' : 'flex';
  document.getElementById('hasOwnerSection').style.display = hasOwner ? 'flex' : 'none';
  document.getElementById('faceManagerModal').style.display = 'flex';
}

function closeFaceManagerModal() { document.getElementById('faceManagerModal').style.display = 'none'; }

function startRegisterFirstOwnerFace() {
  if (!currentUser) return;
  closeFaceManagerModal();
  faceWorkflowMode = "register_owner";
  targetRegisterName = currentUser.name;
  runFaceScanModal(`Đăng ký Chủ nhà duy nhất: ${targetRegisterName}`);
}

function startAddMemberFaceWithOwnerVerify() {
  closeFaceManagerModal();
  faceWorkflowMode = "verify_owner_for_add";
  runFaceScanModal(`Quét khuôn mặt Chủ nhà (${ownerFaceName}) để cấp quyền`);
}

function startScanNewPersonStep() {
  const newName = document.getElementById('newFacePersonName').value.trim();
  if (!newName) { alert("⚠️ Vui lòng nhập họ tên!"); return; }
  closeFaceManagerModal();
  faceWorkflowMode = "register_member";
  targetRegisterName = newName;
  runFaceScanModal(`Đăng ký khuôn mặt: ${newName}`);
}

function startResetFacesWithOwnerVerify() {
  closeFaceManagerModal();
  faceWorkflowMode = "verify_owner_for_reset";
  runFaceScanModal(`Quét khuôn mặt Chủ nhà (${ownerFaceName}) để xóa dữ liệu`);
}

function triggerFaceIDUnlock() {
  if (!isESPOnline) { alert("⛔ Thiết bị ESP đang NGOẠI TUYẾN!"); return; }
  if (!isLocked) { alert("Cửa hiện tại đang mở sẵn!"); return; }
  if (Object.keys(faceDescriptorsDB).length === 0) {
    alert("⚠️ Chưa có khuôn mặt nào!");
    openFaceManagerModal();
    return;
  }
  faceWorkflowMode = "unlock";
  runFaceScanModal("Quét khuôn mặt để mở khóa cửa");
}

function requestChangeMasterPin() {
  if (!ownerFaceName || !faceDescriptorsDB[ownerFaceName]) {
    alert("⚠️ Cần đăng ký Face ID Chủ nhà trước khi đổi mã PIN!");
    openFaceManagerModal();
    return;
  }
  faceWorkflowMode = "verify_owner_for_pin";
  runFaceScanModal(`Quét mặt Chủ nhà (${ownerFaceName}) để đổi PIN`);
}

async function runFaceScanModal(subtitleText) {
  const sessionId = ++scanSessionId;
  const isRegisterMode = (faceWorkflowMode === 'register_owner' || faceWorkflowMode === 'register_member');
  registrationReady = !isRegisterMode;

  document.getElementById('scannerTargetText').innerText = subtitleText;
  document.getElementById('scannerMsg').innerText = "🔄 Đang khởi động Camera...";
  document.getElementById('scannerDistance').innerText = "Euclidean Distance: --- (Threshold: 0.38)";
  document.getElementById('faceScannerModal').style.display = 'flex';

  const videoEl = document.getElementById('webcamVideo');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
    });
    if (sessionId !== scanSessionId) { stream.getTracks().forEach(t => t.stop()); return; }
    cameraStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    if (isAiModelLoaded) {
      if (isRegisterMode) startRegistrationCountdown(sessionId, targetRegisterName);
      startRealtimeFaceRecognition(sessionId);
    }
  } catch (err) {
    document.getElementById('scannerMsg').innerText = "⚠️ Không thể mở Camera!";
  }
}

function startRegistrationCountdown(sessionId, personName) {
  let sec = 3;
  registrationReady = false;
  document.getElementById('scannerMsg').innerText = `Mời [${personName}] nhìn vào camera! Quét sau ${sec}s...`;
  registrationCountdownTimer = setInterval(() => {
    if (sessionId !== scanSessionId) { clearInterval(registrationCountdownTimer); return; }
    sec--;
    if (sec > 0) {
      document.getElementById('scannerMsg').innerText = `Mời [${personName}] nhìn vào camera! Quét sau ${sec}s...`;
    } else {
      clearInterval(registrationCountdownTimer);
      registrationReady = true;
      document.getElementById('scannerMsg').innerText = `📸 Đang lấy mẫu... Giữ yên!`;
    }
  }, 1000);
}

function findBestMatch(descriptor) {
  let bestName = null, bestDistance = Infinity;
  for (const [name, stored] of Object.entries(faceDescriptorsDB)) {
    const dist = faceapi.euclideanDistance(descriptor, stored);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestName = name;
    }
  }
  return { name: bestDistance < FACE_MATCH_THRESHOLD ? bestName : null, distance: bestDistance, matched: bestDistance < FACE_MATCH_THRESHOLD };
}

async function startRealtimeFaceRecognition(sessionId) {
  const videoEl = document.getElementById('webcamVideo');
  const canvasEl = document.getElementById('faceOverlayCanvas');
  await new Promise(r => { if (videoEl.readyState >= 2) r(); else videoEl.onloadedmetadata = () => r(); });
  if (sessionId !== scanSessionId) return;

  canvasEl.width = videoEl.videoWidth || 320;
  canvasEl.height = videoEl.videoHeight || 240;
  const displaySize = { width: canvasEl.width, height: canvasEl.height };
  faceapi.matchDimensions(canvasEl, displaySize);
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });

  let attempts = 0, busy = false, steadyFrames = 0;
  faceDetectionInterval = setInterval(async () => {
    if (busy || sessionId !== scanSessionId) return;
    busy = true;
    try {
      attempts++;
      const detection = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks().withFaceDescriptor();
      if (sessionId !== scanSessionId) return;

      const ctx = canvasEl.getContext('2d');
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

      if (detection) {
        faceapi.draw.drawDetections(canvasEl, faceapi.resizeResults(detection, displaySize));
        steadyFrames++;

        if (faceWorkflowMode === 'register_owner' || faceWorkflowMode === 'register_member') {
          if (registrationReady && steadyFrames >= 3) {
            stopFaceScanner();
            handleFaceScanSuccess(targetRegisterName, detection.descriptor);
            return;
          }
        } else {
          const best = findBestMatch(detection.descriptor);
          const distStr = isFinite(best.distance) ? best.distance.toFixed(3) : "N/A";
          document.getElementById('scannerDistance').innerText = `Distance: ${distStr} (< 0.38)`;

          if (best.matched) {
            const mustBeOwner = ['verify_owner_for_add', 'verify_owner_for_pin', 'verify_owner_for_reset'].includes(faceWorkflowMode);
            if (mustBeOwner && best.name !== ownerFaceName) {
              document.getElementById('scannerMsg').innerText = `⛔ Cần Chủ nhà (${ownerFaceName})!`;
            } else {
              stopFaceScanner();
              handleFaceScanSuccess(best.name, detection.descriptor);
              return;
            }
          } else {
            document.getElementById('scannerMsg').innerText = `❌ Khuôn mặt chưa đăng ký!`;
          }
        }
      }

      if (attempts >= MAX_SCAN_ATTEMPTS) {
        stopFaceScanner();
        alert("⏰ Hết thời gian nhận diện khuôn mặt!");
      }
    } catch (e) {} finally { busy = false; }
  }, SCAN_INTERVAL_MS);
}

function stopFaceScanner() {
  scanSessionId++;
  if (registrationCountdownTimer) clearInterval(registrationCountdownTimer);
  if (faceDetectionInterval) clearInterval(faceDetectionInterval);
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  document.getElementById('faceScannerModal').style.display = 'none';
}

function cancelFaceScanner() { stopFaceScanner(); }

async function handleFaceScanSuccess(personName, descriptor) {
  const key = btoa(unescape(encodeURIComponent(personName))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const arr = Array.from(descriptor);

  if (faceWorkflowMode === 'register_owner') {
    await database.ref('settings/ownerFaceName').set(personName);
    await database.ref('faces/' + key).set({ label: personName, descriptor: arr, createdAt: getFullDateTime() });
    addLogToFirebase(`👑 Đã đăng ký Chủ nhà duy nhất`, personName);
    alert(`✅ Đã lưu khuôn mặt Chủ nhà duy nhất: ${personName}`);
    openFaceManagerModal();
  } else if (faceWorkflowMode === 'verify_owner_for_add') {
    openFaceManagerModal();
    document.getElementById('faceMainActions').style.display = 'none';
    document.getElementById('faceStepAddNewSection').style.display = 'flex';
  } else if (faceWorkflowMode === 'register_member') {
    await database.ref('faces/' + key).set({ label: personName, descriptor: arr, createdAt: getFullDateTime() });
    addLogToFirebase(`📸 Đã thêm Face ID thành viên: ${personName}`, `Duyệt bởi: ${ownerFaceName}`);
    alert(`✅ Đã thêm khuôn mặt mới cho: ${personName}`);
    openFaceManagerModal();
  } else if (faceWorkflowMode === 'verify_owner_for_pin') {
    document.getElementById('oldMasterPinInput').value = "";
    document.getElementById('newMasterPinInput').value = "";
    document.getElementById('changePinModal').style.display = 'flex';
  } else if (faceWorkflowMode === 'verify_owner_for_reset') {
    if (confirm("Xóa toàn bộ CSDL khuôn mặt và đặt lại Chủ nhà?")) {
      await database.ref('faces').remove();
      await database.ref('settings/ownerFaceName').remove();
      addLogToFirebase(`🗑️ Đã xóa sạch CSDL Face ID`, ownerFaceName);
      openFaceManagerModal();
    }
  } else if (faceWorkflowMode === 'unlock') {
    setLockState(false, `🔓 Mở cửa bằng Face ID (${personName})`, personName);
  }
}

function closeChangePinModal() { document.getElementById('changePinModal').style.display = 'none'; }
function submitNewMasterPin() {
  const oldPin = document.getElementById('oldMasterPinInput').value.trim();
  const newPin = document.getElementById('newMasterPinInput').value.trim();
  const errEl = document.getElementById('changePinError');

  if (oldPin !== masterPin) { errEl.innerText = "❌ PIN hiện tại không đúng!"; return; }
  if (!/^\d{4}$/.test(newPin)) { errEl.innerText = "⚠️ PIN mới phải đúng 4 chữ số!"; return; }

  database.ref('settings/pin').set(newPin).then(() => {
    closeChangePinModal();
    addLogToFirebase(`🔑 Đã đổi Mã PIN nhà chung`, `Chủ nhà: ${ownerFaceName}`);
    alert("✅ Đã cập nhật mã PIN mới thành công!");
  });
}
