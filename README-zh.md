# 10x-chat

> 透過瀏覽器自動化，從終端機與網頁 AI 助手（ChatGPT、Gemini、Claude、Grok、Perplexity、DeepSeek）對話。

[English](./README.md) | **繁體中文**

10x-chat 透過 Playwright 驅動**經過修補的 Chromium**（[CloakBrowser](https://www.npmjs.com/package/cloakbrowser)），並保存登入設定。只需登入一次，即可從 CLI 或 AI 編碼助手發送提示——自動附帶檔案內容。

## 搭配 OpenClaw 使用

將以下連結貼到 [OpenClaw](https://openclaw.ai) 聊天中即可安裝為技能：

```
https://raw.githubusercontent.com/gazon1/10x-chat/refs/heads/main/skills/10x-chat/SKILL.md
```

## 先決條件

| 需求     | 版本                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| Node.js  | ≥ 22（或 Bun ≥ 1.3）                                                                  |
| 作業系統 | Linux x86_64/arm64、macOS arm64/x86_64、Windows x86_64（CloakBrowser 的支援平台矩陣） |
| 顯示器   | 僅有介面模式需要——ChatGPT、Claude 與 Perplexity 預設就是有介面模式                    |

不需要系統層的 Chromium：套件的 `postinstall` 步驟會將 CloakBrowser 的建置版本下載到 `~/.cloakbrowser/`。

## 安裝

```bash
npm install -g --install-links github:gazon1/10x-chat
```

安裝時會建置 CLI（`prepare`）並下載 CloakBrowser 的建置版本（`postinstall`）。下面所有範例都使用全域安裝的 `10x-chat` 執行檔。

> [!IMPORTANT]
> npm 11 需要 `--install-links`。npm 會把帶建置腳本的 git 相依安裝成指向暫存 clone 的**符號連結**，事後又刪掉該 clone，結果全域安裝變成懸空連結。加上這個旗標，npm 會改成複製已經建置好的套件。若想沿用原本的指令，先設定一次：
>
> ```bash
> npm config set install-links true --location=user
> ```
>
> 若不做全域安裝，可直接從原始碼執行：`npx github:gazon1/10x-chat chat -p "…"`（Bun 需要先執行 `bun pm -g untrusted`，否則會擋下建置腳本）。
>
> npm 11.20+ 還會在套件被信任前略過下載 CloakBrowser 建置版本的 `postinstall`：安裝指令加上 `--allow-scripts=10x-chat`，或手動執行一次 `npx cloakbrowser install`。

> [!NOTE]
> npm 上的名稱 `10x-chat` 屬於上游專案，而上游仍帶著這個分支已移除的整合。因此這個分支是從儲存庫安裝的——尚未發佈到套件庫。

## 快速開始

```bash
# 1. 登入提供者（會開啟瀏覽器視窗）
10x-chat login chatgpt

# 2. 發送提示
10x-chat chat -p "解釋這個錯誤" --provider chatgpt --file "src/**/*.ts"

# 3. 檢視工作階段歷史
10x-chat status
```

> [!TIP]
> Bun 啟動 CLI 更快：在原始碼副本中用 `bun run src/bin/cli.ts …`，已發佈的套件則用 `bunx`。

## 瀏覽器執行環境

執行環境是 **CloakBrowser（經過修補的 Chromium）**——沒有其他受支援的引擎。

Firefox/Camoufox 曾經評估過但被否決：遷移會讓所有提供者選擇器失效（它們都是針對 Chromium 寫的）、隱蔽腳本偽造的是 Chromium 專屬的 API，而且 Camoufox 無法攜帶帶有憑證的 SOCKS 代理。完整的量測見
[docs/refactor-3-8-camoufox.md](docs/refactor-3-8-camoufox.md) 與
[docs/refactor-4-9-camoufox-production-readiness.md](docs/refactor-4-9-camoufox-production-readiness.md)。

## 代理

代理只來自環境變數——沒有設定項目，也沒有 CLI 參數，因為共用的瀏覽器 daemon 是獨立行程，會繼承啟動它的那次呼叫的環境。

```bash
HTTPS_PROXY=http://user:password@proxy.example:3128 10x-chat chat -p "…"
NO_PROXY=localhost,127.0.0.1                              10x-chat chat -p "…"
```

| 代理                                   | 是否支援                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| `http://` / `https://` 不含憑證        | 是                                                           |
| `http://` 搭配 Basic 認證              | 是——憑證交給 Playwright，瀏覽器只看到不含憑證的代理網址      |
| `socks5://` 不含憑證                   | 是                                                           |
| `socks4://` / `socks5://` **搭配**憑證 | **否**——不支援，因為 Chromium 必須透過命令列中的網址進行認證 |

完整契約（環境變數的順序、憑證放在哪裡、為什麼拒絕帶憑證的 SOCKS）見 [docs/config-contract.md](docs/config-contract.md)。

## 登入與工作階段

`login` 會開啟有介面的瀏覽器，等待提供者回報已登入的工作階段，並把 Cookie 存入瀏覽器設定檔。預設的**共用**設定檔模式下，所有提供者使用同一個設定檔（`~/.10x-chat/profiles/default/storage-state.json`），因此每個提供者只需登入一次，並行執行也能共用。

```bash
10x-chat login chatgpt      # 單一提供者
10x-chat login --all        # 逐一登入所有提供者
10x-chat login --all --tabs # 以同一個視窗的分頁登入所有提供者
10x-chat login --status     # 檢查所有提供者的登入狀態
```

- `--isolated-profile` 讓每個提供者使用自己的設定檔（`~/.10x-chat/profiles/<provider>`），`--profile <name>` 則使用具名設定檔。
- `migrate` 會把舊的各提供者設定檔合併進共用設定檔。
- 每次執行都會寫入自己的工作階段（`meta.json`、`bundle.md`、`response.md`）到 `~/.10x-chat/sessions/<uuid>/`；`status` 會列出來，`session <id>` 會顯示其中一筆。

## 指令

### `login <provider>`

開啟有界面的瀏覽器供您驗證身份。工作階段會跨次執行保留。

```bash
10x-chat login chatgpt       # 登入 ChatGPT
10x-chat login gemini         # 登入 Gemini
10x-chat login claude         # 登入 Claude
10x-chat login grok           # 登入 Grok
10x-chat login perplexity     # 登入 Perplexity
10x-chat login deepseek       # 登入 DeepSeek
10x-chat login --status       # 檢查所有提供者的登入狀態
```

### `chat`

透過瀏覽器自動化向 AI 提供者發送提示。

```bash
10x-chat chat -p "檢查這段程式碼的錯誤" --provider chatgpt --file "src/**/*.ts"
10x-chat chat -p "除錯這個錯誤" --file "logs/error.log"
10x-chat chat -p "解釋一下" --dry-run              # 預覽打包內容但不發送
10x-chat chat -p "解釋一下" --copy                  # 將打包內容複製到剪貼簿
10x-chat chat -p "長時間任務" --timeout 600000 --headed  # 10 分鐘逾時，顯示瀏覽器
```

| 參數                      | 說明                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-p, --prompt <text>`     | **（必填）** 要發送的提示                                                                                                   |
| `--provider <name>`       | 提供者：`chatgpt`、`gemini`、`claude`、`grok`、`perplexity`、`deepseek`（預設：設定檔）                                     |
| `--all`                   | 並行發送給所有對話型提供者並比較答案                                                                                        |
| `--model <name>`          | 要在提供者 UI 中選擇的模型/模式（例如 ChatGPT：`GPT-5.6 Sol High`、`Pro`；Gemini：`Fast`、`Thinking`、`Deep Think`、`Pro`） |
| `-f, --file <paths...>`   | 要作為上下文打包的檔案/glob 模式                                                                                            |
| `-a, --attach <paths...>` | 要以附件形式上傳的圖片/檔案                                                                                                 |
| `--copy`                  | 將打包內容複製到剪貼簿而不發送                                                                                              |
| `--dry-run`               | 預覽打包內容但不發送                                                                                                        |
| `--headed`                | 在聊天期間顯示瀏覽器視窗                                                                                                    |
| `--headless`              | 強制無介面，連一般需要介面的提供者也一樣                                                                                    |
| `--timeout <ms>`          | 回應逾時（毫秒，預設：300000）                                                                                              |
| `--save-images <dir>`     | 將產生的圖片儲存到指定目錄                                                                                                  |
| `--profile <name>`        | 使用具名的瀏覽器設定檔                                                                                                      |
| `--isolated-profile`      | 使用各提供者專屬的瀏覽器設定檔                                                                                              |

### `delegate <provider>`

為需要多步驟控制（而非單次一發提示）的外部 AI 呼叫者啟動特定提供者的 JSONL delegate。Delegate 會開啟一次提供者、保持分頁存活，然後從 stdin 讀取 JSON 指令並將 JSON 回應寫到 stdout。

```bash
# 以 JSONL 控制的單一長期提供者工作階段
10x-chat delegate gemini --model Pro <<'EOF'
{"id":1,"action":"status"}
{"id":2,"action":"submit","prompt":"Draft three launch angles for this product."}
{"id":3,"action":"capture","timeoutMs":600000}
{"id":4,"action":"close"}
EOF

# 便利的合併動作：選擇模型/檔案、提交、擷取
printf '%s\n' '{"action":"chat","model":"Thinking","prompt":"Review this pasted plan."}' \
  | 10x-chat delegate gemini
```

支援的動作：`status`、`goto`、`selectModel`、`attach`、`submit`、`capture`、`chat`、`eval`、`close`。

| 參數                 | 說明                           |
| -------------------- | ------------------------------ |
| `--model <name>`     | 開啟後立即選擇模型/模式        |
| `--headed`           | 顯示瀏覽器視窗                 |
| `--timeout <ms>`     | 預設的擷取逾時                 |
| `--isolated-profile` | 使用各提供者專屬的瀏覽器設定檔 |
| `--no-login-check`   | 即使登入偵測失敗也仍然啟動     |

### `image`

透過 ChatGPT（DALL-E）、Gemini（Imagen）或 Grok 產生圖片，並以非阻塞輪詢等待結果。

```bash
10x-chat image -p "太空中的狐狸太空人，數位藝術" --provider chatgpt
10x-chat image -p "水彩風景畫" --provider gemini --save-dir ./images
10x-chat image -p "標誌設計" --provider grok --headed --timeout 120000
```

| 參數                  | 說明                                                 |
| --------------------- | ---------------------------------------------------- |
| `-p, --prompt <text>` | **（必填）** 圖片生成提示                            |
| `--provider <name>`   | 提供者：`chatgpt`、`gemini`、`grok`（預設：chatgpt） |
| `--headed`            | 顯示瀏覽器視窗                                       |
| `--timeout <ms>`      | 生成逾時（預設：120000）                             |
| `--save-dir <dir>`    | 儲存生成圖片的目錄                                   |

### `research`

透過 ChatGPT、Gemini 或 Perplexity 進行深度研究，並以非阻塞輪詢回報進度。適合長時間研究任務（5-10 分鐘以上）。

```bash
10x-chat research -p "量子計算的最新突破" --provider gemini
10x-chat research -p "高難度技術研究" --provider gemini --model "Deep Think"
10x-chat research -p "電動車市場分析" --provider chatgpt --model "Extra High" --timeout 900000
10x-chat research -p "比較 2026 年的 React 與 Vue" --provider perplexity --save-dir ./reports
```

| 參數                   | 說明                                                      |
| ---------------------- | --------------------------------------------------------- |
| `-p, --prompt <text>`  | **（必填）** 研究問題                                     |
| `--provider <name>`    | 提供者：`chatgpt`、`gemini`、`perplexity`（預設：gemini） |
| `--model <name>`       | 可選，在開始研究前要選擇的模型/模式                       |
| `--headed`             | 顯示瀏覽器視窗                                            |
| `--timeout <ms>`       | 總逾時（預設：600000／10 分鐘）                           |
| `--poll-interval <ms>` | 進度檢查間隔（預設：5000）                                |
| `--save-dir <dir>`     | 儲存研究報告的目錄                                        |

#### ChatGPT 深度研究

ChatGPT 深度研究是從輸入框的 `+`（`Add files and more`）選單中選擇，並在送出提示前以作用中的 `Deep research` 標籤確認。模型／思考層級則另外從輸入框的模型標籤（`Instant`、`Medium`、`High`、`Extra High`、`Pro`）與 GPT 系列子選單（`GPT-5.6 Sol`、`GPT-5.5`、`GPT-5.4`、`GPT-5.3`、`o3`）選擇。兩者可以合併在單一 `--model` 中，例如 `--model "GPT-5.6 Sol High"`。詳見 [`docs/chatgpt-deep-research.md`](docs/chatgpt-deep-research.md)。

### `history`

列出各提供者側邊欄可見的聊天歷史（ChatGPT、Gemini、Claude、Grok、Perplexity）。

```bash
10x-chat history --provider gemini
10x-chat history --provider all --limit 10
10x-chat history --provider chatgpt --json
```

| 參數                | 說明                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `--provider <name>` | 提供者：`chatgpt`、`gemini`、`claude`、`grok`、`perplexity`、`deepseek` 或 `all`（預設：all） |
| `--limit <n>`       | 每個提供者最多列出幾筆（預設：20）                                                            |
| `--headed`          | 顯示瀏覽器視窗                                                                                |
| `--json`            | 輸出 JSON                                                                                     |

### `status`

列出本機 10x-chat CLI 工作階段。

```bash
10x-chat status              # 最近 24 小時
10x-chat status --hours 72   # 最近 3 天
```

### `session <id>`

檢視特定工作階段的詳細資訊。

```bash
10x-chat session <id> --render   # 格式化輸出回應
```

### `config`

檢視或修改設定。

```bash
10x-chat config show
10x-chat config set provider gemini
10x-chat config set timeout 600000
10x-chat config set headless false
10x-chat config set profile-mode isolated
```

設定的優先順序（CLI 參數 > 設定檔 > 預設值）、設定檔規則與代理契約記載於
[docs/config-contract.md](docs/config-contract.md)。

### `skill`

管理代理整合技能（適用於 Codex、Claude Code 等）。

```bash
10x-chat skill install   # 安裝 SKILL.md 到 ~/.codex/skills/
10x-chat skill show      # 顯示 SKILL.md 內容
```

### `migrate`

把舊的各提供者獨立瀏覽器設定檔合併進預設使用的單一共用設定檔。從每個提供者各自存放設定檔的版本升級時相當實用。

```bash
10x-chat migrate --dry-run            # 預覽而不變更
10x-chat migrate                      # 自動挑選最大的設定檔作為基底
10x-chat migrate --source chatgpt     # 以特定提供者的設定檔作為基底
10x-chat migrate --keep               # 遷移後保留舊的獨立設定檔
```

## 檔案打包

`--file` 參數接受 glob 模式。檔案會組裝成 Markdown 打包內容作為提示發送：

```bash
10x-chat chat -p "檢查這些檔案" --file "src/**/*.ts" "!src/**/*.test.ts"
```

安全敏感檔案（`.env*`、`*.pem`、`*.key` 等）會自動排除。

## 資料目錄結構

```
~/.10x-chat/
├── profiles/
│   ├── default/             # 共用設定檔（預設）：storage-state.json
│   └── <provider>/          # 獨立或具名設定檔
├── sessions/
│   └── <uuid>/
│       ├── meta.json        # 工作階段中繼資料
│       ├── bundle.md        # 發送的提示打包
│       └── response.md      # 擷取的回應
├── debug/                   # 除錯產物（僅在 TEN_X_CHAT_BROWSER_DEBUG=1 時產生）
├── browser-daemon.json      # 共用瀏覽器 daemon 的狀態
└── config.json              # 使用者設定
```

`TEN_X_CHAT_HOME` 可移動整個目錄。

## 代理整合

10x-chat 內附 `SKILL.md` 供 AI 編碼助手使用。安裝方式：

```bash
10x-chat skill install
```

這讓 Codex 或 Claude Code 等助手可以使用 10x-chat 查詢其他模型，進行交叉驗證、程式碼審查或除錯協助。

## 支援的提供者

| 提供者     | 狀態           | 模型                                        | 網址              |
| ---------- | -------------- | ------------------------------------------- | ----------------- |
| ChatGPT    | ✅ 對話 + 圖片 | —                                           | chatgpt.com       |
| Gemini     | ✅ 對話 + 圖片 | Fast、**Thinking**（預設）、Deep Think、Pro | gemini.google.com |
| Claude     | ✅ 對話        | —                                           | claude.ai         |
| Grok       | ✅ 對話 + 圖片 | —                                           | grok.com          |
| Perplexity | ✅             | —                                           | perplexity.ai     |
| DeepSeek   | ✅             | deepseek-chat、deepseek-reasoner            | chat.deepseek.com |

提供者的 UI 隨時可能改變——其中 Grok 尤其脆弱。某個提供者突然沒有回應，通常是選擇器改變了，而不是登入失效。

## 疑難排解

| 症狀                                              | 處理方式                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `CloakBrowser is not installed or failed to load` | 重新執行 `npm install -g --install-links github:gazon1/10x-chat`，或執行 `npx cloakbrowser install`             |
| 瀏覽器無法啟動／沒有視窗                          | 缺少建置版本：執行 `npx cloakbrowser install`（會落在 `~/.cloakbrowser/`）                    |
| 已登入卻出現 `Not logged in`                      | 工作階段已過期——再次執行 `10x-chat login <provider>`；`login --status` 會顯示每個提供者的狀態 |
| 即使 headless，ChatGPT／Perplexity 仍開啟視窗     | 兩者都被反機器人防護阻擋，一律以有介面模式執行；`--headless` 可強制覆寫                       |
| daemon 被其他工作階段佔用                         | 另一次執行佔用了共用瀏覽器——等待它結束，或使用 `--isolated-profile`                           |
| `SOCKS proxy authentication is not supported…`    | 改用帶憑證的 HTTP 代理，或不含憑證的 SOCKS 代理                                               |
| `Invalid config file …`                           | 設定檔已損毀——這是錯誤而非後援機制；請修正或刪除 `~/.10x-chat/config.json`                    |

### 除錯產物

設定 `TEN_X_CHAT_BROWSER_DEBUG=1` 後，每次瀏覽器操作都會把產物寫入 `~/.10x-chat/debug/<timestamp>-<provider>-<operation>/`：

```
meta.json       # 操作、網址與耗時
events.json     # 主控台訊息、頁面錯誤、失敗的請求
screenshot.png  # 頁面截圖
page.html       # 頁面原始碼
```

這些產物已做遮蔽處理：每個網址的 userinfo、Cookie、權杖與機器的家目錄都會被移除——可以安全地附在錯誤回報中。

## 開發

```bash
bun install
bun run dev login chatgpt      # 以開發模式執行 CLI
bun run typecheck               # 型別檢查
bun run lint                    # 程式碼檢查
bun run test                    # 執行測試
bun run test:e2e                # 端對端情境（CLI 流程；實際連線提供者的情境需另外啟用）
bun run build                   # 建置正式版本
```

實際連線提供者的情境需要瀏覽器與已登入的設定檔：

```bash
TEN_X_CHAT_E2E_PROVIDERS=1 bun run test:e2e                 # 所有提供者
TEN_X_CHAT_E2E_PROVIDERS=gemini,deepseek bun run test:e2e   # 只有這些
```

最近一次完整檢查的結果——以及刻意記載的例外——見 [docs/verification.md](docs/verification.md)。

## 發佈

發佈透過 GitHub Actions 自動化。推送版本標籤即可發佈：

```bash
npm version patch   # 或 minor / major
git push --follow-tags
```

需要在 GitHub 儲存庫設定中配置 `NPM_TOKEN` 密鑰。

> [!NOTE]
> 套件庫上的名稱 `10x-chat` 屬於上游專案，因此發佈工作流程中的 `npm publish` 步驟目前是停用的——推送 `v*` 標籤會建立 GitHub Release，但不會發佈到套件庫。需要先選定一個可用的名稱——待辦項目列於 [docs/verification.md](docs/verification.md)。

## 免責聲明

本專案**僅供研究與教育用途**。它會自動化網頁介面，這些介面可能受各服務供應商的
服務條款約束。您須自行負責使用方式，包括遵守任何適用條款，並自行承擔使用風險。

## 授權

MIT © Mike Chong（上游）——此分支由 gazon1 維護。詳見 [LICENSE](./LICENSE)。
