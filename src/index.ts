#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AisClient, AisError, type Grade, type TimetableSlot } from "ntou-ais-api";
import { z } from "zod";

// 帳密跟 TronClass 是同一組，所以也接受 tronclass-mcp 的變數名稱
const username = process.env.AIS_USER ?? process.env.TRON_USER;
const password = process.env.AIS_PASS ?? process.env.TRON_PASS;
if (!username || !password) {
  console.error("請在 MCP server 的 env 設定 AIS_USER 與 AIS_PASS（或 TRON_USER 與 TRON_PASS）。");
  process.exit(1);
}

// 保存 session 的檔案，重啟後沿用以減少登入；設成空字串可停用
const sessionFile = process.env.AIS_SESSION_FILE ?? join(homedir(), ".config", "ntou-ais-mcp", "session.json");

const ais = new AisClient({ username, password, log: (m) => console.error(m) });
let savedSession: string | undefined;

// 還原上次保存的 session（同一個帳號才沿用）；檔案不存在或格式不對就照常登入
if (sessionFile) {
  try {
    const saved = JSON.parse(await readFile(sessionFile, "utf8"));
    if (saved.username === username && typeof saved.cookies === "string") {
      await ais.importSession(saved.cookies);
      savedSession = saved.cookies;
    }
  } catch {}
}

