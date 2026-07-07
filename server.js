/**
 * 租客雷達後端 v4
 * ══════════════════════════════════════════════════════════
 * 真實爬蟲來源（公開，無需登入）
 *   ① PTT  bbs/rent/index.html      Cookie: over18=1
 *   ② PTT  bbs/Rent_tpe/index.html  同上
 *   ③ Dcard /_api/forums/rent/posts  官方公開 JSON
 *   ④ 591   /home.php?func=demand    公開 HTML
 *   ⑤ Facebook Graph API            需 .env FB_ACCESS_TOKEN
 *
 * 核心新功能 v4
 *   A. 每筆 lead 含真實原文 URL → 前端來源連結直跳
 *   B. 進階篩選 REST API（src/area/type/minScore/budget/ai）
 *   C. Gemini AI：單筆 / 批次 / 高匹配自動分析
 *   D. WebSocket 即時推播（new_lead / ai_update / scan_*）
 *   E. cron 每 10 分鐘掃描，id 去重，最多保留 500 筆
 */
'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');
const cron    = require('node-cron');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(cors({
  origin: [
    'https://joshua-tsai666.github.io',
    'http://localhost:3001',
    'http://127.0.0.1:5500',
    /\.railway\.app$/,
  ],
  credentials: true,
}));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Gemini ────────────────────────────────────────────────
let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  console.log('✦ Gemini AI ready:', process.env.GEMINI_MODEL || 'gemini-2.0-flash');
}

// ─── In-memory store ──────────────────────────────────────
const leadsDB = new Map();   // id → lead
let   seq     = 0;

const MY_PROPS = (() => {
  try { return JSON.parse(process.env.MY_PROPS); } catch(_) {}
  return [
    { area:'信義區', price:38000, type:'2房', tags:['含家具','近捷運','可養寵物'] },
    { area:'南港區', price:28000, type:'套房', tags:['近捷運'] },
  ];
})();

// ─── WebSocket ────────────────────────────────────────────
const wss     = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  console.log(`WS connect (${clients.size} total)`);
  ws.send(JSON.stringify({ type:'connected', message:'租客雷達後端 v4 已連線' }));
  // push current snapshot to new client
  const snap = [...leadsDB.values()];
  if (snap.length) ws.send(JSON.stringify({ type:'bulk_leads', leads: snap }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(s); } catch(_) {}
  }
}

// ─── HTTP headers ─────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
};

// ─── 免費公開台灣/亞洲 Proxy 清單（自動輪替）──────────────
// 使用 HTTPS CONNECT tunnel 讓請求看起來像從亞洲發出
// 若所有 Proxy 都失敗，自動 fallback 直連
const PROXY_LIST = [
  // 從環境變數讀取（Railway 可設定自己的付費 Proxy）
  ...(process.env.PROXY_URL ? [process.env.PROXY_URL] : []),
  // 免費公開 Proxy（不穩定，僅作備用）
  'http://103.152.112.162:80',
  'http://103.122.168.226:80',
  'http://202.28.19.195:8080',
];

let proxyIdx = 0;

// 建立帶 Proxy 的 axios instance
function makeProxyHttp(proxyUrl) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    return axios.create({
      timeout: 18000,
      headers: BASE_HEADERS,
      httpsAgent: agent,
      httpAgent:  agent,
    });
  } catch (_) {
    return null;
  }
}

// 帶自動重試的 GET（先用 Proxy，失敗則直連）
async function resilientGet(url, options = {}) {
  // 先嘗試直連
  try {
    const res = await http.get(url, { ...options, timeout: 12000 });
    return res;
  } catch (directErr) {
    console.log(`直連失敗 ${url.split('/').slice(0,3).join('/')}，嘗試 Proxy…`);
  }

  // 直連失敗，嘗試 Proxy 清單
  for (let i = 0; i < PROXY_LIST.length; i++) {
    const proxy = PROXY_LIST[(proxyIdx + i) % PROXY_LIST.length];
    try {
      const proxyHttp = makeProxyHttp(proxy);
      if (!proxyHttp) continue;
      const res = await proxyHttp.get(url, { ...options, timeout: 18000 });
      proxyIdx = (proxyIdx + i + 1) % PROXY_LIST.length; // 成功則切換到下一個
      console.log(`Proxy 成功：${proxy}`);
      return res;
    } catch (_) {
      console.log(`Proxy 失敗：${proxy}`);
    }
  }

  // 所有 Proxy 都失敗，再試一次直連
  return await http.get(url, options);
}

