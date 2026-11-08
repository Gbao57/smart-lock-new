// 1. CẤU HÌNH FIREBASE
const firebaseConfig = {
  apiKey: "AIzaSyCyvtF4NenZrhmU-v0KGegN1yJcL7gad0s",
  authDomain: "smart-lock-group3.firebaseapp.com",
  databaseURL: "https://smart-lock-group3-default-rtdb.firebaseio.com",
  projectId: "smart-lock-group3"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const database = firebase.database();
const auth = firebase.auth();

// 2. CẤU HÌNH HẰNG SỐ FACE AI (THRESHOLD = 0.38)
const FACE_MATCH_THRESHOLD = 0.38;
const MAX_SCAN_ATTEMPTS = 80;
const SCAN_INTERVAL_MS = 150;

// 3. BIẾN TRẠNG THÁI TOÀN HỆ THỐNG
let currentUser = null; // { uid, email, name }
let masterPin = "1234";

let isLocked = true;
let isESPOnline = false; // Mặc định kiểm tra kết nối thật
let isBuzzerActive = false;

let autoLockCountdown = 10;
let countdownInterval = null;
let currentInputPin = "";
let failedAttempts = 0;
let isLockedOut = false;

// Biến mô hình Face ID AI
let isAiModelLoaded = false;
let faceDescriptorsDB = {};
let ownerFaceName = null;
let faceWorkflowMode = "unlock";
let targetRegisterName = null;

let cameraStream = null;
let faceDetectionInterval = null;
let registrationCountdownTimer = null;
let registrationReady = false;
let scanSessionId = 0;

let localClearedAt = Number(localStorage.getItem('smartLock_clearedAt') || 0);

// ĐỊNH DẠNG THỜI GIAN ĐẦY ĐỦ: GIỜ:PHÚT:GIÂY NGÀY/THÁNG/NĂM
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
// 4. QUẢN LÝ PHIÊN ĐĂNG NHẬP & BỘ PHÂN TÍCH LỖI AUTH (FIX LỖI 400)
// ==========================================
function initAuthStateObserver() {
  auth.onAuthStateChanged(async (firebaseUser) => {
    if (firebaseUser) {
      let displayName = firebaseUser.displayName || "";
      try {
        const snap = await database.ref('users/' + firebaseUser.uid).once('value');
        if (snap.exists() && snap.val().name) {
          displayName = snap.val().name;
        }
      } catch (e) {}

      if (!displayName) {
        displayName = firebaseUser.email.split('@')[0];
        await database.ref('users/' + firebaseUser.uid).set({
          name: displayName,
          email: firebaseUser.email
        });
      }

      currentUser = {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        name: displayName
      };

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

// Hàm phân tích và bóc tách chuỗi lỗi chi tiết
function parseAuthErrorMessage(error) {
  let codeStr = String(error && error.code ? error.code : "");
  let messageStr = String(error && error.message ? error.message : "");

  // Nếu message chứa chuỗi JSON thô từ Google Identity Toolkit
  if (messageStr.includes("{") && messageStr.includes("}")) {
    try {
      const jsonStart = messageStr.indexOf("{");
      const jsonEnd = messageStr.lastIndexOf("}") + 1;
      const parsed = JSON.parse(messageStr.substring(jsonStart, jsonEnd));
      if (parsed && parsed.error && parsed.error.message) {
        messageStr += " " + parsed.error.message;
      }
    } catch (e) {}
  }

  const combined = (codeStr + " " + messageStr).toUpperCase();

  // Kiểm tra lỗi API Key
  if (
    combined.includes("API_KEY_NOT_VALID") ||
    combined.includes("API-KEY-NOT-VALID") ||
    combined.includes("INVALID_API_KEY") ||
    combined.includes("PROJECT_NOT_FOUND")
  ) {
    return "LỖI_API_KEY";
  }

  // Kiểm tra lỗi Gmail không tồn tại
  if (
    combined.includes("USER_NOT_FOUND") ||
    combined.includes("USER-NOT-FOUND") ||
    combined.includes("EMAIL_NOT_FOUND")
  ) {
    return "EMAIL_KHONG_TON_TAI";
  }

  // Kiểm tra lỗi sai mật khẩu hoặc thông tin đăng nhập không hợp lệ
  if (
    combined.includes("WRONG_PASSWORD") ||
    combined.includes("WRONG-PASSWORD") ||
    combined.includes("INVALID_LOGIN_CREDENTIALS") ||
    combined.includes("INVALID-LOGIN-CREDENTIALS") ||
    combined.includes("INVALID_CREDENTIAL")
  ) {
    return "SAI_THONG_TIN";
  }

  if (combined.includes("INVALID_EMAIL") || combined.includes("INVALID-EMAIL")) {
    return "EMAIL_KHONG_HOP_LE";
  }
  if (combined.includes("EMAIL_ALREADY_IN_USE") || combined.includes("EMAIL-ALREADY-IN-USE")) {
    return "EMAIL_DA_TON_TAI";
  }
  if (combined.includes("WEAK_PASSWORD") || combined.includes("WEAK-PASSWORD")) {
    return "MAT_KHAU_YEU";
  }
  if (combined.includes("TOO_MANY_ATTEMPTS") || combined.includes("TOO-MANY-REQUESTS")) {
    return "THU_QUA_NHIEU_LAN";
  }

  return "LỖI_KHAC";
}

async function checkEmailExists(email) {
  try {
    const list = await auth.fetchSignInMethodsForEmail(email);
    if (list && list.length > 0) return true;
  } catch (e) {}

  try {
    const snap = await database.ref('users').once('value');
    if (snap.exists()) {
      let found = false;
      snap.forEach(c => {
        const u = c.val();
        if (u && String(u.email || "").toLowerCase() === email.toLowerCase()) {
          found = true;
        }
      });
      if (found) return true;
    }
  } catch (e) {}

  return false;
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

    await database.ref('users/' + cred.user.uid).update({
      name: uName,
      email: email
    });

    addLogToFirebase(`👤 Đăng nhập vào ứng dụng`, uName);
  } catch (err) {
    const errType = parseAuthErrorMessage(err);

    if (errType === "LỖI_API_KEY") {
      errEl.innerText = "🔑 Lỗi API Key: Mã apiKey trong file js/app.js không chính xác hoặc chưa bật Identity Toolkit!";
    } else if (errType === "EMAIL_KHONG_TON_TAI") {
      errEl.innerText = "📭 Gmail này không tồn tại trong hệ thống! Vui lòng bấm Đăng ký.";
    } else if (errType === "SAI_THONG_TIN") {
      // Trường hợp Firebase gộp lỗi (Enumeration Protection), kiểm tra thực tế
      const exists = await checkEmailExists(email);
      if (!exists) {
        errEl.innerText = "📭 Gmail này không tồn tại trong hệ thống! Vui lòng bấm Đăng ký.";
      } else {
        errEl.innerText = "❌ Tên tài khoản hoặc mật khẩu chưa chính xác!";
      }
    } else if (errType === "EMAIL_KHONG_HOP_LE") {
      errEl.innerText = "⚠️ Định dạng Email không hợp lệ!";
    } else if (errType === "THU_QUA_NHIEU_LAN") {
      errEl.innerText = "⛔ Nhập sai quá nhiều lần! Vui lòng thử lại sau ít phút.";
    } else {
      errEl.innerText = "⚠️ Lỗi xác thực: " + (err.message || "Không thể đăng nhập.");
    }
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

    await database.ref('users/' + cred.user.uid).set({
      name: name,
      email: email,
      createdAt: getFullDateTime()
    });

    addLogToFirebase(`🆕 Đăng ký tài khoản mới (${email})`, name);
  } catch (err) {
    const errType = parseAuthErrorMessage(err);
    if (errType === "LỖI_API_KEY") {
      errEl.innerText = "🔑 Lỗi API Key: Mã apiKey trong file js/app.js không chính xác!";
    } else if (errType === "EMAIL_DA_TON_TAI") {
      errEl.innerText = "⚠️ Gmail này đã được đăng ký trước đó!";
    } else {
      errEl.innerText = "⚠️ Lỗi đăng ký: " + (err.message || "");
    }
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
    const exists = await checkEmailExists(email);
    if (!exists) {
      msgEl.className = "auth-msg error";
      msgEl.innerText = "📭 Gmail này không tồn tại trong hệ thống!";
      btn.disabled = false;
      return;
    }

    await auth.sendPasswordResetEmail(email);
    msgEl.className = "auth-msg success";
    msgEl.innerText = `✅ Đã gửi link đặt lại mật khẩu tới ${email}! Hãy kiểm tra Hộp thư đến hoặc mục Spam.`;
    addLogToFirebase(`📧 Yêu cầu đặt lại mật khẩu`, email);
  } catch (err) {
    msgEl.className = "auth-msg error";
    const errType = parseAuthErrorMessage(err);
    if (errType === "LỖI_API_KEY") {
      msgEl.innerText = "🔑 Lỗi API Key: Mã apiKey trong file js/app.js không chính xác!";
    } else {
      msgEl.innerText = "⚠️ Không thể gửi mail: " + (err.message || "");
    }
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
  if (currentUser) {
    addLogToFirebase(`🚪 Đăng xuất khỏi ứng dụng`, currentUser.name);
  }
  auth.signOut();
}

function updateOwnerUI() {
  const roleTag = document.getElementById('ownerRoleTag');
  const ownerLabel = document.getElementById('ownerFaceLabel');
  if (ownerLabel) {
    ownerLabel.innerText = ownerFaceName ? ownerFaceName : "Chưa đăng ký Chủ nhà";
  }
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
// 5. TẢI MÔ HÌNH AI NHẬN DIỆN KHUÔN MẶT
// ==========================================
async function loadFaceApiModels() {
  const statusEl = document.getElementById('aiStatusText');
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
    if (statusEl) statusEl.innerText = "AI Face ID: Sẵn sàng (Threshold 0.38)";
  } catch (err) {
    if (statusEl) statusEl.innerText = "AI Face ID: Chế độ dự phòng";
  }
}

// ==========================================
// 6. ĐỒNG BỘ DỮ LIỆU REALTIME, TRẠNG THÁI ESP & CẢM BIẾN VÂN TAY
// ==========================================
function initFirebaseListeners() {
  // A. Mã PIN nhà chung
  database.ref('settings/pin').on('value', (snap) => {
    if (!snap.exists()) {
      database.ref('settings/pin').set("1234");
      masterPin = "1234";
    } else {
      masterPin = String(snap.val());
    }
  });

  // B. Chủ nhà duy nhất
  database.ref('settings/ownerFaceName').on('value', (snap) => {
    ownerFaceName = snap.exists() ? snap.val() : null;
    updateOwnerUI();
  });

  // C. Dữ liệu Face ID
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

  // D. Trạng thái khóa cửa (isLocked)
  database.ref('device/isLocked').on('value', (snap) => {
    const val = snap.val();
    if (val === null) {
      database.ref('device/isLocked').set(true);
      return;
    }
    if (val !== isLocked) {
      isLocked = val;
      updateUIState();
      if (!isLocked) startAutoLockTimer();
      else clearAutoLockTimer();
    }
  });

  // E. Kiểm tra trực tuyến/ngoại tuyến thực tế của ESP qua Heartbeat
  let lastHeartbeatTime = 0;
  database.ref('device/heartbeat').on('value', (snap) => {
    lastHeartbeatTime = snap.val() || 0;
  });

  database.ref('device/online').on('value', (snap) => {
    const val = snap.val() || false;
    isESPOnline = val;
    setESPStatusUI(isESPOnline);
  });

  // Giám sát tự động ngắt kết nối sau 7 giây không nhận tín hiệu từ ESP
  setInterval(() => {
    if (lastHeartbeatTime > 0 && (Date.now() - lastHeartbeatTime > 7000)) {
      if (isESPOnline) {
        isESPOnline = false;
        database.ref('device/online').set(false);
        setESPStatusUI(false);
      }
    }
  }, 3000);

  // F. Lắng nghe cảm biến vân tay từ ESP (Mục 2)
  let initialFingerprintLoaded = false;
  database.ref('device/fingerprint').on('value', (snap) => {
    if (!initialFingerprintLoaded) {
      initialFingerprintLoaded = true;
      return;
    }
    if (snap.exists()) {
      const data = snap.val();
      if (data && data.status === "success") {
        const userName = data.user || `Vân tay ID #${data.id || '1'}`;
        addLogToFirebase(`👆 Mở cửa thành công bằng Cảm biến vân tay`, userName);
      } else if (data && data.status === "failed") {
        addLogToFirebase(`⚠️ Quét vân tay không hợp lệ tại cửa`, "Cảm biến vân tay");
      }
    }
  });

  // G. Còi báo động
  database.ref('device/alarm/active').on('value', (snap) => {
    const active = snap.val() || false;
    isBuzzerActive = active;
    updateBuzzerUI(active);
    document.getElementById('securityAlertModal').style.display = active ? 'flex' : 'none';
  });

  // H. Nhật ký hoạt động Realtime
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
        <span>${log.actor}</span>
      `;
      logList.appendChild(div);
    });
  });
}

// ==========================================
// 7. QUẢN LÝ & QUÉT KHUÔN MẶT
// ==========================================
function encodeFirebaseKey(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function saveFaceToFirebase(personName, descriptorFloat32) {
  const key = encodeFirebaseKey(personName);
  const arr = Array.from(descriptorFloat32);
  return database.ref('faces/' + key).set({
    label: personName,
    descriptor: arr,
    createdAt: getFullDateTime()
  });
}

function renderRegisteredFacesUI() {
  const listEl = document.getElementById('registeredFaceList');
  const countEl = document.getElementById('faceCountText');
  if (!listEl) return;

  const names = Object.keys(faceDescriptorsDB);
  if (countEl) countEl.innerText = names.length;

  if (names.length === 0) {
    listEl.innerHTML = `<div style="font-size:11.5px; color:#dc2626; padding:4px;">Chưa có dữ liệu khuôn mặt nào.</div>`;
    return;
  }

  listEl.innerHTML = names.map(n => `
    <div class="face-item-row">
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

  renderRegisteredFacesUI();
  document.getElementById('faceManagerModal').style.display = 'flex';
}

function closeFaceManagerModal() {
  document.getElementById('faceManagerModal').style.display = 'none';
}

function startRegisterFirstOwnerFace() {
  if (!currentUser) return;
  closeFaceManagerModal();
  faceWorkflowMode = "register_owner";
  targetRegisterName = currentUser.name;
  runFaceScanModal(`Đăng ký Chủ nhà duy nhất: ${targetRegisterName}`);
}

function startAddMemberFaceWithOwnerVerify() {
  if (!ownerFaceName || !faceDescriptorsDB[ownerFaceName]) {
    alert("⚠️ Hệ thống chưa có Chủ nhà!");
    return;
  }
  closeFaceManagerModal();
  faceWorkflowMode = "verify_owner_for_add";
  runFaceScanModal(`Yêu cầu quét Khuôn mặt Chủ nhà (${ownerFaceName}) để cấp quyền thêm người mới`);
}

function startScanNewPersonStep() {
  const nameInput = document.getElementById('newFacePersonName');
  const newName = nameInput ? nameInput.value.trim() : "";
  if (!newName) {
    alert("⚠️ Vui lòng nhập họ tên người mới!");
    return;
  }
  if (faceDescriptorsDB[newName]) {
    alert("⚠️ Tên người này đã có trong CSDL khuôn mặt!");
    return;
  }
  closeFaceManagerModal();
  faceWorkflowMode = "register_member";
  targetRegisterName = newName;
  runFaceScanModal(`Đăng ký khuôn mặt mới cho: ${newName}`);
}

function startResetFacesWithOwnerVerify() {
  if (!ownerFaceName || !faceDescriptorsDB[ownerFaceName]) return;
  closeFaceManagerModal();
  faceWorkflowMode = "verify_owner_for_reset";
  runFaceScanModal(`Yêu cầu quét Khuôn mặt Chủ nhà (${ownerFaceName}) để XÓA toàn bộ Face ID`);
}

function triggerFaceIDUnlock() {
  if (!isESPOnline) {
    alert("⛔ Thiết bị ESP đang NGOẠI TUYẾN! Không thể thực hiện lệnh mở khóa.");
    return;
  }
  if (!isLocked) {
    alert("Cửa hiện tại đang mở sẵn!");
    return;
  }
  if (Object.keys(faceDescriptorsDB).length === 0) {
    alert("⚠️ Chưa có khuôn mặt nào! Vui lòng bấm 'Quản lý & Thêm Khuôn Mặt' để đăng ký Chủ nhà trước.");
    openFaceManagerModal();
    return;
  }
  faceWorkflowMode = "unlock";
  runFaceScanModal("Quét khuôn mặt để mở khóa cửa");
}

function requestChangeMasterPin() {
  if (!ownerFaceName || !faceDescriptorsDB[ownerFaceName]) {
    alert("⚠️ Chưa thiết lập Khuôn mặt Chủ nhà! Vui lòng đăng ký Face ID Chủ nhà trước khi đổi mật khẩu chung.");
    openFaceManagerModal();
    return;
  }
  faceWorkflowMode = "verify_owner_for_pin";
  runFaceScanModal(`Xác thực Khuôn mặt Chủ nhà (${ownerFaceName}) để đổi Mã PIN nhà chung`);
}

// ==========================================
// 8. THUẬT TOÁN FACE-API (EUCLIDEAN < 0.38)
// ==========================================
function setScannerMsg(text, status = 'warn') {
  const el = document.getElementById('scannerMsg');
  if (!el) return;
  el.innerText = text;
  el.className = 'scanner-msg ' + (status === 'error' ? 'error' : status === 'ok' ? 'ok' : '');
}

function setScannerDistance(text) {
  const el = document.getElementById('scannerDistance');
  if (el) el.innerText = text;
}

async function runFaceScanModal(subtitleText) {
  const sessionId = ++scanSessionId;
  const isRegisterMode = (faceWorkflowMode === 'register_owner' || faceWorkflowMode === 'register_member');
  registrationReady = !isRegisterMode;

  document.getElementById('scannerTargetText').innerText = subtitleText;
  setScannerMsg("🔄 Đang khởi động Camera...");
  setScannerDistance("Euclidean Distance: --- (Threshold: 0.38)");
  document.getElementById('faceScannerModal').style.display = 'flex';

  const videoEl = document.getElementById('webcamVideo');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
    });
    if (sessionId !== scanSessionId) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    cameraStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    if (isAiModelLoaded) {
      if (isRegisterMode) {
        startRegistrationCountdown(sessionId, targetRegisterName);
      }
      startRealtimeFaceRecognition(sessionId);
    } else {
      setScannerMsg("⚠️ Mô hình AI chưa tải xong, vui lòng đợi 3 giây...", "error");
    }
  } catch (err) {
    setScannerMsg("⚠️ Không thể mở Camera! Hãy cấp quyền Camera cho trình duyệt.", "error");
  }
}

function startRegistrationCountdown(sessionId, personName) {
  let sec = 3;
  registrationReady = false;
  setScannerMsg(`Mời [${personName}] nhìn vào camera! Quét sau ${sec}s...`);

  registrationCountdownTimer = setInterval(() => {
    if (sessionId !== scanSessionId) {
      clearInterval(registrationCountdownTimer);
      return;
    }
    sec--;
    if (sec > 0) {
      setScannerMsg(`Mời [${personName}] nhìn vào camera! Quét sau ${sec}s...`);
    } else {
      clearInterval(registrationCountdownTimer);
      registrationReady = true;
      setScannerMsg(`📸 Đang lấy mẫu khuôn mặt cho [${personName}]... Giữ yên!`);
    }
  }, 1000);
}

function findBestMatch(descriptor) {
  let bestName = null;
  let bestDistance = Infinity;
  for (const [name, stored] of Object.entries(faceDescriptorsDB)) {
    const dist = faceapi.euclideanDistance(descriptor, stored);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestName = name;
    }
  }
  return {
    name: bestDistance < FACE_MATCH_THRESHOLD ? bestName : null,
    distance: bestDistance,
    matched: bestDistance < FACE_MATCH_THRESHOLD
  };
}

async function startRealtimeFaceRecognition(sessionId) {
  const videoEl = document.getElementById('webcamVideo');
  const canvasEl = document.getElementById('faceOverlayCanvas');

  await new Promise((resolve) => {
    if (videoEl.readyState >= 2 && videoEl.videoWidth) resolve();
    else videoEl.onloadedmetadata = () => resolve();
  });
  if (sessionId !== scanSessionId) return;

  canvasEl.width = videoEl.videoWidth || 320;
  canvasEl.height = videoEl.videoHeight || 240;
  const displaySize = { width: canvasEl.width, height: canvasEl.height };
  faceapi.matchDimensions(canvasEl, displaySize);

  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
  let attempts = 0;
  let busy = false;
  let steadyFrames = 0;

  faceDetectionInterval = setInterval(async () => {
    if (busy || sessionId !== scanSessionId) return;
    busy = true;
    try {
      attempts++;
      const detection = await faceapi
        .detectSingleFace(videoEl, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (sessionId !== scanSessionId) return;

      const ctx = canvasEl.getContext('2d');
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

      if (detection) {
        const resized = faceapi.resizeResults(detection, displaySize);
        faceapi.draw.drawDetections(canvasEl, resized);
        steadyFrames++;

        if (faceWorkflowMode === 'register_owner' || faceWorkflowMode === 'register_member') {
          if (!registrationReady) {
            setScannerDistance("Đang đếm ngược chuẩn bị...");
          } else if (steadyFrames >= 3) {
            let duplicateName = null;
            let minDupDist = Infinity;
            for (const [name, stored] of Object.entries(faceDescriptorsDB)) {
              const dist = faceapi.euclideanDistance(detection.descriptor, stored);
              if (dist < minDupDist) minDupDist = dist;
              if (dist < FACE_MATCH_THRESHOLD) {
                duplicateName = name;
                break;
              }
            }

            if (duplicateName) {
              setScannerMsg(`⚠️ Khuôn mặt này đã được đăng ký cho [${duplicateName}]!`, "error");
              setScannerDistance(`Trùng khớp: ${duplicateName} (Distance: ${minDupDist.toFixed(3)} < 0.38)`);
            } else {
              setScannerMsg(`✅ Quét mẫu khuôn mặt thành công!`, "ok");
              stopFaceScanner();
              handleFaceScanSuccess(targetRegisterName, detection.descriptor);
              return;
            }
          }
        } else {
          const best = findBestMatch(detection.descriptor);
          const distStr = isFinite(best.distance) ? best.distance.toFixed(3) : "N/A";

          if (best.matched) {
            setScannerDistance(`Khớp: ${best.name} | Distance: ${distStr} (< 0.38)`);
            const mustBeOwner = [
              'verify_owner_for_add',
              'verify_owner_for_pin',
              'verify_owner_for_reset'
            ].includes(faceWorkflowMode);

            if (mustBeOwner && best.name !== ownerFaceName) {
              setScannerMsg(`⛔ Từ chối! Cần khuôn mặt Chủ nhà (${ownerFaceName}), hiện tại là: ${best.name}`, "error");
            } else {
              setScannerMsg(`✅ Đã xác thực: ${best.name}`, "ok");
              stopFaceScanner();
              handleFaceScanSuccess(best.name, detection.descriptor);
              return;
            }
          } else {
            setScannerMsg(`❌ Khuôn mặt chưa đăng ký trong hệ thống!`, "error");
            setScannerDistance(`Mặt lạ | Distance: ${distStr} (>= 0.38)`);
          }
        }
      } else {
        steadyFrames = 0;
        setScannerMsg("Hãy nhìn thẳng vào giữa khung Camera...");
      }

      if (attempts >= MAX_SCAN_ATTEMPTS) {
        stopFaceScanner();
        alert("⏰ Hết thời gian quét nhận diện khuôn mặt!");
        addLogToFirebase(`⚠️ Quét Face ID thất bại (Hết thời gian)`, currentUser ? currentUser.name : "Camera");
      }
    } catch (e) {
      console.error(e);
    } finally {
      busy = false;
    }
  }, SCAN_INTERVAL_MS);
}

function stopFaceScanner() {
  scanSessionId++;
  if (registrationCountdownTimer) {
    clearInterval(registrationCountdownTimer);
    registrationCountdownTimer = null;
  }
  if (faceDetectionInterval) {
    clearInterval(faceDetectionInterval);
    faceDetectionInterval = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('faceScannerModal').style.display = 'none';
}

function cancelFaceScanner() {
  stopFaceScanner();
}

async function handleFaceScanSuccess(personName, descriptor) {
  if (faceWorkflowMode === 'register_owner') {
    await database.ref('settings/ownerFaceName').set(personName);
    await saveFaceToFirebase(personName, descriptor);
    addLogToFirebase(`👑 Đã đăng ký Khuôn mặt Chủ nhà duy nhất`, personName);
    alert(`✅ Đã lưu khuôn mặt Chủ nhà duy nhất: ${personName}`);
    openFaceManagerModal();
  } else if (faceWorkflowMode === 'verify_owner_for_add') {
    addLogToFirebase(`🛡️ Chủ nhà đã xác thực Face ID để thêm người mới`, ownerFaceName);
    openFaceManagerModal();
    document.getElementById('faceMainActions').style.display = 'none';
    document.getElementById('faceStepAddNewSection').style.display = 'flex';
    document.getElementById('newFacePersonName').value = "";
    document.getElementById('newFacePersonName').focus();
  } else if (faceWorkflowMode === 'register_member') {
    await saveFaceToFirebase(personName, descriptor);
    addLogToFirebase(`📸 Đã thêm Face ID thành viên mới: ${personName}`, `Duyệt bởi Chủ nhà: ${ownerFaceName}`);
    alert(`✅ Đã lưu khuôn mặt mới cho: ${personName}`);
    openFaceManagerModal();
  } else if (faceWorkflowMode === 'verify_owner_for_pin') {
    addLogToFirebase(`🛡️ Chủ nhà xác thực Face ID mở quyền đổi Mã PIN chung`, ownerFaceName);
    document.getElementById('oldMasterPinInput').value = "";
    document.getElementById('newMasterPinInput').value = "";
    document.getElementById('changePinError').innerText = "";
    document.getElementById('changePinModal').style.display = 'flex';
  } else if (faceWorkflowMode === 'verify_owner_for_reset') {
    if (confirm("XÁC NHẬN: Xóa toàn bộ dữ liệu khuôn mặt và đặt lại Chủ nhà?")) {
      await database.ref('faces').remove();
      await database.ref('settings/ownerFaceName').remove();
      addLogToFirebase(`🗑️ Đã xóa sạch CSDL Face ID`, ownerFaceName);
      alert("Đã xóa toàn bộ dữ liệu khuôn mặt!");
      openFaceManagerModal();
    }
  } else if (faceWorkflowMode === 'unlock') {
    setLockState(false, `🔓 Mở cửa bằng Face ID (${personName})`, personName);
  }
}

// ==========================================
// 9. ĐỔI MÃ PIN & ĐIỀU KHIỂN KHÓA CỬA (RÀNG BUỘC TRỰC TUYẾN)
// ==========================================
function closeChangePinModal() {
  document.getElementById('changePinModal').style.display = 'none';
}

function submitNewMasterPin() {
  const oldPin = document.getElementById('oldMasterPinInput').value.trim();
  const newPin = document.getElementById('newMasterPinInput').value.trim();
  const errEl = document.getElementById('changePinError');

  if (oldPin !== masterPin) {
    errEl.innerText = "❌ Mã PIN hiện tại không đúng!";
    addLogToFirebase(`⚠️ Nhập sai mã PIN cũ khi đổi PIN nhà`, ownerFaceName);
    return;
  }
  if (!/^\d{4}$/.test(newPin)) {
    errEl.innerText = "⚠️ Mã PIN mới phải bao gồm đúng 4 chữ số!";
    return;
  }

  database.ref('settings/pin').set(newPin).then(() => {
    closeChangePinModal();
    addLogToFirebase(`🔑 Đã cập nhật Mã PIN vào nhà chung mới`, `Chủ nhà: ${ownerFaceName}`);
    alert("✅ Đã đổi Mã PIN vào nhà chung thành công!");
  });
}

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
  setLockState(true, `🔒 Đã khóa cửa thủ công trên App`, currentUser.name);
}

function setLockState(newLockedState, actionText, actorName) {
  isLocked = newLockedState;
  clearAutoLockTimer();
  updateUIState();
  addLogToFirebase(actionText, actorName);
  database.ref('device/isLocked').set(isLocked);

  if (!isLocked) {
    startAutoLockTimer();
  }
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
    alert("⛔ Thiết bị ESP đang NGOẠI TUYẾN! Không thể mở cửa bằng mã PIN lúc này.");
    return;
  }
  if (!isLocked) {
    alert("Cửa đang mở sẵn!");
    return;
  }
  if (isLockedOut) {
    alert("⛔ Đang tạm khóa bàn phím do nhập sai quá 3 lần!");
    return;
  }
  document.getElementById('pinUserDisplay').innerText = `Nhập Mã PIN Nhà Chung`;
  document.getElementById('pinModal').style.display = 'flex';
  clearPin();
}

function closePinModal() {
  document.getElementById('pinModal').style.display = 'none';
  clearPin();
}

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
      addLogToFirebase(`⚠️ Nhập sai Mã PIN vào nhà lần ${failedAttempts}`, currentUser.name);
      clearPin();
    }
  }
}