// session 有變動時寫回檔案；內容等同登入憑證，權限設為只有自己能讀
async function saveSession() {
  if (!sessionFile || !ais.isLoggedIn) return;
  try {
    const cookies = await ais.exportSession();
    if (cookies === savedSession) return;
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    const tmp = `${sessionFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ username, cookies }), { mode: 0o600 });
    await rename(tmp, sessionFile);
    savedSession = cookies;
  } catch (e) {
    console.error(`無法保存 session：${e instanceof Error ? e.message : e}`);
  }
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError && { isError: true }),
});

async function runTool<T>(op: () => Promise<T>): Promise<CallToolResult> {
  try {
    const value = await op();
    await saveSession();
    return text(JSON.stringify(value ?? null));
  } catch (e) {
    if (e instanceof AisError && e.code === "BAD_CREDENTIALS") {
      return text(
        `${e.message}。帳號或密碼錯誤時不會自動重試，以免帳號被鎖；請使用者確認 MCP server 設定的帳密後呼叫 login。`,
        true
      );
    }
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

// 成績、畢業資格這類很少變動、AIS 又回應較慢的查詢，在程序內暫存幾分鐘
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

const DAY_NAMES = ["", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
const NUMERALS = ["0", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"];
const periodIndex = (label: string) => NUMERALS.indexOf(/^第(.+)節$/.exec(label)?.[1] ?? "");

// 課表格子是一節一筆，合併成「同一天、同一門課、同一教室」的連續時段
function meetings(slots: TimetableSlot[]) {
  const sorted = [...slots].sort((a, b) => a.day - b.day || periodIndex(a.period) - periodIndex(b.period));
  type Block = {
    code: string;
    title: string;
    day: string;
    periods: string;
    start: string;
    end: string;
    room: string;
    pkno?: string;
    dayNum: number;
    lastIndex: number;
  };
  const out: Block[] = [];
  let last: Block | undefined;
  for (const s of sorted) {
    const i = periodIndex(s.period);
    if (last && last.dayNum === s.day && last.code === s.code && last.room === s.room && last.lastIndex === i - 1) {
      last.periods = `${last.periods.split("～")[0]}～${s.period}`;
      last.end = s.end;
      last.lastIndex = i;
      continue;
    }
    last = { code: s.code, title: s.title, day: DAY_NAMES[s.day], periods: s.period, start: s.start, end: s.end, room: s.room, pkno: s.pkno, dayNum: s.day, lastIndex: i };
    out.push(last);
  }
  return out.map(({ dayNum, lastIndex, ...m }) => m);
}

// 依學分加權的平均（只計有數字成績且學分大於 0 的課），僅供參考
function weightedAverage(list: Grade[]) {
  const scored = list.filter((g) => g.score !== null && (g.credits ?? 0) > 0);
  const credits = scored.reduce((s, g) => s + g.credits!, 0);
  if (!credits) return null;
  return Math.round((scored.reduce((s, g) => s + g.score! * g.credits!, 0) / credits) * 100) / 100;
}

const semesterArg = z
  .string()
  .regex(/^\d{2,3}[1-4]$/)
  .optional()
  .describe("學年期，學年加學期，例如 1151 是 115 學年度第 1 學期，3、4 是暑修；不填為目前學年期");

const instructions = `這個 server 用使用者本人的帳號查詢國立臺灣海洋大學教學務系統 AIS（課表、成績、缺曠、獎懲、畢業資格、開課資料與課綱），全部唯讀。

- 學年期寫成學年加學期，例如 1151 是 115 學年度第 1 學期（民國年），3、4 是暑修。
- 登入與驗證碼都由 server 自動處理，不需要使用者介入；第一次查詢或 session 過期時會多花幾秒登入。
- AIS 回應較慢，成績、課表一次查詢約需數秒，請避免為了同一個問題重複呼叫。
- 與 TronClass（課程平台）的分工：這裡查正式課表、上課時間與教室、學期成績與學分、缺曠、獎懲、畢業資格、全校開課資料與課綱；作業、教材、課程公告、線上考試、老師登記的作業與考試分數、討論區在 TronClass。兩邊的課程 ID 不通用，要用課名或課號對照。
- 成績、缺曠、獎懲屬於使用者的個人資料，只回答使用者本人的問題，不要轉述給其他人或寫進公開的地方。`;

const server = new McpServer({ name: "ais-ntou", version: "0.1.0" }, { instructions });

server.registerTool(
  "login",
  {
    title: "登入 AIS",
    description:
      "重新登入 AIS。平常不需要呼叫，其他 tool 會自動登入。只有之前因帳號或密碼錯誤而停止自動登入、使用者也已經改好 MCP server 的帳密設定時才呼叫；帳密錯誤時重複登入可能讓帳號被鎖。",
  },
  () =>
    runTool(async () => {
      ais.resetFailures();
      await ais.login();
      return "登入成功。";
    })
);

server.registerTool(
  "get_timetable",
  {
    title: "課表",
    description:
      "查詢某個學年期的個人課表與選課清單。courses 是選上的課（課號、課名、開課單位、班別、教師、學分、必選修）；meetings 是上課時段，已把同一天連續的節次合併，含星期、節次、起訖時間與教室。meetings 的 pkno 可以用 get_syllabus 查課綱。使用者問「我星期幾有什麼課」「這學期修了哪些課」「某堂課在哪間教室」時使用。課程的作業、教材與公告不在這裡，在 TronClass。",
    inputSchema: { semester: semesterArg },
    annotations: { readOnlyHint: true },
  },
  ({ semester }) =>
    runTool(async () => {
      const t = await cached(`timetable:${semester ?? ""}`, () => ais.timetable(semester));
      return { semester: t.semester, courses: t.courses, meetings: meetings(t.slots) };
    })
);

server.registerTool(
  "get_grades",
  {
    title: "成績",
    description:
      "查詢學校正式的學期成績。不指定 semester 時回傳歷年全部成績。每筆含學年期、課號、課名、學分、必選修、教師、成績與狀態（passed 及格、failed 不及格、pending 成績未到、withdrawn 期中退選、credited 抵免）。total_credits 是 AIS 上的歷年累計學分（含暑修及抵免）；by_semester 的 weighted_average 是依學分加權的估算值，不是學校公布的平均或排名。課堂上的作業與考試分數請查 TronClass。",
    inputSchema: { semester: semesterArg.describe("只看某個學年期，例如 1142；不填為歷年全部") },
    annotations: { readOnlyHint: true },
  },
  ({ semester }) =>
    runTool(async () => {
      const g = await cached("grades", () => ais.grades());
      const list = semester ? g.grades.filter((x) => x.semester === semester) : g.grades;
      const semesters = [...new Set(list.map((x) => x.semester))];
      return {
        student: g.student,
        total_credits: g.totalCredits,
        by_semester: semesters.map((s) => {
          const rows = list.filter((x) => x.semester === s);
          return {
            semester: s,
            credits_taken: rows.reduce((n, x) => n + (x.credits ?? 0), 0),
            credits_passed: rows.filter((x) => x.status === "passed" || x.status === "credited").reduce((n, x) => n + (x.credits ?? 0), 0),
            weighted_average: weightedAverage(rows),
          };
        }),
        grades: list,
      };
    })
);

server.registerTool(
  "get_absences",
  {
    title: "缺曠紀錄",
    description:
      "查詢本學期的缺曠課紀錄：缺曠總節數與每筆明細。只能查目前學年期，沒有紀錄時 records 是空的。請假紀錄不在這裡。",
    annotations: { readOnlyHint: true },
  },
  () => runTool(() => cached("absences", () => ais.absences()))
);

server.registerTool(
  "get_conduct",
  {
    title: "操行與獎懲",
    description:
      "查詢目前的操行成績與獎懲紀錄（嘉獎、記功、警告、記過等）。沒有獎懲紀錄時 records 是空的。",
    annotations: { readOnlyHint: true },
  },
  () => runTool(() => cached("conduct", () => ais.conduct()))
);

server.registerTool(
  "get_graduation_check",
  {
    title: "畢業資格",
    description:
      "查詢 AIS 的畢業資格頁：依循學年度、各類科目應修學分、各類別的必修科目（哪個學期、科目、學分）、學分統計表與教務處初審／複審結果。注意：「已得學分」「未通過學分」等欄位是教務處審查後才有的結果，還沒審查時會全是 0 或等於應修學分，不代表使用者真的沒有學分。要估算畢業進度，請再呼叫 get_grades，用已及格的課對照這裡的必修科目與應修學分，並向使用者說明這是估算。",
    annotations: { readOnlyHint: true },
  },
  () => runTool(() => cached("graduation", () => ais.graduation()))
);

server.registerTool(
  "search_courses",
  {
    title: "查詢開課資料",
    description:
      "查詢全校某個學年期的開課資料，可以依課名、課號或授課教師搜尋。每筆含課號、課名、開課單位、年級班別、教師、學分、必選修、修課人數與人數上下限。使用者想找某門課有哪些班、誰教、還有沒有名額時使用。課綱用 get_syllabus 以課號與班別查詢。",
    inputSchema: {
      keyword: z.string().min(1).describe("關鍵字：課名、課號或教師姓名"),
      by: z.enum(["title", "code", "teacher"]).optional().describe("依 title（課名，預設）、code（課號）或 teacher（教師）查詢"),
      exact: z.boolean().optional().describe("完全相符，預設 false（模糊比對）"),
      semester: semesterArg,
      page: z.number().int().min(1).optional().describe("頁數，預設 1"),
      page_size: z.number().int().min(1).max(100).optional().describe("每頁筆數，預設 30"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ keyword, by, exact, semester, page, page_size }) =>
    runTool(() => ais.searchCourses({ keyword, by, exact, semester, page, pageSize: page_size }))
);

server.registerTool(
  "get_syllabus",
  {
    title: "課綱",
    description:
      "查詢課程的課綱：教學目標、先修科目、教材內容、教學進度、評量方式、參考書目、上課時間與教室等。可以用 get_timetable 回傳的 pkno 查；或用 course_code 查，同一課號有多個班時要再給 class_name（例如「3年A班」或「3A」），沒給會回傳可選的班別。",
    inputSchema: {
      pkno: z.string().regex(/^\d+$/).optional().describe("課綱編號，來自 get_timetable 的 meetings"),
      course_code: z.string().optional().describe("課號，例如 B5703660"),
      class_name: z.string().optional().describe("年級班別，例如「3年A班」或「3A」"),
      semester: semesterArg,
    },
    annotations: { readOnlyHint: true },
  },
  ({ pkno, course_code, class_name, semester }) =>
    runTool(async () => {
      if (pkno) return ais.syllabus(pkno);
      if (course_code) return ais.syllabusByCode(course_code, { semester, className: class_name });
      throw new Error("請提供 pkno 或 course_code。");
    })
);

await server.connect(new StdioServerTransport());
console.error("ntou-ais-mcp 已啟動");
