// 文件负责人（.ateam/owners.md）：按路径找负责人

import { readFileSync } from 'node:fs';
import { ownersFile } from './context.js';
import { syncCfg } from './sync.js';

export function readOwners() {
  try { return readFileSync(ownersFile, 'utf8'); } catch { return ''; }
}
export function parseOwners(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [path, ...rest] = line.split(/\s+/);
    const names = rest.join(' ').split(/[\s,，、]+/).map((n) => n.replace(/^@/, '').trim()).filter(Boolean);
    if (path && names.length) out.push({ path: path.replace(/^\.\//, '') || '.', names });
  }
  return out;
}
const normP = (p) => { const x = String(p).trim().replace(/^\.\//, '').replace(/\/+$/, ''); return x === '.' ? '' : x; };
const crosses = (a, b) => { a = normP(a); b = normP(b); return !a || !b || a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`); };
// 卡的路径落在别人负责的目录里：[{ path: 归属目录, names }]（自己负责的、和自己同时负责的不算）
export function ownersFor(paths) {
  const me = syncCfg.name;
  return parseOwners(readOwners()).filter((o) => !(me && o.names.includes(me)) && (paths ?? []).some((p) => crosses(p, o.path)));
}
