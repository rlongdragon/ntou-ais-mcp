# ntou-ais-mcp

國立臺灣海洋大學教學務系統 AIS（`https://ais.ntou.edu.tw`）的非官方 MCP server。接上 Claude Code、Claude Desktop 等 MCP client 後，可以直接用對話查課表、成績、缺曠、操行與獎懲、畢業資格、開課資料與課綱。全部唯讀，不會改動 AIS 上的資料。

> 本專案不是海大官方的工具，也未受其委託或背書。AIS 改版時部分功能可能暫時失效。

## 可以做什麼

- 「我星期三有什麼課？在哪間教室？」
- 「上學期成績如何？有沒有被當？」
- 「我這學期缺曠幾節？操行成績多少？」
- 「離畢業還差哪些必修？」
- 「作業系統這學期有幾個班？誰教的？評分方式是什麼？」

## 架構

```
MCP client（Claude Code / Claude Desktop）
        │  stdio
        ▼
ntou-ais-mcp   ← 本專案：把查詢包成 MCP tool、整理輸出、保存 session
        │  import
        ▼
ntou-ais-api   ← 登入（本機辨識驗證碼）、session、各頁面的解析（https://github.com/rlongdragon/ntou-ais-api）
        │  HTTPS
        ▼
ais.ntou.edu.tw
```

## 快速開始

需要 Node.js 20.6 以上（用到 `--env-file`）。

### 1. 安裝與建置

```bash
git clone https://github.com/rlongdragon/ntou-ais-mcp.git
cd ntou-ais-mcp
npm install
npm run build
```

ntou-ais-api 會從 GitHub 安裝，安裝時透過它的 `prepare` script 自動 build。若 npm 顯示 `allow-scripts` 警告，而且 `node_modules/ntou-ais-api/dist` 不存在，請執行 `npm approve-scripts ntou-ais-api` 後重新 `npm install`。

### 2. 設定帳密

帳密放在本機的設定檔，只有自己讀得到：

```bash
mkdir -p ~/.config/ntou-ais-mcp
install -m 600 /dev/null ~/.config/ntou-ais-mcp/.env
nano ~/.config/ntou-ais-mcp/.env
```

```
AIS_USER=你的學號
AIS_PASS=你的密碼
```

AIS 與 TronClass 是同一組帳密。已經在用 [tronclass-mcp](https://github.com/rlongdragon/tronclass-mcp) 的話，可以直接指向 `~/.config/tronclass-mcp/.env`，server 也接受 `TRON_USER`、`TRON_PASS`。

### 3. 接上 MCP client

**Claude Code**：

```bash
claude mcp add -s user ais -- node --env-file=$HOME/.config/ntou-ais-mcp/.env /絕對路徑/ntou-ais-mcp/dist/index.js
```

**Claude Desktop**：在 `claude_desktop_config.json` 的 `mcpServers` 加入：

```json
{
  "mcpServers": {
    "ais": {
      "command": "node",
      "args": ["--env-file=/home/你/.config/ntou-ais-mcp/.env", "/絕對路徑/ntou-ais-mcp/dist/index.js"]
    }
  }
}
```

### 環境變數

| 變數 | 說明 |
|---|---|
| `AIS_USER`（或 `TRON_USER`） | 學號（必填） |
| `AIS_PASS`（或 `TRON_PASS`） | 密碼（必填） |
| `AIS_SESSION_FILE` | 選填，保存 session 的檔案，預設 `~/.config/ntou-ais-mcp/session.json`；設成空字串可停用 |

## Tools

學年期寫成學年加學期，例如 `1151` 是 115 學年度第 1 學期，`3`、`4` 是暑修。

| Tool | 說明 |
|---|---|
| `get_timetable(semester?)` | 個人課表與選課清單；上課時段已合併連續節次 |
| `get_grades(semester?)` | 學期成績（不指定為歷年）、歷年累計學分、各學期修課與及格學分、學分加權平均（估算） |
| `get_absences` | 本學期缺曠總節數與明細 |
| `get_conduct` | 目前操行成績與獎懲紀錄 |
| `get_graduation_check` | 畢業資格：應修學分、必修科目、學分統計、教務處審查結果 |
| `search_courses(keyword, by?, exact?, semester?, page?, page_size?)` | 依課名、課號或教師查詢開課資料 |
| `get_syllabus(pkno? \| course_code, class_name?, semester?)` | 課綱 |
| `login` | 帳密錯誤停止自動登入、改好帳密後重新登入（平常不需要） |

- `get_graduation_check` 的「已得學分」等欄位是教務處審查後才有，還沒審查時都是 0，不代表沒有學分；tool 描述會提示模型改用成績對照必修科目估算。
- 成績、課表、畢業資格等查詢結果在 server 內暫存 5 分鐘，避免重複查詢 AIS。

## 登入

- 登入由 ntou-ais-api 處理：AIS 沒有接學校的 CAS，每次登入都要驗證碼，會在本機用 OCR 模型自動辨識，不需要使用者或模型介入。
- 驗證碼錯誤會自動換一張重試；帳號或密碼錯誤**不會**重試，以免帳號被鎖。
- session 會保存到 `~/.config/ntou-ais-mcp/session.json`（權限 600），重開 MCP client 後直接沿用，過期時才重新登入。
- AIS 不允許同一個帳號同時登入兩處，server 登入時會把其他地方（例如瀏覽器）的 AIS 登出。

## 隱私

- 帳密只存在本機的設定檔，只會送往 `ais.ntou.edu.tw`。
- session 檔內容等同登入憑證，請勿分享。
- 所有請求都直接從你的電腦送到學校，沒有經過其他服務；查詢結果會交給你使用的 MCP client 與模型處理。
- log 只寫到 stderr，不會記錄密碼（登入成功時會記錄學號）。

## 限制

- AIS 回應較慢，成績、課表一次查詢約需數秒。
- 缺曠只能查目前學年期。
- 只測試過大學部學生帳號。
- 不提供選課、請假等寫入功能。

## 開發

```
src/index.ts   MCP server 與所有 tool
```

新增功能時，先在 ntou-ais-api 加方法，再到這裡註冊 tool。server 不能寫入 stdout（stdio 傳輸使用中），log 請用 `console.error`。

## 授權

MIT。國立臺灣海洋大學的名稱與相關資料之權利屬各自權利人。
