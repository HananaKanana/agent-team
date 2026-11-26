// 服务运行时的上下文：项目目录、数据目录、store、端口、局域网地址等，startServer() 启动时设置。一个进程只有一个服务

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeMismatch } from '../install.js';

// agent-team 自己的安装目录，看板「安装」页用它拼出安装命令
export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export let root = null;
// 服务端代码指纹：src/*.js 和 bin/ateam.js 的内容哈希。启动时记一份，之后比对，
// 代码被更新（git pull、改了代码）而服务没重启时，看板和 status 提示重启。
// 只在文件修改时间变了时才重新读内容，看板每 3 秒查一次也不费事。
// 服务端代码：src/ 下的 .js 和拆出去的子目录（看板 src/dashboard 不算，刷新就生效）
const CODE_DIRS = ['src', 'src/store', 'src/server'];

const CODE_FILES = () => [
  ...CODE_DIRS.flatMap((d) => { try { return readdirSync(join(TOOL_DIR, d)).filter((f) => f.endsWith('.js')).map((f) => join(TOOL_DIR, d, f)); } catch { return []; } }),
  join(TOOL_DIR, 'bin', 'ateam.js'),
];
let codeCache = { key: '', hash: '' };

function codeHash() {
  try {
    const files = CODE_FILES().sort();
    const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
    if (key !== codeCache.key) {
      const h = createHash('sha1');
      for (const f of files) h.update(f).update(readFileSync(f));
      codeCache = { key, hash: h.digest('hex') };
    }
    return codeCache.hash;
  } catch {
    return codeCache.hash;
  }
}

export let layout = null; // detectRepos 的结果：单仓库或多仓库
export let dataDir = null; // <项目>/.ateam
export let leaseMs = 15 * 60 * 1000;
export let lan = false;
export let argv = []; // 启动参数（重启时原样带上，端口固定为当前端口）
export let port = 7700;
export let store = null;
export let httpServer = null;
export let lanUrls = []; // 局域网里其他电脑打开看板的地址
let startHash = ''; // 启动时的代码指纹，变了说明代码更新了、服务要重启
// 项目里的数据文件
export let rulesFile = null;
export let testTemplateFile = null;
export let historyFile = null; // 按日存档的用量
export let ownersFile = null;
export let syncProject = null; // 认「是不是同一份看板」用：电脑名 + 项目目录
export function initContext(o) {
  root = o.root;
  layout = o.layout;
  lan = o.lan;
  argv = o.argv;
  port = o.port;
  dataDir = join(root, '.ateam');
  leaseMs = o.leaseMin * 60 * 1000;
  startHash = codeHash();
  rulesFile = join(dataDir, 'rules.md');
  testTemplateFile = join(dataDir, 'test-template.md');
  historyFile = join(dataDir, 'usage-daily.json');
  ownersFile = join(dataDir, 'owners.md');
  syncProject = (() => { try { return realpathSync(root); } catch { return root; } })();
}
export function setStore(s) { store = s; }
export function setPort(p) { port = p; }
export function setHttpServer(s) { httpServer = s; }
export function setLanUrls(u) { lanUrls = u; }

// 服务需要重启的原因：切换了运行模式（dev / installed，启动脚本会改用另一份代码），或代码改过（code）；都没有为 null
export const staleWhy = () => modeMismatch() ?? (codeHash() !== startHash ? 'code' : null);
// 局域网里打开看板的链接（推送、菜单栏用），hash 是看板地址的 #需求/卡号
export const lanLink = (hash = '') => (lanUrls[0] ? `${lanUrls[0]}/${hash ? `#${hash}` : ''}` : '');
