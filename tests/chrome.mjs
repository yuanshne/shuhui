/**
 * Chrome 定位：让测试在任意机器上都能跑，不再硬编码某一台机器的安装路径。
 *
 * 解析顺序：
 *   1. 环境变量 CHROME_PATH（显式指定，优先级最高）
 *   2. Playwright 浏览器缓存（ms-playwright 下的 chromium / chrome-headless-shell）
 *   3. 回退到本机已安装的 Chrome（channel: 'chrome'）
 *
 * 用法：
 *   import { resolveChrome } from './chrome.mjs';
 *   const browser = await chromium.launch({ headless: true, ...resolveChrome() });
 *
 * 若三者都找不到，可先执行：`npx playwright install chromium`，
 * 或设置 CHROME_PATH 指向本机 chrome.exe / chrome-headless-shell.exe。
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return { executablePath: fromEnv };

  const cache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(cache)) {
    // 不写死版本号：扫描缓存目录，兼容任意 chromium-<rev> / chromium_headless_shell-<rev>
    const layouts = [
      ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
      ['chrome-win64', 'chrome.exe'],
    ];
    for (const dir of readdirSync(cache).sort()) {
      for (const [sub, exe] of layouts) {
        const candidate = path.join(cache, dir, sub, exe);
        if (existsSync(candidate)) return { executablePath: candidate };
      }
    }
  }

  return { channel: 'chrome' };
}
