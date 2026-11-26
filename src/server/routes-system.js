// 看板和系统的接口：状态查询、设置、测试模板、推送、同步、负责人、升级、停止、体检、安装检查、用量

import { renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { DIGEST_SECTIONS } from '../digest.js';
import { AteamError } from '../errors.js';
import { DEFAULT_TEST_TEMPLATE } from '../format.js';
import { commitStats, ensureGitignore } from '../git.js';
import { mode as runMode, version as ateamVersion } from '../install.js';
import { anyPushOn, EVENT_TYPES, maskedPush, pushEnabled, readDigest, readPrefs, saveDigest, savePrefs, savePush, sendPush, setPushEnabled } from '../push.js';
import { leadRules } from '../rules.js';
import { explainGitError, untrackBoardFiles } from '../sync.js';
import { buildReport } from '../usage-report.js';
import { saveViewPref } from '../view-prefs.js';
import { dataDir, lanLink, lanUrls, layout, ownersFile, port, root, staleWhy, store, TOOL_DIR } from './context.js';
import { installInfo } from './install-info.js';
import { leaderOnline, leaderSeenAt, watchers } from './live.js';
import { readRules, readTestTemplate, writeTestTemplate } from './rules.js';
import { doctor, egoProfiles, recheck, refreshEgoProfiles, spawnRoles } from './agents.js';
import { checkUpdate, startUpdate, stopServer, updateInfo, updateSummary } from './update.js';
import { attention } from './attention.js';
import { digestMessage } from './push.js';
import { tokensOf, usageHistory, usageReport } from './usage.js';
import { codeView, syncCfg, syncConfigure, syncRel, syncState, syncStatus, syncTick, syncTop } from './sync.js';
import { parseOwners, readOwners } from './owners.js';

export const systemRoutes = {
  'GET /api/task-tokens': async (_b, url) => ({ tokens: await tokensOf(store.getTask(url.searchParams.get('id') ?? '')) }),
  'GET /api/usage': async (_b, url) => {
    const all = await usageReport(url.searchParams.get('fresh') === '1');
    const jobId = url.searchParams.get('job');
    if (jobId) store.getJob(jobId); // 没有这个需求时报错
    const r = jobId ? buildReport({ state: store.state, collected: all.collected, jobId, history: usageHistory }) : all;
    const { perTask, heavyOf, agentsSeen, collected, seal, ...report } = r;
    return { usage: report };
  },
  // 看板上的「安装」按钮：服务跑在用户的终端里，不受 agent 沙箱限制，可以直接改平台配置
  'POST /api/hook-install': async (b) => {
    const platform = b.platform === 'workbuddy' ? 'workbuddy' : 'dsh';
    const { installHook } = await import('../hook-install.js');
    try {
      return { message: installHook({ platform }) };
    } catch (err) {
      throw new AteamError('BAD_STATE', err.message);
    }
  },
  'GET /api/sync': async () => ({ sync: await syncStatus() }),
  // 打开同步（看板开关、ateam sync init）时，同步成功且看板文件还在仓库里被跟踪，就顺带停止跟踪：只在当前分支提交这一处改动，不推送
  'POST /api/sync': async (b) => {
    const sync = await syncConfigure(b);
    if (b.enabled !== true || !sync.enabled || sync.error || !sync.tracked || !syncRel()) return { sync };
    try {
      const untrack = await untrackBoardFiles({ top: syncTop(), rel: syncRel(), dataDir, name: syncCfg.name });
      return { sync: await syncStatus(), untrack };
    } catch (err) {
      return { sync, untrackError: `停止在仓库中跟踪看板文件失败：${err.stderr ? explainGitError(err) : err.message}` };
    }
  },
  // 迁移：看板文件不再在仓库里跟踪（本地文件保留），只提交这一处改动。要先开启同步
  'GET /api/owners': () => ({ text: readOwners(), entries: parseOwners(readOwners()) }),
  'POST /api/owners': (b) => {
    const text = String(b.text ?? '');
    const tmp = `${ownersFile}.tmp`;
    writeFileSync(tmp, text.endsWith('\n') || !text ? text : `${text}\n`);
    renameSync(tmp, ownersFile);
    return { text: readOwners(), entries: parseOwners(readOwners()) };
  },
  'POST /api/sync/untrack': async () => {
    if (!syncCfg.enabled) throw new AteamError('INVALID', '请先开启看板同步（ateam sync init），确认已推送到 ateam 分支后再停止在仓库中跟踪看板文件。');
    if (!syncRel()) throw new AteamError('INVALID', '多仓库模式下 .ateam 不在任何仓库里，不需要这一步。');
    await syncTick();
    if (syncState.error) throw new AteamError('INVALID', `看板还没成功推送到 ateam 分支：${syncState.error}`);
    const out = await untrackBoardFiles({ top: syncTop(), rel: syncRel(), dataDir, name: syncCfg.name });
    return { untrack: out, sync: await syncStatus() };
  },
  'POST /api/prefs': (b) => { saveViewPref(root, b); return {}; },
  'POST /api/settings': (b) => {
    const settings = store.setSettings(b);
    // 换了测试浏览器：自检要查的东西跟着变
    if ('testBrowser' in b) {
      recheck().catch(() => {});
      if (settings.testBrowser === 'ego') refreshEgoProfiles().catch(() => {});
    }
    return { settings };
  },
  // 没改过、或重置了：返回自带模板，custom 为 false
  'GET /api/test-template': () => {
    const text = readTestTemplate();
    return { text: text.trim() ? text : DEFAULT_TEST_TEMPLATE, custom: !!text.trim(), default: DEFAULT_TEST_TEMPLATE };
  },
  'POST /api/test-template': (b) => {
    const text = writeTestTemplate(b.text);
    return { text: text.trim() ? text : DEFAULT_TEST_TEMPLATE, custom: !!text.trim(), default: DEFAULT_TEST_TEMPLATE };
  },
  // 「安装」页用：本机 DeepSeek Harness 的 skill 目录和 profile、各项是否已经装好。都是现场读出来的，不写死
  'GET /api/install-info': () => installInfo(),
  // 菜单栏程序用的简要状态：待你处理的事（与看板的「待处理」一致）、在线 worker 和手上的卡、局域网只读地址
  'GET /api/summary': () => {
    const st = store.state;
    const items = attention();
    return {
      root, name: basename(root), version: ateamVersion(), mode: runMode(),
      workers: st.agents.filter((a) => a.status === 'online').length,
      working: st.tasks.filter((t) => ['working', 'asking', 'demoing', 'wrapping'].includes(t.status)).length,
      accept: st.jobs.filter((j) => j.status === 'awaiting_acceptance').length,
      attention: items.length,
      items,
      agents: st.agents.filter((a) => a.status === 'online').map((a) => {
        const t = a.currentTask ? st.tasks.find((x) => x.id === a.currentTask) : null;
        // 这次从什么时候开始做：最近一次领取、接手、开始演播或被打回
        const since = t ? [...t.history].reverse().find((h) => ['claimed', 'handoff', 'demo_started', 'rejected'].includes(h.type))?.ts ?? null : null;
        // 菜单栏的下线选项要用：已安排做完再下线、是不是这个角色唯一在线的（设置里开着「每个角色至少保留一个」时要提醒）
        const role = a.role.trim().toLowerCase();
        const last = store.config().keepOnePerRole !== false && !a.dismiss
          && st.agents.filter((x) => x.status === 'online' && !x.dismiss && x.role.trim().toLowerCase() === role).length === 1;
        return { id: a.id, name: a.name || null, role: a.role, stale: !!a.stale, dismiss: !!a.dismiss, last, task: t ? { id: t.id, title: t.title, status: t.status, hash: `${t.jobId}/${t.id}`, since } : null };
      }),
      lan: lanUrls,
      spawn: spawnRoles(),
      stale: !!staleWhy(),
      update: updateInfo.newer ? updateInfo.latest : null,
    };
  },
  // 推送到手机：配置（token、密钥只露末几位）、保存一个渠道、发测试消息
  'GET /api/push': () => ({ enabled: pushEnabled(), channels: maskedPush(), digest: readDigest(), prefs: readPrefs(), eventTypes: EVENT_TYPES, digestSections: DIGEST_SECTIONS }),
  // 推哪些事、什么格式
  'POST /api/push/prefs': (b) => {
    try { return { prefs: savePrefs({ events: b.events, format: b.format }) }; } catch (err) { throw new AteamError('INVALID', err.message); }
  },
  // 定时小结：kind = daily / weekly 改开关和时间，kind = sections 改段落
  'POST /api/push/digest': (b) => {
    try { return { digest: saveDigest(String(b.kind ?? ''), b) }; } catch (err) { throw new AteamError('INVALID', err.message); }
  },
  // 预览：按现在的数据和设置生成一份（不发）
  'GET /api/push/digest': async (_b, url) => {
    const kind = url.searchParams.get('kind') === 'weekly' ? 'weekly' : 'daily';
    return { preview: await digestMessage(kind) };
  },
  // 立即发一份到所有开启的渠道
  'POST /api/push/digest/send': async (b) => {
    const kind = b.kind === 'weekly' ? 'weekly' : 'daily';
    if (!anyPushOn()) throw new AteamError('INVALID', '请先打开推送总开关并开启至少一个渠道。');
    const m = await digestMessage(kind);
    if (!m) throw new AteamError('INVALID', '这段时间没有任何进展，没有可发送的内容。');
    const results = await sendPush(m);
    const bad = results.filter((r) => !r.ok);
    if (bad.length === results.length) throw new AteamError('INVALID', `发送失败：${bad.map((r) => r.error).join('；')}`);
    return { sent: results.filter((r) => r.ok).length, failed: bad };
  },
  // 只给 enabled：改总开关；给 channel：保存一个渠道
  'POST /api/push': (b) => {
    try {
      if (b.channel === undefined && 'enabled' in b) setPushEnabled(!!b.enabled);
      else savePush(String(b.channel ?? ''), { on: b.on, values: b.values ?? {} });
      return { enabled: pushEnabled(), channels: maskedPush() };
    } catch (err) { throw new AteamError('INVALID', err.message); }
  },
  'POST /api/push/test': async (b) => {
    let results;
    try {
      results = await sendPush({ title: `ateam · ${basename(root)}：推送测试`, lines: ['这是一条测试消息，收到说明推送配置正确。'], link: lanLink() }, String(b.channel ?? ''));
    } catch (err) { throw new AteamError('INVALID', err.message); }
    const r = results[0];
    if (!r.ok) throw new AteamError('INVALID', `发送失败：${r.error}`);
    return { sent: true };
  },
  'POST /api/shutdown': () => { setTimeout(() => stopServer(false), 200); return { stopping: true }; },
  'POST /api/restart': () => { setTimeout(() => stopServer(true), 200); return { restarting: true }; },
  // 版本页：带更新说明；fresh=1 立即查一次
  'GET /api/update': async (_b, url) => {
    if (url.searchParams.get('fresh') === '1') await checkUpdate();
    return { ...updateSummary(), releases: runMode() === 'installed' ? updateInfo.releases.slice(0, 10) : [] };
  },
  'POST /api/update/install': (b) => startUpdate(b.version ? String(b.version) : undefined),
  // 看板设置页的「刷新」：重新从 ego 读取测试用 profile
  'GET /api/ego-profiles': async (_b, url) => {
    if (url.searchParams.get('fresh') === '1') await refreshEgoProfiles();
    return egoProfiles;
  },
  // 自检：启动时跑过一次，fresh=1 重跑
  'GET /api/doctor': async (_b, url) => {
    if (url.searchParams.get('fresh') === '1' || !doctor) await recheck();
    return { checks: doctor };
  },
  // 看板「待处理」里自检项的「修复」：ignore 补 .ateam/.gitignore，cdp 给 DSH 写测试浏览器配置。修完重跑自检
  'POST /api/doctor/fix': async (b) => {
    let message;
    if (b.key === 'ignore') {
      ensureGitignore(root);
      message = '已补全 .ateam/.gitignore。';
    } else if (b.key === 'cdp') {
      const { configureCdp } = await import('../hook-install.js');
      try {
        message = configureCdp({ profile: b.profile || installInfo().profiles[0] });
      } catch (err) {
        throw new AteamError('BAD_STATE', err.message);
      }
    } else {
      throw new AteamError('INVALID', `自检项 ${b.key} 没有自动修复。`);
    }
    await recheck();
    return { message, checks: doctor };
  },
  'GET /api/state': (_b, url) => ({
    // 看板不用事件列表（命令行 status 要用它数未读事件），?view=dashboard 时去掉，减小数据量
    state: url.searchParams.get('view') === 'dashboard' ? { ...store.state, events: [] } : store.state,
    pending: store.pendingActions(), root, toolDir: TOOL_DIR, home: homedir(), port, platform: process.platform, repos: layout.mode === 'multi' ? layout.repos : null,
    // 代码已更新、或切换了开发模式 / 安装版，但服务还没重启。staleWhy：code / dev / installed
    stale: !!staleWhy(),
    staleWhy: staleWhy(),
    // 版本、运行模式、有没有新版本、正在下载的更新
    update: updateSummary(),
    config: store.config(),
    // ego-browser 测试用 profile（只在选了 ego-browser 时有）
    egoProfiles: store.config().testBrowser === 'ego' ? egoProfiles : null,
    // 自检没过的项（看板顶部提示）
    doctor: (doctor ?? []).filter((c) => !c.ok),
    // 被别人正在改的同一批文件挡住、暂时不派的卡：{ 卡号: 挡着它的卡号 }
    clash: store.clashes(),
    // 其中挡着它的是同事已通过、但还没推送的卡（看板写「待 xx 推送」）
    clashPush: store.clashes(true),
    // 多人协作时本地代码分支和远程的差距（未开启同步时为 null）
    code: syncCfg.enabled ? codeView() : null,
    // 待演播的演播卡现在能不能开始、缺什么
    demoBlockers: Object.fromEntries(store.state.tasks.filter((t) => t.kind === 'demo' && t.status === 'ready').map((t) => [t.id, store.demoBlockers(t.id)])),
    // leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
    leader: { watching: watchers.size > 0, lastSeenAt: leaderSeenAt, online: leaderOnline(), away: store.state.noLeader ?? null },
  }),
  // 带 review 摘要：这张卡所有提交改了哪些文件、各几行；新文件、超出任务路径的文件标出来
  'GET /api/task': async (_b, url) => {
    const task = store.getTask(url.searchParams.get('id') ?? '');
    if (url.searchParams.get('reader') === 'leader') store.leaderOpenedTask(task.id);
    if (!task.commits?.length || task.kind === 'demo') return { task };
    const lead = leadRules(readRules()).trim();
    const files = await commitStats(root, task.commits);
    const norm = (p) => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '');
    const inPaths = (f) => task.paths.map(norm).some((p) => p === '' || p === '.' || f === p || f.startsWith(`${p}/`));
    return { task, review: files.map((f) => ({ ...f, outside: !inPaths(f.file) })), ...(lead ? { leadRules: lead } : {}) };
  },
};
