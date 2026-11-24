// 看板显示偏好（主题、侧栏、泳道、分组展开等）：存在本机 ~/.config/ateam/dashboard.json。
// 以前存在浏览器 localStorage 里，按「主机 + 端口」分开存，项目换了端口就丢；同一端口先后跑过的项目又会串。
// global 所有项目共用；projects[<项目目录>] 只属于那个项目。局域网只读访问的电脑不走这里，仍用它自己的浏览器
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AteamError } from './errors.js';
import { configDir } from './install.js';

const file = () => join(configDir(), 'dashboard.json');
const KEY = /^[\w.-]{1,64}$/;
const MAX_VALUE = 4000;

function readAll() {
  try {
    const d = JSON.parse(readFileSync(file(), 'utf8'));
    return { global: d?.global && typeof d.global === 'object' ? d.global : {}, projects: d?.projects && typeof d.projects === 'object' ? d.projects : {} };
  } catch {
    return { global: {}, projects: {} };
  }
}

export function viewPrefs(root) {
  const all = readAll();
  return { global: all.global, project: all.projects[resolve(root)] ?? {} };
}

// value 为 null 时删除这一项
export function saveViewPref(root, { scope, key, value }) {
  if (scope !== 'global' && scope !== 'project') throw new AteamError('INVALID', 'scope 只能是 global 或 project。');
  if (typeof key !== 'string' || !KEY.test(key)) throw new AteamError('INVALID', 'key 不合法。');
  if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE)) throw new AteamError('INVALID', `value 必须是不超过 ${MAX_VALUE} 字的字符串。`);
  const all = readAll();
  const bucket = scope === 'global' ? all.global : (all.projects[resolve(root)] ??= {});
  if (value === null) delete bucket[key]; else bucket[key] = value;
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file());
}
