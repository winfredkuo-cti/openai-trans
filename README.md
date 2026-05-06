# 語音辨識 TXT / SRT 網站

## 功能
- 僅上傳音訊檔案後進行語音辨識
- 顯示辨識文字內容
- 下載 `transcript.txt`
- 下載 `subtitle.srt`（可直接拿去影片上字幕）
- 可指定音檔語言：繁體中文、英文、日文、韓文，或自動辨識
- Google 登入後才能使用
- 每位使用者預設 30 分鐘額度
- 管理者（預設 `theoder@gmail.com`）可調整每位使用者分鐘數
- 支援雲端資料庫（`DATABASE_URL`，建議 Postgres）

## 啟動方式
1. 建立虛擬環境並安裝套件
   ```bash
   python3 -m venv .venv
   ```
   ```bash
   .venv/bin/pip install -r requirements.txt
   ```
2. 設定 Worker 轉寫端點（可選，預設是 `https://speech-transcribe-worker.theoder.workers.dev`）
   ```bash
   export WORKER_TRANSCRIBE_URL="https://speech-transcribe-worker.theoder.workers.dev"
   ```
3. 設定 Google 登入 Client ID（必要）
   ```bash
   export GOOGLE_CLIENT_ID="你的 Google Web Client ID"
   ```
4. （可選）管理者帳號、Session 金鑰
   ```bash
   export ADMIN_EMAIL="theoder@gmail.com"
   export SESSION_SECRET="請改成隨機長字串"
   ```
5. 設定雲端資料庫（正式環境強烈建議）
   ```bash
   export DATABASE_URL="postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME"
   ```
6. （可選）若 Worker 不可用，可改用伺服器端 API Key
   ```bash
   export OPENAI_API_KEY="你的金鑰"
   ```
7. 啟動
   ```bash
   .venv/bin/uvicorn app.main:app --reload --port 8000
   ```
8. 開啟瀏覽器：`http://127.0.0.1:8000`

## 備註
- 網頁不顯示 API Key 欄位，金鑰可完全留在 Worker 或伺服器環境變數。
- 上傳限制為音檔：`mp3`、`wav`、`m4a`。
- 預設單檔上限為 `25MB`，可用 `MAX_AUDIO_FILE_MB` 調整。
- TXT 固定使用 `gpt-4o-mini-transcribe`，SRT 固定使用 `whisper-1`。
- 若已知音檔語言，建議在上傳前指定語言，可讓語音辨識更快速。
- 系統不保留辨識檔案，請立即下載 TXT / SRT。
- 若未設定 `DATABASE_URL`，系統會回退使用本機 `app.db`（僅適合開發測試）。

## Vercel 部署
1. 將此資料夾推到 GitHub。
2. 在 Vercel 匯入該 repo（Framework 可選 Other）。
3. 在 Vercel 專案設定 `Environment Variables` 新增：
   - `DATABASE_URL`
   - `GOOGLE_CLIENT_ID`
   - `SESSION_SECRET`
   - `ADMIN_EMAIL`
   - `WORKER_TRANSCRIBE_URL`
4. 在 Google OAuth 用戶端加入正式網域到 `Authorized JavaScript origins`，例如：
   - `https://你的專案.vercel.app`
5. 重新部署。
