const form = document.getElementById("transcribe-form");
const statusEl = document.getElementById("status");
const resultText = document.getElementById("resultText");
const txtBtn = document.getElementById("downloadTxt");
const srtBtn = document.getElementById("downloadSrt");
const submitBtn = document.getElementById("submitBtn");
const userInfoEl = document.getElementById("userInfo");
const logoutBtn = document.getElementById("logoutBtn");
const adminPanel = document.getElementById("adminPanel");
const adminForm = document.getElementById("admin-form");
const adminStatus = document.getElementById("adminStatus");
const adminUsersBody = document.getElementById("adminUsersBody");
const refreshUsersBtn = document.getElementById("refreshUsersBtn");
const allowedAudioExtensions = new Set([".mp3", ".wav", ".m4a"]);
const maxFileSizeBytes = 25 * 1024 * 1024;

let latestTxt = "";
let latestSrt = "";
let currentUser = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function setUserInfo(user) {
  currentUser = user;
  if (!user) {
    userInfoEl.textContent = "請先使用 Google 登入";
    logoutBtn.hidden = true;
    submitBtn.disabled = true;
    adminPanel.hidden = true;
    renderAdminUsers([]);
    return;
  }
  userInfoEl.textContent = `${user.name}（${user.email}）剩餘 ${user.remaining_minutes} 分鐘`;
  logoutBtn.hidden = false;
  submitBtn.disabled = false;
  adminPanel.hidden = !user.is_admin;
  if (user.is_admin) {
    loadAdminUsers();
  } else {
    renderAdminUsers([]);
  }
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderAdminUsers(users) {
  if (!adminUsersBody) return;
  if (!users.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "目前沒有使用者";
    row.appendChild(cell);
    adminUsersBody.replaceChildren(row);
    return;
  }
  const rows = [];
  for (const user of users) {
    const row = document.createElement("tr");
    const values = [
      user.name || "",
      user.email || "",
      user.remaining_minutes,
      user.is_admin ? "管理者" : "使用者",
      formatDateTime(user.updated_at),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    rows.push(row);
  }
  adminUsersBody.replaceChildren(...rows);
}

async function loadAdminUsers() {
  if (!currentUser?.is_admin) return;
  renderAdminMessage("載入中...");
  try {
    const resp = await fetch("/api/admin/users");
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "載入使用者失敗");
    }
    renderAdminUsers(data.users || []);
  } catch (error) {
    renderAdminMessage(error.message);
  }
}

function renderAdminMessage(message) {
  if (!adminUsersBody) return;
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.textContent = message;
  row.appendChild(cell);
  adminUsersBody.replaceChildren(row);
}

function isAllowedAudioFile(file) {
  const filename = (file.name || "").toLowerCase();
  const extension = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
  return allowedAudioExtensions.has(extension);
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function refreshMe() {
  const resp = await fetch("/api/me");
  const data = await resp.json();
  setUserInfo(data.user);
}

async function handleGoogleLogin(credential) {
  const resp = await fetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.detail || "Google 登入失敗");
  }
  setUserInfo(data.user);
}

window.handleCredentialResponse = async (response) => {
  try {
    await handleGoogleLogin(response.credential);
    setStatus("登入成功，現在可以開始辨識。");
  } catch (error) {
    setStatus(`登入失敗：${error.message}`);
  }
};

window.addEventListener("load", async () => {
  await refreshMe();
  if (!window.GOOGLE_CLIENT_ID) {
    setStatus("伺服器尚未設定 GOOGLE_CLIENT_ID。");
    return;
  }
  google.accounts.id.initialize({
    client_id: window.GOOGLE_CLIENT_ID,
    ux_mode: "redirect",
    login_uri: `${window.location.origin}/api/auth/google/redirect`,
    use_fedcm_for_button: true,
    use_fedcm_for_prompt: true,
  });
  google.accounts.id.renderButton(document.getElementById("googleBtn"), { theme: "outline", size: "large" });
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  setUserInfo(null);
  setStatus("已登出。");
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetEmail = document.getElementById("targetEmail").value.trim();
  const targetMinutes = document.getElementById("targetMinutes").value.trim();
  const formData = new FormData();
  formData.append("email", targetEmail);
  formData.append("minutes", targetMinutes);
  const resp = await fetch("/api/admin/set-minutes", {
    method: "POST",
    body: formData,
  });
  const data = await resp.json();
  if (!resp.ok) {
    adminStatus.textContent = data.detail || "更新失敗";
    return;
  }
  adminStatus.textContent = `${data.user.email} 已更新為 ${data.user.remaining_minutes} 分鐘`;
  await loadAdminUsers();
});

refreshUsersBtn.addEventListener("click", loadAdminUsers);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fileInput = document.getElementById("audioFile");
  const language = document.getElementById("language").value;
  const file = fileInput.files?.[0];

  if (!file) {
    setStatus("請先選擇檔案。");
    return;
  }
  if (!isAllowedAudioFile(file)) {
    setStatus("只支援音檔格式（mp3/wav/m4a）。");
    return;
  }
  if (file.size > maxFileSizeBytes) {
    setStatus("檔案過大，請控制在 25MB 內。");
    return;
  }

  submitBtn.disabled = true;
  txtBtn.disabled = true;
  srtBtn.disabled = true;
  setStatus("辨識中，請稍候...");

  const formData = new FormData();
  formData.append("file", file);
  formData.append("language", language);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "辨識失敗");
    }

    latestTxt = data.text || "";
    latestSrt = data.srt || "";
    resultText.value = latestTxt;
    txtBtn.disabled = !latestTxt;
    srtBtn.disabled = !latestSrt;
    if (currentUser) {
      currentUser.remaining_minutes = data.remaining_minutes;
      setUserInfo(currentUser);
    }
    setStatus(`辨識完成，已使用 ${data.used_minutes} 分鐘，可下載 TXT 與 SRT。`);
  } catch (error) {
    setStatus(`發生錯誤：${error.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

txtBtn.addEventListener("click", () => {
  if (!latestTxt) return;
  downloadFile("transcript.txt", latestTxt, "text/plain;charset=utf-8");
});

srtBtn.addEventListener("click", () => {
  if (!latestSrt) return;
  downloadFile("subtitle.srt", latestSrt, "text/plain;charset=utf-8");
});
