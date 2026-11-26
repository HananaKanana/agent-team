// 安装检查：本机装了哪些平台、skill、hook、浏览器插件（看板「安装」页）；本机的局域网地址

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { WIN } from '../install.js';
import { TOOL_DIR } from './context.js';

// 本机 DeepSeek Harness 的安装情况，给「安装」页拼命令用。
// skill 目录：已经放着 ateam-worker 的那个优先，其次是存在的，都没有就用 ~/.agents/skills。
// profile：$DSH_HOME/profiles 下的目录（DSH_HOME 默认 ~/.dsh）
export function installInfo() {
  const home = homedir();
  const dshHome = process.env.DSH_HOME || join(home, '.dsh');
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const profilesDir = join(dshHome, 'profiles');
  // 真正的 profile 目录里有 cordis.yml（跳过 node_modules 之类）；当前会话用的（DSH_PROFILE）排最前
  const profiles = (isDir(profilesDir) ? readdirSync(profilesDir).filter((n) => existsSync(join(profilesDir, n, 'cordis.yml'))).sort() : [])
    .sort((a, b) => (b === process.env.DSH_PROFILE) - (a === process.env.DSH_PROFILE));
  const skillCandidates = [join(home, '.agents', 'skills'), join(dshHome, 'skills'), ...profiles.map((p) => join(profilesDir, p, 'skills'))];
  const has = (dir, name) => { try { lstatSync(join(dir, name)); return true; } catch { return false; } };
  const skillsDir = skillCandidates.find((d) => has(d, 'ateam-worker')) || skillCandidates.find(isDir) || skillCandidates[0];
  // browser-cdp-setup：linked = 软链到本仓库；copied = 有但不是软链（要先删掉再链）
  let browserSkill = 'missing';
  try {
    const st = lstatSync(join(skillsDir, 'browser-cdp-setup'));
    browserSkill = st.isSymbolicLink() && resolve(skillsDir, readlinkSync(join(skillsDir, 'browser-cdp-setup'))) === join(TOOL_DIR, 'skills', 'browser-cdp-setup') ? 'linked' : 'copied';
  } catch {}
  // 每个 profile 的 cordis.patch.yml 里有没有配 dsh-cdp 的 dataDir
  const cdpConfigured = Object.fromEntries(profiles.map((p) => {
    let text = '';
    try { text = readFileSync(join(profilesDir, p, 'cordis.patch.yml'), 'utf8'); } catch {}
    // 只在 dsh-cdp 这一条的范围内找 dataDir，不跨到后面别的条目
    return [p, /^- id:\s*['"]?dsh-cdp['"]?[ \t]*\n(?:(?:[ \t].*)?\n)*?[ \t]+dataDir:/m.test(text)];
  }));
  const hookInstalled = profiles.some((p) => {
    try { return readFileSync(join(profilesDir, p, 'cordis.patch.yml'), 'utf8').includes('ateam-hooks-4.json'); } catch { return false; }
  });
  // WorkBuddy：用户级 settings.json 里有 ateam 的 hook 命令
  const workbuddyFile = [join(home, '.workbuddy', 'settings.json'), join(home, '.codebuddy', 'settings.json')].find((f) => existsSync(f));
  let workbuddyHook = null;
  if (workbuddyFile) { try { const t = readFileSync(workbuddyFile, 'utf8'); workbuddyHook = t.includes('hook pre-browser') && t.includes('mcp__browser__.*'); } catch {} }
  // ego-browser：命令装在 ~/.local/bin（服务的 PATH 里不一定有），skill 由 ego lite 安装时自己链接到各平台的 skill 目录
  const egoNames = WIN ? ['ego-browser.exe', 'ego-browser.cmd'] : ['ego-browser'];
  const egoBin = [join(home, '.local', 'bin'), ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean)].flatMap((d) => egoNames.map((n) => join(d, n))).find((f) => existsSync(f)) ?? null;
  const egoSkill = Object.fromEntries([['DeepSeek Harness', skillsDir], ['WorkBuddy', join(home, '.workbuddy', 'skills')]].map(([k, d]) => [k, existsSync(join(d, 'ego-browser', 'SKILL.md'))]));
  return { home, dshHome, profilesDir, profiles, skillsDir, browserSkill, cdpConfigured, hookInstalled, workbuddyHook, egoBin, egoSkill, toolDir: TOOL_DIR };
}
// 局域网访问（--lan）：监听所有网卡，别的电脑打开看板只能看、不能改；所有改动只认本机
export function lanAddresses() {
  // 去重；198.18.0.0/15 是代理软件（Clash、Surge 等）虚拟网卡常用的地址，别的电脑连不上，不列
  const ips = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  return [...new Set(ips)].filter((ip) => !/^198\.1[89]\./.test(ip));
}
