// 状态落盘。分三类文件，都在 .ateam/ 下：
// - board.json：没结束的需求和它们的卡、编号计数、设置。是项目记录，提交进 git
// - archive/<需求编号>.json：已验收、已作废的需求连同它的卡，一个需求一个文件。也提交进 git；
//   结束后基本不再变，看板状态不会因为它们一直有改动
// - demos/<需求编号>.json：演播需求连同它的演播卡，一个需求一个文件。也提交进 git；演播需求不会结束
//   （反复预演、演播），每跑一次追加运行记录，单独放开免得 board.json 跟着一直变
// - runtime.json：worker、事件、无 leader 模式这些一直在变的运行状态。不提交（.ateam/.gitignore 里排除）
// 老版本的 state.json 第一次读到时拆成上面三类，原文件改名为 state.json.bak（也不提交）。
// 每个文件先写 .tmp 再 rename，保证原子性；内容没变的文件不重写。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BOARD_KEYS = ['seq', 'settings', 'jobs', 'tasks'];
const DONE = new Set(['accepted', 'cancelled']);
const num = (id) => Number(String(id).slice(1)) || 0;
const byId = (a, b) => num(a.id) - num(b.id);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadState(dir) {
  const board = join(dir, 'board.json');
  if (!existsSync(board)) {
    const old = join(dir, 'state.json');
    return existsSync(old) ? readJson(old) : null;
  }
  const state = { ...readJson(board) };
  const runtime = join(dir, 'runtime.json');
  if (existsSync(runtime)) Object.assign(state, readJson(runtime));
  for (const sub of ['archive', 'demos']) {
    const folder = join(dir, sub);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.json')) continue;
      const { job, tasks } = readJson(join(folder, name));
      if (job) state.jobs.push(job);
      state.tasks.push(...(tasks ?? []));
    }
  }
  state.jobs.sort(byId);
  state.tasks.sort(byId);
  state.agents ??= [];
  state.events ??= [];
  return state;
}

// 上次写下去的内容，没变就不重写（文件时间不动，git 也看不出改动）
const written = new Map();
function writeIfChanged(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (written.get(file) === text) return;
  if (!written.has(file) && existsSync(file) && readFileSync(file, 'utf8') === text) {
    written.set(file, text);
    return;
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  written.set(file, text);
}

// 一个需求连同它的卡写成一个文件；folder 里不再属于这一类的文件删掉（需求重新打开、演播需求作废进了归档……）
function writeJobFiles(dir, folder, jobs, tasks) {
  const ids = new Set(jobs.map((j) => j.id));
  for (const job of jobs) {
    writeIfChanged(join(dir, folder, `${job.id}.json`), { job, tasks: tasks.filter((t) => t.jobId === job.id) });
  }
  for (const name of readdirSync(join(dir, folder))) {
    if (name.endsWith('.json') && !ids.has(name.slice(0, -5))) {
      unlinkSync(join(dir, folder, name));
      written.delete(join(dir, folder, name));
    }
  }
}

export function saveState(dir, state) {
  mkdirSync(join(dir, 'archive'), { recursive: true });
  mkdirSync(join(dir, 'demos'), { recursive: true });
  const done = new Set(state.jobs.filter((j) => DONE.has(j.status)).map((j) => j.id));
  const demo = new Set(state.jobs.filter((j) => j.demo && !done.has(j.id)).map((j) => j.id));
  const board = {};
  for (const key of BOARD_KEYS) if (key in state) board[key] = state[key];
  board.jobs = state.jobs.filter((j) => !done.has(j.id) && !demo.has(j.id));
  board.tasks = state.tasks.filter((t) => !done.has(t.jobId) && !demo.has(t.jobId));
  writeIfChanged(join(dir, 'board.json'), board);

  const runtime = {};
  for (const [key, value] of Object.entries(state)) if (!BOARD_KEYS.includes(key)) runtime[key] = value;
  writeIfChanged(join(dir, 'runtime.json'), runtime);

  writeJobFiles(dir, 'archive', state.jobs.filter((j) => done.has(j.id)), state.tasks);
  writeJobFiles(dir, 'demos', state.jobs.filter((j) => demo.has(j.id)), state.tasks);
  // 老版本的单个状态文件：拆分写好后改名留作备份
  const old = join(dir, 'state.json');
  if (existsSync(old)) renameSync(old, `${old}.bak`);
}