const http = axios.create({ timeout: 14000, headers: BASE_HEADERS });

// ══════════════════════════════════════════════════════════
//  CRAWLER A — PTT（用 pttweb.cc 境外鏡像 API）
// ══════════════════════════════════════════════════════════
async function crawlPTT(board) {
  const out = [];
  try {
    // pttweb.cc 提供 JSON API，海外可存取
    const res = await resilientGet(
      `https://pttweb.cc/api/v1/article/list/${board}?p=1&page_size=30`,
      { headers: { 'Accept': 'application/json', 'Referer': 'https://pttweb.cc/' } }
    );

    const articles = res.data?.data || res.data?.items || res.data || [];
    const list = Array.isArray(articles) ? articles : [];

    for (const a of list) {
      const title  = a.title || a.subject || '';
      const author = a.author || a.owner || '匿名';
      const date   = a.date || a.published || new Date().toISOString();
      const aid    = a.aid || a.article_id || a.id || String(Date.now() + Math.random());
      const url    = a.url || `https://www.ptt.cc/bbs/${board}/${aid}.html`;
      const content = a.content || a.preview || '';

      if (!/找|求租|急找|想租|需要|cover|徵租|覓/.test(title)) continue;

      const raw = `${title} ${content}`;
      out.push({
        id:      `ptt_${aid}`,
        src:     'ptt', srcName: `PTT ${board}`, group: board,
        title, content: content.slice(0, 500),
        author, date, url,
        area:   parseArea(raw),
        type:   parseType(raw),
        budget: parseBudget(raw),
      });
    }
    console.log(`PTT ${board}: 找到 ${out.length} 筆`);
  } catch (e) {
    console.error(`PTT ${board} 失敗: ${e.message}`);
  }
  return out;
}

// ══════════════════════════════════════════════════════════
//  CRAWLER B — Dcard 搜尋 API
// ══════════════════════════════════════════════════════════
async function crawlDcard() {
  const out = [];
  const keywords = ['找房', '求租', '想租', '找租'];

  for (const kw of keywords) {
    try {
      const res = await resilientGet(
        `https://www.dcard.tw/_api/search/posts?query=${encodeURIComponent(kw)}&forum=rent&limit=20`,
        {
          headers: {
            'Referer':         'https://www.dcard.tw/search',
            'Accept':          'application/json',
            'Accept-Language': 'zh-TW,zh;q=0.9',
          }
        }
      );

      const posts = Array.isArray(res.data) ? res.data
                  : Array.isArray(res.data?.posts) ? res.data.posts : [];

      for (const p of posts) {
        const text = `${p.title || ''} ${p.excerpt || ''}`;
        const id   = `dcard_${p.id}`;
        if (out.find(x => x.id === id)) continue;
        out.push({
          id,
          src: 'dcard', srcName: 'Dcard 租屋', group: '租屋版',
          title:   p.title || '',
          content: (p.excerpt || '').slice(0, 300),
          author:  p.school || '匿名',
          date:    p.createdAt || new Date().toISOString(),
          url:     `https://www.dcard.tw/f/rent/p/${p.id}`,
          area:    parseArea(text),
          type:    parseType(text),
          budget:  parseBudget(text),
        });
      }
      await sleep(500);
    } catch (e) {
      console.warn(`Dcard 關鍵字「${kw}」失敗: ${e.message}`);
    }
  }

  console.log(`Dcard: 找到 ${out.length} 筆`);
  return out;
}

