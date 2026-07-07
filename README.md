# 🏠 租客雷達 v4

> 自動在 PTT、Dcard、591 上尋找有租屋需求的租客，透過 Gemini AI 分析後即時推播給您。

---

## ✨ 功能

| 功能 | 說明 |
|------|------|
| 📡 真實爬蟲 | PTT rent/Rent_tpe、Dcard 租屋版、591 求租板、Facebook 社團 |
| 🔗 來源連結直跳 | 每筆需求直接連回原始貼文，立即聯繫租客 |
| 🔍 進階篩選 | 依區域、房型、預算、匹配度過濾 |
| ✦ Gemini AI 分析 | 意願評估、預算分析、推薦物件、自動生成 LINE 回覆訊息 |
| 📲 即時推播 | WebSocket 新需求即時通知，支援瀏覽器桌面通知 |
| ⏱ 自動排程 | 每 10 分鐘掃描一次，24 小時不間斷 |

---

## 🚀 快速部署（Railway）

### 第一步：Fork 這個 Repository

點擊右上角 **Fork** 按鈕，複製到您的 GitHub 帳號。

### 第二步：在 Railway 建立新專案

1. 前往 [railway.app](https://railway.app) 並以 GitHub 登入
2. 點擊 **New Project** → **Deploy from GitHub repo**
3. 選擇您 Fork 的 `tenant-radar` repository
4. Railway 會自動偵測並開始部署

### 第三步：設定環境變數

在 Railway Dashboard → 您的服務 → **Variables** 頁籤，新增以下變數：

| 變數名稱 | 說明 | 必填 |
|----------|------|------|
| `GEMINI_API_KEY` | Gemini AI 金鑰，[免費取得](https://aistudio.google.com/app/apikey) | ✅ 必填 |
| `GEMINI_MODEL` | 填入 `gemini-2.0-flash` | ✅ 必填 |
| `MY_PROPS` | 您的物件 JSON（見下方範例） | ✅ 必填 |
| `FB_ACCESS_TOKEN` | Facebook Graph API Token | 選填 |
| `FB_GROUP_IDS` | Facebook 社團 ID，逗號分隔 | 選填 |

**MY_PROPS 範例（修改成您自己的物件）：**
```json
[{"area":"信義區","price":38000,"type":"2房","tags":["含家具","近捷運"]},{"area":"南港區","price":28000,"type":"套房","tags":["近捷運"]}]
```

### 第四步：取得您的網址

部署完成後，Railway 會提供一個網址，例如：
```
https://tenant-radar-production.up.railway.app
```

### 第五步：連接前端

開啟 `tenant-radar.html`，在右側「後端伺服器」欄位填入 Railway 給的網址，點擊「連線」即可開始接收真實數據。

---

## 💻 本機開發

```bash
# 1. 安裝依賴
npm install

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env 填入您的金鑰

# 3. 啟動後端
node server.js

# 4. 開啟前端
# 直接用瀏覽器開啟 tenant-radar.html
```

後端啟動後預設在 `http://localhost:3001`。

---

## 📁 檔案結構

```
tenant-radar/
├── server.js           # 後端：爬蟲 + Gemini AI + WebSocket
├── tenant-radar.html   # 前端：儀表板介面
├── package.json        # Node.js 依賴
├── railway.toml        # Railway 部署設定
├── .env.example        # 環境變數範本（可上傳）
├── .env                # 真實金鑰（不可上傳，已在 .gitignore）
└── .gitignore          # Git 忽略清單
```

---

## 🔌 API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/health` | 健康檢查 |
| `GET` | `/api/leads` | 取得租客需求列表（支援篩選） |
| `POST` | `/api/scan` | 手動觸發掃描 |
| `GET` | `/api/stats` | 統計數字 |
| `POST` | `/api/leads/:id/analyze` | 單筆 Gemini AI 分析 |
| `POST` | `/api/leads/analyze-batch` | 批次 AI 分析 |
| `WS` | `/` | WebSocket 即時推播 |

**GET /api/leads 篩選參數：**
```
?src=ptt          來源（ptt/dcard/591/fb）
&area=信義區      區域
&type=2房         房型
&minScore=75      最低匹配度
&minBudget=20000  最低預算
&maxBudget=50000  最高預算
&onlyAi=true      只看 AI 已分析
&onlyHot=true     只看高匹配
&limit=20         筆數限制
```

---

## ⚠️ 注意事項

- **PTT、Dcard** 為公開平台，無需任何金鑰即可爬取
- **591** 為公開 HTML，無需登入
- **Facebook** 需要 Graph API Token，申請需時約 1–2 週
- `.env` 檔案絕對不能上傳 GitHub，已加入 `.gitignore`
- Railway 免費方案每月有 500 小時執行時間，足夠個人使用

---

## 📜 授權

MIT License — 自由使用、修改、部署
