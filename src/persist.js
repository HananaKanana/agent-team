// 状态落盘：先写 state.json.tmp 再 rename，保证原子性。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadState(dir) {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}