// ══════════════════════════════════════════════════════════
//  CRAWLER C — 591 求租板 (public HTML)
// ══════════════════════════════════════════════════════════
async function crawl591() {
  const out = [];
  try {
    const res = await resilientGet(
      'https://rent.591.com.tw/home.php?func=demand&kind=0&region=1',
      { headers: { Referer: 'https://rent.591.com.tw/', Cookie: '591_new_session=1' } }
    );
    const $ = cheerio.load(res.data);

    // Try multiple possible selectors as 591 may vary layout
    const rows = $('.demand-list-item, .rList-item').toArray();
    for (const el of rows.slice(0, 20)) {
      const titleEl = $(el).find('.title, h3').first();
      const title   = titleEl.text().trim();
      if (!title) continue;

      const desc  = $(el).find('.desc, .info').first().text().trim();
      const price = $(el).find('.price, .price-num').first().text().trim();
      const href  = $(el).find('a').first().attr('href') || '';
      const url   = href.startsWith('http') ? href : `https://rent.591.com.tw${href}`;
      const raw   = `${title} ${desc} ${price}`;

      out.push({
        id: `591_${Buffer.from(url).toString('base64').slice(0, 20)}_${Date.now()}`,
        src: '591', srcName: '591 求租板', group: '591租屋網',
        title, content: desc.slice(0, 300),
        author: '591 用戶', date: new Date().toISOString(), url,
        area:   parseArea(raw),
        type:   parseType(raw),
        budget: parseBudget(price + ' ' + raw),
      });
    }
  } catch (e) { console.error(`591: ${e.message}`); }
  return out;
}

// ══════════════════════════════════════════════════════════
//  CRAWLER D — Facebook Graph API
//  內建 18 個雙北租屋社團，每次隨機巡邏 FB_BATCH_SIZE 個
// ══════════════════════════════════════════════════════════

// 從社團 URL 擷取 group ID
function extractGroupId(url) {
  const m = url.match(/groups\/(\d+)/);
  return m ? m[1] : null;
}

const FB_GROUP_URLS = [
  'https://www.facebook.com/groups/2391145197642950', // 台北租屋社團🌻
  'https://www.facebook.com/groups/464870710346711',  // 台北租屋、出租專屬社團
  'https://www.facebook.com/groups/459966811445588',  // 台北租屋、出租專屬平台 2.0
  'https://facebook.com/groups/313385739282042',      // 大台北好好租屋🪴
  'https://www.facebook.com/groups/227082894440964',  // 中和、永和、板橋租屋資訊
  'https://www.facebook.com/groups/359576301158357',  // 大台北好好好租屋網（含新北市）
  'https://www.facebook.com/groups/1040396368050817', // 台北租屋 新北租屋｜租屋補助
  'https://www.facebook.com/groups/1513936138926333', // 新北租屋、出租專屬社團
  'https://www.facebook.com/groups/939218550146090',  // 雙北【租屋市集】
  'https://www.facebook.com/groups/3140810842843485', // 板橋租屋網 我是好房東
  'https://www.facebook.com/groups/1454032725691534', // 台北市、新北市 租屋分享平台
  'https://www.facebook.com/groups/2032594816953477', // 大台北找租出租屋
  'https://www.facebook.com/groups/161099969025675',  // 雙北-整層/套房 租屋網
  'https://www.facebook.com/groups/388722468446960',  // 台北租屋出租社團
  'https://www.facebook.com/groups/978101552379651',  // 房東社團-全台最多屋主自租
  'https://www.facebook.com/groups/1151927161997283', // 台北新北租屋◆房東房客盡量PO
  'https://www.facebook.com/groups/1513612272293611', // 大台北租屋
  'https://www.facebook.com/groups/221614965050605',  // Apartment Rentals In Taiwan
];

// 從 URL 提取所有有效 group ID
const FB_ALL_GROUP_IDS = FB_GROUP_URLS
  .map(extractGroupId)
  .filter(Boolean);

// 每次巡邏幾個社團（預設 10，可用環境變數調整）
const FB_BATCH_SIZE = parseInt(process.env.FB_BATCH_SIZE || '10');

