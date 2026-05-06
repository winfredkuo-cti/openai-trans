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
const maxFileSizeMb = Number(window.MAX_FILE_MB || 4);
const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;

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
    const data = await readResponse(resp);
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

function formatSrtTimestamp(seconds) {
  let totalMs = Math.round(Number(seconds || 0) * 1000);
  const hours = Math.floor(totalMs / 3600000);
  totalMs %= 3600000;
  const minutes = Math.floor(totalMs / 60000);
  totalMs %= 60000;
  const secs = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function buildSrt(segments) {
  if (!Array.isArray(segments)) return "";
  const lines = [];
  let index = 1;
  for (const segment of segments) {
    const text = String(segment.text || "").trim();
    if (!text) continue;
    lines.push(String(index));
    lines.push(`${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end ?? segment.start)}`);
    lines.push(text);
    lines.push("");
    index += 1;
  }
  return lines.join("\n").trim() + "\n";
}

function getAudioMinutes(payload) {
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  let maxEnd = 0;
  for (const segment of segments) {
    maxEnd = Math.max(maxEnd, Number(segment.end || 0));
  }
  if (!maxEnd) {
    maxEnd = Number(payload.duration || 0);
  }
  return Math.max(0, maxEnd / 60);
}

function parseWorkerPayload(payload) {
  const text = String(payload.text || "").trim();
  let srt = String(payload.srt || "").trim();
  if (!srt) {
    srt = buildSrt(payload.segments || []);
  }
  if (!text) {
    throw new Error("辨識完成但沒有取得文字內容。");
  }
  if (!srt) {
    srt = `1\n00:00:00,000 --> 00:00:10,000\n${text}\n`;
  }
  return {
    text,
    srt: srt.endsWith("\n") ? srt : `${srt}\n`,
    usedMinutes: getAudioMinutes(payload),
  };
}

function buildWorkerFormData({ file, model, language, responseFormat, mode }) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", model);
  if (mode === "response_format") {
    formData.append("response_format", responseFormat);
  }
  if (mode === "format") {
    formData.append("format", "json");
    formData.append("output_format", "json");
  }
  if (language !== "auto") {
    formData.append("language", language);
  }
  if (language === "zh") {
    formData.append("prompt", "請使用繁體中文（台灣用字）輸出。");
  }
  return formData;
}

async function postToWorker(workerUrl, formData) {
  try {
    return await fetch(workerUrl, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    throw new Error("無法連線到轉寫服務，請確認 Worker 已允許網站直接上傳。");
  }
}

async function transcribeWithWorker({ workerUrl, file, model, language, responseFormat, label }) {
  const attempts = ["simple", "response_format", "format"];
  let lastDetail = "";

  for (const mode of attempts) {
    const formData = buildWorkerFormData({
      file,
      model,
      language,
      responseFormat,
      mode,
    });
    const response = await postToWorker(workerUrl, formData);
    const data = await readResponse(response);
    if (response.ok) {
      return parseWorkerPayload(data);
    }
    lastDetail = data.detail || `Worker 回應異常（${response.status}）`;
  }

  throw new Error(`${label} 辨識失敗：${lastDetail}`);
}

async function refreshMe() {
  const resp = await fetch("/api/me");
  const data = await readResponse(resp);
  setUserInfo(data.user);
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  if (response.status === 413 || text.toLowerCase().includes("request ent")) {
    throw new Error(`檔案太大，請壓縮或切成 ${maxFileSizeMb}MB 以下再上傳。`);
  }
  if (!response.ok) {
    return { detail: text || `伺服器回應異常（${response.status}）` };
  }
  throw new Error(text || `伺服器回應異常（${response.status}）`);
}

async function handleGoogleLogin(credential) {
  const resp = await fetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  const data = await readResponse(resp);
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
  const data = await readResponse(resp);
  if (!resp.ok) {
    adminStatus.textContent = data.detail || `更新失敗（${resp.status}）`;
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
    setStatus(`檔案過大，請控制在 ${maxFileSizeMb}MB 內。`);
    return;
  }

  submitBtn.disabled = true;
  txtBtn.disabled = true;
  srtBtn.disabled = true;
  setStatus("辨識中，請稍候...");

  try {
    const optionsResponse = await fetch("/api/transcribe/options");
    const options = await readResponse(optionsResponse);
    if (!optionsResponse.ok) {
      throw new Error(options.detail || "無法開始辨識");
    }

    const [txtResult, srtResult] = await Promise.all([
      transcribeWithWorker({
        workerUrl: options.worker_url,
        file,
        model: options.txt_model,
        language,
        responseFormat: "json",
        label: "TXT",
      }),
      transcribeWithWorker({
        workerUrl: options.worker_url,
        file,
        model: options.srt_model,
        language,
        responseFormat: "verbose_json",
        label: "SRT",
      }),
    ]);

    const completeResponse = await fetch("/api/transcribe/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: txtResult.text,
        srt: srtResult.srt,
        language,
        used_minutes: Math.max(txtResult.usedMinutes, srtResult.usedMinutes),
      }),
    });
    const data = await readResponse(completeResponse);
    if (!completeResponse.ok) {
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
