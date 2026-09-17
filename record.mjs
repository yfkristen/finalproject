/* 把 index.html 的自動導覽（錄影版）錄成影片檔
 *
 *   node record.mjs [輸入.html] [輸出.mp4]
 *
 * 做法：用無頭 Chromium 播放一次，透過 CDP 螢幕串流逐格擷取畫面，
 * 再依每格的實際時間戳重組成等速影片。
 *
 * 為什麼不用 Playwright 內建的錄影：它把位元率寫死在 1 Mbps，
 * 1080p 的中文字會糊成一團。這裡改成 8 Mbps（或 H.264 CRF 20）。
 *
 * 環境變數：W/H 解析度、FPS 輸出幀率、HUD=1 保留播放列、KEEP=1 保留逐格圖
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/* playwright 可能裝在專案裡，也可能是全域安裝 */
const require = createRequire(import.meta.url);
function loadPlaywright(){
  for (const id of ['playwright', 'playwright-core',
                    '/opt/node22/lib/node_modules/playwright']) {
    try { return require(id); } catch {}
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return require(join(root, 'playwright'));
  } catch {}
  throw new Error('找不到 playwright，請先執行：npm i -D playwright');
}
const { chromium } = loadPlaywright();

const SRC = resolve(process.argv[2] || 'index.html');
const OUT = resolve(process.argv[3] || 'demo.mp4');
const W = Number(process.env.W || 1920), H = Number(process.env.H || 1080);
const FPS = Number(process.env.FPS || 30);
const HIDE_HUD = process.env.HUD !== '1';
const FRAMES = join(dirname(OUT), '.frames-' + basename(OUT).replace(/\W+/g, ''));

/* 優先用系統的完整 ffmpeg；沒有就退回 Playwright 內建的精簡版。
 * 那個精簡版只認得 MJPEG 輸入、只會輸出 VP8，所以逐格一律存 JPEG。 */
function pickFfmpeg(){
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return { bin: 'ffmpeg', h264: out.includes('libx264') };
  } catch {}
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
  if (root && existsSync(root)) {
    const d = readdirSync(root).find(x => x.startsWith('ffmpeg'));
    const p = d && join(root, d, 'ffmpeg-linux');
    if (p && existsSync(p)) return { bin: p, h264: false };
  }
  throw new Error('找不到 ffmpeg');
}
const { bin: FFMPEG, h264 } = pickFfmpeg();

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load' });
await page.waitForFunction(() => !!document.getElementById('dzTag'), null, { timeout: 30000 });
console.log('時間軸長度：', await page.textContent('#dzTag'));

if (HIDE_HUD) {
  await page.addStyleTag({ content:
    '#dzPause,#dzBar,#dzTag,#dzTip,#dzTrack,#dzKnob,[id^="dzNav"]{display:none!important}' });
}
await page.waitForTimeout(800);

/* ---- 逐格擷取 ---- */
const frames = [];                     // { file, t }，t 為秒
const writes = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  const file = join(FRAMES, String(frames.length).padStart(6, '0') + '.jpg');
  frames.push({ file, t: metadata.timestamp });
  writes.push(writeFile(file, Buffer.from(data, 'base64')));
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast',
  { format: 'jpeg', quality: 100, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

await page.keyboard.press('Space');                       // 開始播放
await page.waitForFunction(() => !!window.DEMO_DONE, null, { timeout: 15 * 60 * 1000 });
console.log('播放完成：', await page.evaluate(() => window.DEMO_DONE));
await page.waitForTimeout(1500);                          // 留一點收尾畫面

await cdp.send('Page.stopScreencast').catch(() => {});
await Promise.all(writes);
await browser.close();

if (frames.length < 2) throw new Error('沒收到畫面，請檢查頁面是否正常載入');
console.log('擷取幀數：', frames.length);

/* ---- 合成：畫面停多久就重複幾格，湊成等速影片 ----
 * 精簡版 ffmpeg 沒有 concat demuxer，只能從 stdin 餵定速的 MJPEG，
 * 所以這裡自己按時間戳補格，兩種 ffmpeg 都走得通。 */
const codec = h264
  ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-movflags', '+faststart']
  : ['-c:v', 'vp8', '-b:v', '8M', '-crf', '6', '-qmin', '0', '-qmax', '20',
     '-deadline', 'good', '-speed', '2', '-threads', '4'];
const dest = h264 ? OUT : OUT.replace(/\.\w+$/, '.webm');

const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
  '-an', '-r', String(FPS), ...codec, dest], { stdio: ['pipe', 'inherit', 'inherit'] });

const push = buf => new Promise(r => ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r));
let acc = 0, written = 0;
for (let i = 0; i < frames.length; i++) {
  const buf = readFileSync(frames[i].file);
  acc += i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1.0;   // 尾巴留 1 秒
  for (const want = Math.round(acc * FPS); written < want; written++) await push(buf);
}
ff.stdin.end();
const code = await new Promise(r => ff.on('close', r));
if (code !== 0) throw new Error('ffmpeg 失敗，代碼 ' + code);

if (process.env.KEEP !== '1') rmSync(FRAMES, { recursive: true, force: true });
console.log(`輸出：${dest}（${(written / FPS).toFixed(1)} 秒）`);
if (!h264) console.log('（這台的 ffmpeg 不支援 H.264，只能出 webm；裝完整 ffmpeg 後會直接出 mp4）');