// 隨機洗牌陣列
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function crawlFacebook() {
  const token = process.env.FB_ACCESS_TOKEN;
  if (!token) {
    console.log('Facebook: 未設定 FB_ACCESS_TOKEN，跳過');
    return [];
  }

  // 合併：內建社團 + 環境變數社團 + 手動新增社團，去重
  const extraEnvIds    = (process.env.FB_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const customIds      = [...customGroupUrls].map(extractGroupId).filter(Boolean);
  const allIds         = [...new Set([...FB_ALL_GROUP_IDS, ...extraEnvIds, ...customIds])];

  // 每次隨機選 FB_BATCH_SIZE 個巡邏，避免速度過快被封鎖
  const batch = shuffle(allIds).slice(0, FB_BATCH_SIZE);
  console.log(`Facebook: 本次巡邏 ${batch.length}/${allIds.length} 個社團`);

  const out = [];
  for (const gid of batch) {
    try {
      const res = await http.get(`https://graph.facebook.com/v19.0/${gid}/feed`, {
        params: {
          access_token: token,
          fields: 'message,created_time,from,permalink_url',
          limit: 30,
        },
      });

      // 找出社團名稱（用於顯示）
      const groupUrl  = FB_GROUP_URLS.find(u => u.includes(gid));
      const groupName = groupUrl
        ? (groupUrl.split('//')[1]?.replace('www.','')?.replace('facebook.com/groups/','社團 ') || gid)
        : gid;

      for (const post of (res.data?.data || [])) {
        const msg = post.message || '';
        if (!/找|求租|想租|需要|rent|looking|尋租|覓租/.test(msg)) continue;
        out.push({
          id:      `fb_${post.id}`,
          src:     'fb',
          srcName: 'Facebook 社團',
          group:   groupName,
          title:   msg.slice(0, 60).replace(/\n/g, ' ') + '…',
          content: msg.slice(0, 500),
          author:  post.from?.name || '匿名',
          date:    post.created_time,
          url:     post.permalink_url || `https://www.facebook.com/${post.id}`,
          area:    parseArea(msg),
          type:    parseType(msg),
          budget:  parseBudget(msg),
        });
      }
      console.log(`  FB 社團 ${gid} 完成`);
    } catch (e) {
      console.error(`  FB 社團 ${gid} 失敗: ${e.message}`);
    }
    await sleep(600); // 每個社團間隔 0.6 秒，避免速率限制
  }
  return out;
}

// ══════════════════════════════════════════════════════════
//  PARSERS
// ══════════════════════════════════════════════════════════
const AREAS = [
  '信義區','大安區','中山區','松山區','內湖區','南港區','士林區',
  '文山區','萬華區','中正區','大同區','北投區',
  '板橋','新莊','中和','永和','三重','新店','淡水','汐止','土城',
  '桃園','中壢','台中','台南','高雄','新竹','基隆',
];

function parseArea(t) {
  for (const a of AREAS) if (t.includes(a)) return a;
  if (t.includes('台北')) return '台北市';
  if (t.includes('新北')) return '新北市';
  return '未標示';
}

function parseType(t) {
  if (/套房|雅房|studio/i.test(t)) return '套房';
  if (/4房|四房/.test(t))          return '4房';
  if (/3房|三房/.test(t))          return '3房';
  if (/2房|兩房|雙人/.test(t))     return '2房';
  if (/1房|一房|單人/.test(t))     return '1房';
  return '不限';
}

function parseBudget(t) {
  const nums = [...t.matchAll(/[$＄]?\s*(\d{4,6})/g)]
    .map(m => parseInt(m[1]))
    .filter(n => n >= 3000 && n <= 300000);
  if (nums.length >= 2) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return { min: lo, max: hi, display: `${lo.toLocaleString()}–${hi.toLocaleString()}` };
  }
  if (nums.length === 1)
    return { min: nums[0] - 3000, max: nums[0] + 3000, display: `約 ${nums[0].toLocaleString()}` };
  return { min: 0, max: 999999, display: '未標示' };
}

