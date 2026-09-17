/* 把 index.html 的自動導覽（錄影版）錄成影片檔
 * 用法：node record.mjs [輸入.html] [輸出.mp4]
 * 需求：playwright（可全域安裝）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

const SRC  = resolve(process.argv[2] || 'index.html');
const OUT  = resolve(process.argv[3] || 'demo.mp4');
const W = Number(process.env.W || 1920), H = Number(process.env.H || 1080);
const HIDE_HUD = process.env.HUD !== '1';          // HUD=1 保留播放列與計時
const TMP = join(dirname(OUT), '.rec-tmp');

/* Playwright 內建的 ffmpeg，找不到才退回系統 ffmpeg */
function ffmpegBin(){
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
  if (root && existsSync(root)) {
    const d = readdirSync(root).find(x => x.startsWith('ffmpeg'));
    if (d) {
      const p = join(root, d, 'ffmpeg-linux');
      if (existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: TMP, size: { width: W, height: H } },
});
const page = await ctx.newPage();

await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load' });
await page.waitForFunction(() => !!document.getElementById('dzTag'), null, { timeout: 30000 });

const total = await page.textContent('#dzTag');            // 例：0:00 / 2:20　暫停中
console.log('時間軸長度：', total);

if (HIDE_HUD) {
  await page.addStyleTag({ content:
    '#dzPause,#dzBar,#dzTag,#dzTip,#dzTrack,#dzKnob,[id^="dzNav"]{display:none!important}' });
}

await page.waitForTimeout(1200);
await page.keyboard.press('Space');                        // 開始播放

/* 等腳本跑完：run() 結束時會寫入 window.DEMO_DONE */
await page.waitForFunction(() => !!window.DEMO_DONE, null, { timeout: 15 * 60 * 1000 });
console.log('播放完成：', await page.evaluate(() => window.DEMO_DONE));
await page.waitForTimeout(1500);                           // 留一點收尾畫面

const video = page.video();
await ctx.close();                                         // 關閉才會寫出 webm
await browser.close();
const webm = await video.path();

/* Chromium 錄出來的是 VP8 webm；有完整 ffmpeg 才轉得成 H.264 mp4 */
const keepWebm = OUT.replace(/\.mp4$/, '.webm');
renameSync(webm, keepWebm);
rmSync(TMP, { recursive: true, force: true });

try {
  execFileSync(ffmpegBin(), [
    '-y', '-i', keepWebm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-r', '30', OUT,
  ], { stdio: 'inherit' });
  console.log('輸出：', OUT);
} catch {
  console.log('這台機器的 ffmpeg 不支援 H.264，只輸出 webm：', keepWebm);
  console.log('要 mp4 的話，裝一份完整的 ffmpeg 後執行：');
  console.log(`  ffmpeg -i ${keepWebm} -c:v libx264 -crf 20 -pix_fmt yuv420p ${OUT}`);
}
