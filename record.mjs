/* 把 index.html 的自動導覽（錄影版）錄成影片檔
 *
 *   node record.mjs [輸入.html] [輸出.mp4]
 *
 * 做法：用無頭 Chromium 播放一次，透過 CDP 螢幕串流收「無失真 PNG」逐格畫面，
 * 再依每格的實際時間戳合成影片。比 Playwright 內建錄影銳利很多
 * （內建錄影固定 1 Mbps、輸入還是 JPEG，1080p 的中文字會糊掉）。
 *
 * 環境變數：W/H 解析度、FPS 輸出幀率、HUD=1 保留播放列、KEEP=1 保留逐格 PNG
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/* 優先用系統的完整 ffmpeg；沒有才退回 Playwright 內建的精簡版（只會 VP8） */
function pickFfmpeg(){
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (out.includes('libx264')) return { bin: 'ffmpeg', h264: true };
    return { bin: 'ffmpeg', h264: false };
  } catch {}
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
  if (root && existsSync(root)) {
    const d = readdirSync(root).find(x => x.startsWith('ffmpeg'));
    const p = d && join(root, d, 'ffmpeg-linux');
    if (p && existsSync(p)) return { bin: p, h264: false };
  }
  throw new Error('找不到 ffmpeg');
}

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

/* ---- 逐格擷取：CDP 螢幕串流，PNG 無失真 ---- */
const frames = [];                     // { file, t }  t 為秒
const writes = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  const file = join(FRAMES, String(frames.length).padStart(6, '0') + '.png');
  frames.push({ file, t: metadata.timestamp });
  writes.push(writeFile(file, Buffer.from(data, 'base64')));
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast',
  { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });

await page.keyboard.press('Space');                       // 開始播放
await page.waitForFunction(() => !!window.DEMO_DONE, null, { timeout: 15 * 60 * 1000 });
console.log('播放完成：', await page.evaluate(() => window.DEMO_DONE));
await page.waitForTimeout(1500);                          // 留一點收尾畫面

await cdp.send('Page.stopScreencast').catch(() => {});
await Promise.all(writes);
await browser.close();

if (frames.length < 2) throw new Error('沒收到畫面，請檢查頁面是否正常載入');
console.log('擷取幀數：', frames.length);

/* ---- 依實際時間戳組成影片：每格停留多久就播多久 ---- */
const tail = 1.0;
let list = 'ffconcat version 1.0\n';
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : tail;
  list += `file '${frames[i].file}'\nduration ${Math.max(d, 1 / 120).toFixed(4)}\n`;
}
list += `file '${frames.at(-1).file}'\n`;                 // ffmpeg concat 的慣例：最後一格要再列一次
const listFile = join(FRAMES, 'list.txt');
writeFileSync(listFile, list);

const { bin, h264 } = pickFfmpeg();
const codec = h264
  ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-movflags', '+faststart']
  : ['-c:v', 'vp8', '-b:v', '8M', '-crf', '6', '-qmin', '0', '-qmax', '20',
     '-deadline', 'good', '-cpu-used', '1'];
const dest = h264 ? OUT : OUT.replace(/\.mp4$/, '.webm');

execFileSync(bin, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
                   '-vsync', 'cfr', '-r', String(FPS), ...codec, dest],
             { stdio: 'inherit' });

if (process.env.KEEP !== '1') rmSync(FRAMES, { recursive: true, force: true });
console.log('輸出：', dest);
if (!h264) {
  console.log('（這台機器的 ffmpeg 不支援 H.264，只能輸出 webm；裝完整 ffmpeg 後會直接出 mp4）');
}