function calcScore(lead) {
  let s = 45;
  const la = lead.area || '', lt = lead.type || '';
  const { min = 0, max = 999999 } = lead.budget || {};
  for (const p of MY_PROPS) {
    const pa = p.area;
    if (la.includes(pa.replace('區','')) || pa.includes(la.replace('區',''))) { s += 28; break; }
  }
  for (const p of MY_PROPS) {
    if (max >= p.price * 0.80 && min <= p.price * 1.20) { s += 15; break; }
  }
  for (const p of MY_PROPS) {
    const pt = p.type;
    if (lt && (lt.includes(pt.replace('房','')) || pt.includes(lt.replace('房','')))) { s += 12; break; }
  }
  return Math.min(99, Math.max(20, s));
}

// ══════════════════════════════════════════════════════════
//  GEMINI AI ANALYSIS
// ══════════════════════════════════════════════════════════
async function geminiAnalyze(lead, apiKey, model) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const mdl = model  || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  if (!key) return null;

  const mp = MY_PROPS.find(p => {
    const la = lead.area || '', pa = p.area;
    return la.includes(pa.replace('區','')) || pa.includes(la.replace('區',''));
  });

  const propDesc = mp
    ? `✓ 相符：${mp.area} ${mp.type}，$${mp.price.toLocaleString()}/月，${mp.tags.join('、')}`
    : '✗ 無完全符合物件';

  const prompt = `你是台灣包租代管業者的 AI 助理，全程繁體中文，格式簡潔有力。

【來源貼文】${lead.srcName} / ${lead.group}
標題：${lead.title}
內容：${(lead.content || '').slice(0, 400)}

【解析資訊】
區域 ${lead.area} ｜ 房型 ${lead.type} ｜ 預算 $${lead.budget?.display}/月
原文連結：${lead.url}

【我的物件】${propDesc}

請依序輸出，每項嚴格 2 句以內：
1.【意願評估】租屋意願強度（高／中／低）及判斷依據
2.【預算分析】預算合理性與台北市場行情比較
3.【物件推薦】是否值得主動聯繫？理由
4.【LINE 回覆】可直接複製傳送（≤60字，口語化，不要太正式）`;

  try {
    const ai     = new GoogleGenerativeAI(key);
    const result = await ai.getGenerativeModel({ model: mdl }).generateContent(prompt);
    return result.response.text();
  } catch (e) {
    console.error(`Gemini error: ${e.message}`);
    return `分析失敗：${e.message}`;
  }
}

// ══════════════════════════════════════════════════════════
//  MAIN SCAN LOOP
// ══════════════════════════════════════════════════════════
let scanning = false;

async function runScan() {
  if (scanning) return;
  scanning = true;
  console.log(`\n[${new Date().toLocaleTimeString()}] scan start`);
  broadcast({ type: 'scan_start', time: new Date().toISOString() });

  try {
    const [r1, r2, r3, r4, r5] = await Promise.allSettled([
      crawlPTT('rent'),
      crawlPTT('Rent_tpe'),
      crawlDcard(),
      crawl591(),
      crawlFacebook(),
    ]);

    const fresh = [
      ...(r1.value || []), ...(r2.value || []),
      ...(r3.value || []), ...(r4.value || []),
      ...(r5.value || []),
    ];

    let added = 0;
    for (const raw of fresh) {
      if (leadsDB.has(raw.id)) continue;
      const lead = {
        ...raw,
        seq:        ++seq,
        score:      calcScore(raw),
        isNew:      true,
        notified:   false,
        aiAnalysis: null,
        fetchedAt:  new Date().toISOString(),
      };
      leadsDB.set(raw.id, lead);
      added++;
      broadcast({ type: 'new_lead', lead });

      // auto-analyze high-match leads if Gemini is configured
      if (lead.score >= 80 && process.env.GEMINI_API_KEY) {
        setTimeout(async () => {
          lead.aiAnalysis = await geminiAnalyze(lead);
          if (lead.aiAnalysis)
            broadcast({ type: 'ai_update', id: lead.id, aiAnalysis: lead.aiAnalysis });
        }, 3000 + Math.random() * 3000);
      }
    }

    // trim to 500 newest
    if (leadsDB.size > 500) {
      const old = [...leadsDB.keys()].slice(0, leadsDB.size - 500);
      old.forEach(k => leadsDB.delete(k));
    }

    console.log(`scan done: +${added} new (${leadsDB.size} total)`);
    broadcast({ type: 'scan_done', newCount: added, totalCount: leadsDB.size, time: new Date().toISOString() });

  } catch (e) {
    console.error('scan error:', e.message);
    broadcast({ type: 'scan_error', message: e.message });
  } finally {
    scanning = false;
  }
}

