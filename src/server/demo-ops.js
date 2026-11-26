// 演播卡的操作记录（脚本里「## 操作记录」）落盘和恢复；提词悬浮窗进程

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { headContent } from '../git.js';
import { root, store } from './context.js';
import { serial } from './http.js';

// 预演开始时清空的操作记录：预演没跑完（走不通、叫停、结束收尾）卡回到待演播时，从 git 还原成上一版
async function restoreOps(task) {
  const head = await headContent(root, task.script);
  if (head !== null) writeFileSync(join(root, task.script), head);
  store.markOpsCleared(task.id, false);
}
export const settleOps = () => serial(async () => {
  for (const t of store.state.tasks) {
    if (t.kind === 'demo' && t.opsCleared && t.status === 'ready') await restoreOps(t);
  }
});