function triggerSecurityAlarm() {
  isLockedOut = true;
  const actor = currentUser ? currentUser.name : "Người dùng";
  document.getElementById('pinErrorText').innerText = "⛔ Sai 3 lần! Khóa 30s & Hú còi.";
  addLogToFirebase(`🚨 BÁO ĐỘNG: Kích hoạt còi hú! (Nhập sai PIN 3 lần)`, actor);
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
  const actor = currentUser ? currentUser.name : "Hệ thống";
  addLogToFirebase(`🔕 Đã tắt còi báo động khẩn cấp`, actor);
  database.ref('device/alarm/active').set(false);
  updateBuzzerUI(false);
}

function updateBuzzerUI(active) {
  const badge = document.getElementById('buzzerStatusBadge');
  if (!badge) return;
  if (active) {
    badge.className = 'buzzer-badge alarm';
    badge.innerHTML = '<i class="fa-solid fa-bell"></i> ĐANG HÚ CÒI!';
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
    if (relayLed) {
      relayLed.className = 'ind-led locked';
      relayLed.innerText = 'ĐANG KHÓA';
    }
  } else {
    lockBtn.className = 'btn-lock unlocked';
    lockIcon.className = 'fa-solid fa-unlock';
    lockBtnText.innerText = `BẤM ĐỂ KHÓA CỬA NGAY (${autoLockCountdown}s)`;
    stateTag.className = 'state-tag unlocked';
    stateTag.innerText = `CỬA ĐANG MỞ (${autoLockCountdown}s)`;
    if (relayLed) {
      relayLed.className = 'ind-led unlocked';
      relayLed.innerText = 'ĐANG MỞ';
    }
  }

  if (typeof update3DDoorState === 'function') {
    update3DDoorState(isLocked);
  }
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
  if (confirm("Xóa nhật ký hiển thị trên màn hình này?\n(Dữ liệu gốc trên Firebase vẫn được giữ nguyên và sẽ ghi lại lịch sử người xóa)")) {
    localClearedAt = Date.now();
    localStorage.setItem('smartLock_clearedAt', String(localClearedAt));

    database.ref('logs').push({
      timestamp: getFullDateTime(),
      message: `🧹 Đã xóa hiển thị nhật ký trên màn hình`,
      actor: currentUser.name,
      order: localClearedAt + 1
    });
  }
}