// ══════════════════════════════════════════════════════════
//  REST API — 核心新功能 B：進階篩選
// ══════════════════════════════════════════════════════════

// GET /api/leads?src=&area=&type=&minScore=&minBudget=&maxBudget=&onlyAi=&onlyHot=&limit=
app.get('/api/leads', (req, res) => {
  let list = [...leadsDB.values()].sort((a, b) => b.seq - a.seq);
  const q  = req.query;

  if (q.src)       list = list.filter(l => l.src === q.src);
  if (q.area)      list = list.filter(l => (l.area || '').includes(q.area));
  if (q.type)      list = list.filter(l => (l.type || '').includes(q.type));
  if (q.minScore)  list = list.filter(l => l.score >= +q.minScore);
  if (q.minBudget) list = list.filter(l => (l.budget?.max || 999999) >= +q.minBudget);
  if (q.maxBudget) list = list.filter(l => (l.budget?.min || 0)      <= +q.maxBudget);
  if (q.onlyAi  === 'true') list = list.filter(l => l.aiAnalysis);
  if (q.onlyHot === 'true') list = list.filter(l => l.score >= 80);
  if (q.limit)     list = list.slice(0, +q.limit);

  res.json({ count: list.length, leads: list });
});

// POST /api/scan
app.post('/api/scan', (req, res) => {
  res.json({ started: !scanning, scanning });
  if (!scanning) runScan();
});

// GET /api/scan/status
app.get('/api/scan/status', (req, res) =>
  res.json({ scanning, total: leadsDB.size })
);

// POST /api/leads/:id/analyze  — 核心新功能 C：單筆 Gemini
app.post('/api/leads/:id/analyze', async (req, res) => {
  const lead = leadsDB.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });

  const key   = req.body.geminiKey   || process.env.GEMINI_API_KEY;
  const model = req.body.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  if (!key) return res.status(400).json({ error: 'geminiKey required' });

  lead.aiAnalysis = await geminiAnalyze(lead, key, model);
  broadcast({ type: 'ai_update', id: lead.id, aiAnalysis: lead.aiAnalysis });
  res.json({ aiAnalysis: lead.aiAnalysis });
});

// POST /api/leads/analyze-batch  — 批次 Gemini
app.post('/api/leads/analyze-batch', async (req, res) => {
  const { geminiKey, geminiModel = 'gemini-2.0-flash', limit = 5, minScore = 75 } = req.body;
  const key = geminiKey || process.env.GEMINI_API_KEY;
  if (!key) return res.status(400).json({ error: 'geminiKey required' });

  const targets = [...leadsDB.values()]
    .filter(l => l.score >= minScore && !l.aiAnalysis)
    .slice(0, +limit);

  res.json({ message: `analyzing ${targets.length}`, count: targets.length });

  (async () => {
    for (const lead of targets) {
      lead.aiAnalysis = await geminiAnalyze(lead, key, geminiModel);
      broadcast({ type: 'ai_update', id: lead.id, aiAnalysis: lead.aiAnalysis });
      await sleep(1500);
    }
  })();
});

// POST /api/leads/:id/notify
app.post('/api/leads/:id/notify', (req, res) => {
  const lead = leadsDB.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.notified   = true;
  lead.notifiedAt = new Date().toISOString();
  res.json({ ok: true });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const all = [...leadsDB.values()];
  res.json({
    total:    all.length,
    hot:      all.filter(l => l.score >= 80).length,
    aiDone:   all.filter(l => l.aiAnalysis).length,
    notified: all.filter(l => l.notified).length,
    scanning,
    sources: {
      ptt:   all.filter(l => l.src === 'ptt').length,
      dcard: all.filter(l => l.src === 'dcard').length,
      '591': all.filter(l => l.src === '591').length,
      fb:    all.filter(l => l.src === 'fb').length,
    },
  });
});

