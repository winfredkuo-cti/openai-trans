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
    return;
  }
  userInfoEl.textContent = `${user.name}（${user.email}）剩餘 ${user.remaining_minutes} 分鐘`;
  logoutBtn.hidden = false;
  submitBtn.disabled = false;
  adminPanel.hidden = !user.is_admin;
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
    callback: handleCredentialResponse,
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
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fileInput = document.getElementById("audioFile");
  const model = document.getElementById("model").value;
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
  formData.append("model", model);

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