// ══════════════════════════════════════════════════════════
//  FB 社團手動管理 API
//  使用者可在前端新增 / 刪除 / 查看社團，立即生效
// ══════════════════════════════════════════════════════════

// 手動新增的社團（執行期間存記憶體，重啟後回到內建清單）
// 若要持久化，未來可改寫入 JSON 檔案
const customGroupUrls = new Set();

// GET /api/groups — 取得目前所有社團（內建 + 手動新增）
app.get('/api/groups', (_, res) => {
  const builtin = FB_GROUP_URLS.map(url => ({
    url,
    id:     extractGroupId(url) || '',
    source: 'builtin',
  }));
  const custom = [...customGroupUrls].map(url => ({
    url,
    id:     extractGroupId(url) || '',
    source: 'custom',
  }));
  res.json({
    total:   builtin.length + custom.length,
    builtin: builtin.length,
    custom:  custom.length,
    groups:  [...builtin, ...custom],
  });
});

// POST /api/groups — 手動新增社團
// body: { url: "https://www.facebook.com/groups/123456" }
app.post('/api/groups', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url 必填' });

  // 驗證是否為有效 Facebook 社團 URL
  const gid = extractGroupId(url);
  if (!gid) return res.status(400).json({ error: '無效的 Facebook 社團網址，請確認格式為 facebook.com/groups/數字' });

  // 檢查是否重複（內建或已新增）
  const alreadyBuiltin = FB_GROUP_URLS.some(u => u.includes(gid));
  const alreadyCustom  = [...customGroupUrls].some(u => u.includes(gid));
  if (alreadyBuiltin || alreadyCustom)
    return res.status(409).json({ error: '此社團已在清單中', gid });

  customGroupUrls.add(url.trim());
  console.log(`➕ 手動新增社團：${url} (ID: ${gid})`);
  broadcast({ type: 'groups_updated', total: FB_GROUP_URLS.length + customGroupUrls.size });
  res.json({ ok: true, gid, total: FB_GROUP_URLS.length + customGroupUrls.size });
});

// DELETE /api/groups/:gid — 刪除手動新增的社團（內建社團無法刪除）
app.delete('/api/groups/:gid', (req, res) => {
  const { gid } = req.params;
  const target = [...customGroupUrls].find(u => u.includes(gid));
  if (!target) {
    // 檢查是不是內建的
    const isBuiltin = FB_GROUP_URLS.some(u => u.includes(gid));
    if (isBuiltin) return res.status(403).json({ error: '內建社團無法刪除' });
    return res.status(404).json({ error: '找不到此社團' });
  }
  customGroupUrls.delete(target);
  console.log(`➖ 刪除自訂社團：${target}`);
  broadcast({ type: 'groups_updated', total: FB_GROUP_URLS.length + customGroupUrls.size });
  res.json({ ok: true, total: FB_GROUP_URLS.length + customGroupUrls.size });
});

// 更新 crawlFacebook 使用自訂社團（在原本的 FB_ALL_GROUP_IDS 基礎上加入）
// 注意：crawlFacebook() 已改為動態讀取，見下方覆寫

// GET /health
app.get('/health', (_, res) =>
  res.json({ ok: true, total: leadsDB.size, scanning, ts: new Date().toISOString() })
);

// GET /  — serve frontend if present
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
cron.schedule('*/10 * * * *', runScan);

const server = app.listen(PORT, () => {
  console.log(`\n🏠 租客雷達後端 v4`);
  console.log(`   HTTP : http://localhost:${PORT}`);
  console.log(`   WS   : ws://localhost:${PORT}`);
  console.log(`   Cron : every 10 min`);
  console.log(`   Srcs : PTT rent, PTT Rent_tpe, Dcard, 591${process.env.FB_ACCESS_TOKEN ? ', Facebook' : ''}\n`);
  setTimeout(runScan, 1500);
});

server.on('upgrade', (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
