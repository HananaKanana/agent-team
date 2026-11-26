'use strict';
// 帮助面板：给 worker 的提示词、安装引导、启动 worker、缺人提示

function renderHelper(force = false) {
  const panel = document.getElementById('helper');
  if (!helper.open || !data) { panel.hidden = true; panel.replaceChildren(); return; }
  // 正在编辑规则：轮询刷新不重画面板，免得输入框被替换、打字丢失
  if (!force && helper.tab === 'rules' && panel.querySelector('.rules-page')) return;
  if (!force && (helper.tab === 'settings' || helper.tab === 'push') && (document.activeElement?.classList?.contains('setting-num') || document.activeElement?.classList?.contains('setting-text')) && panel.contains(document.activeElement)) return;
  if (!force && document.activeElement?.classList?.contains('msg-input') && panel.contains(document.activeElement)) return;
  // 正在编辑测试报告模板：同项目规则，轮询不重画
  if (!force && helper.tab === 'tests' && panel.querySelector('.tpl-page')) return;
  if (helper.mode === 'offline') { renderOfflinePanel(panel); return; }
  const { agents, tasks } = data.state;
  const online = agents.filter((a) => a.status === 'online');
  const offline = agents.filter((a) => a.status !== 'online' && !a.hidden)
    .sort((x, y) => y.lastSeenAt - x.lastSeenAt);
  // 角色：标准四个角色 + 还没完成的任务用到的角色 + 所有（未移除的）worker 用过的角色
  const roles = new Map(STANDARD_ROLES.map((r) => [r.key, r.key]));
  for (const t of tasks) if (t.status !== 'approved' && t.status !== 'cancelled') roles.set(t.role.trim().toLowerCase(), t.role);
  for (const a of agents) if (!a.hidden) roles.set(a.role.trim().toLowerCase(), a.role);
  const ordered = online.slice().sort((x, y) => (y.id === helper.focus) - (x.id === helper.focus) || isStale(y) - isStale(x));
  const closeBtn = el('button', { class: 'btn ghost icon', title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); helper = { open: false, focus: null }; dismissAllArm = false; renderHelper(); } }, icon('close'));
  const dismissAll = online.length ? [
    dismissAllArm ? el('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); dismissAllArm = false; renderHelper(); } }, '取消') : null,
    el('button', {
      class: dismissAllArm ? 'btn warn sm' : 'btn sm',
      title: '所有 worker 立即下线；进行中的任务退回待领取',
      onclick: (e) => {
        e.stopPropagation();
        if (!dismissAllArm) { dismissAllArm = true; renderHelper(); return; }
        dismissAllArm = false;
        dismissAgents({ all: true, userApproved: true });
      },
    }, dismissAllArm ? '确认全部下线' : '全部下线'),
  ] : null;
  const tab = ['lead', 'install', 'rules', 'tests', 'settings', 'push'].includes(helper.tab) ? helper.tab : 'worker';
  const tabBtn = (key, label) => el('button', {
    type: 'button', role: 'tab', class: `tab${tab === key ? ' on' : ''}`, 'aria-selected': tab === key ? 'true' : 'false',
    onclick: (e) => {
      e.stopPropagation();
      helper = { ...helper, tab: key };
      dismissAllArm = false;
      if (key === 'rules') loadRules();
      if (key === 'tests' && !testTpl.loading) testTpl.loaded = false; // 每次切进来重新读，别处改过也能看到
      if (key === 'install') installInfo = null; // 每次切进「安装」页重新读一遍本机情况
      if (key === 'push') pushCfg = null; // 每次切进「推送」重新读配置
      settingsMsg = '';
      renderHelper(true);
    },
  }, label);
  const scroll = panel.hidden ? 0 : panel.scrollTop;
  fill(panel,
    el('div', { class: 'panel-top' },
      el('div', { class: 'helper-head' }, el('b', null, '帮助'), closeBtn),
      el('div', { class: 'tabs', role: 'tablist' }, tabBtn('worker', 'worker'), tabBtn('lead', 'leader'), tabBtn('install', '安装'), tabBtn('rules', '项目规则'), tabBtn('tests', '测试用例'), tabBtn('push', '推送'), tabBtn('settings', '设置'))),
    el('div', { class: 'panel-body' },
    tab === 'rules' || tab === 'settings' || tab === 'tests' || tab === 'install' || tab === 'push' ? null : el('p', { class: 'tab-hint' }, data.root ? `请将 agent 窗口的工作目录设为 ${data.root}，再发送对应的提示词。` : '请将各段提示词发送至对应的 agent 窗口。'),
    tab === 'push' ? pushPage() : tab === 'settings' ? settingsPage() : tab === 'tests' ? testTemplateEditor() : tab === 'rules' ? rulesEditor() : tab === 'install' ? installGuide() : tab === 'worker' ? [
    el('div', { class: 'helper-sec' }, el('h4', null, '① 添加 worker')),
    el('p', { class: 'hint' }, '新建 agent 窗口（可使用其他账号），工作目录选择项目目录，发送对应角色的提示词。如需命名，在第一行末尾添加「，名字 账号B」。'),
    [...roles.values()].map((role) => {
      const key = role.trim().toLowerCase();
      const std = STANDARD_ROLES.find((r) => r.key === key);
      const waiting = tasks.filter((t) => t.status === 'pending' && t.role.trim().toLowerCase() === key).length;
      const working = online.filter((a) => a.role.trim().toLowerCase() === key).length;
      return el('div', { class: 'wcard' },
        el('div', { class: 'wcard-head' },
          el('span', { class: 'tag role', style: roleStyle(role) }, role),
          std ? el('b', null, std.label) : null,
          el('span', { class: 'hint grow' }, std ? std.what : ''),
          el('span', { class: `role-count${waiting && !working ? ' short' : ''}`, title: waiting && !working ? '有待领取的任务，但没有在线 worker' : '' }, `在线 ${working} · 待领取 ${waiting}`),
          spawnButton(role)),
        promptBlock(workerPrompt(role), renderHelper),
        spawnMessage(role));
    }),
    el('div', { class: 'helper-sec' }, el('h4', null, `② 在线 worker（${online.length}）`), dismissAll),
    el('p', { class: 'hint' }, dismissAllArm
      ? '确认后所有 worker 立即下线；进行中的任务退回待领取，已有改动保留。'
      : 'worker 停止响应时，复制其唤醒提示词并发送至该 worker 的 agent 窗口。'),
    ordered.length ? ordered.map((a) => el('div', { class: `wcard${a.id === helper.focus ? ' focus' : ''}` },
      el('div', { class: 'wcard-head' },
        avatar(a.id, a.role),
        el('span', { class: 'grow' },
          el('span', { class: 'who-line' },
            el('b', null, agentLabel(a.id)),
            el('span', { class: 'hint' },
              a.role.trim().toLowerCase() === 'critic' ? criticProgress(a)
                : a.currentTask && data.state.tasks.some((t) => t.id === a.currentTask)
                  // 卡号可点：关掉面板，切到那张卡所在的需求并打开详情
                  ? ['正在处理 ', el('a', { href: '#', class: 'task-jump', title: `跳转到 ${a.currentTask} 并打开卡片详情`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); helper = { open: false, focus: null }; renderHelper(); jumpToTask(a.currentTask); } }, a.currentTask)]
                  : (a.currentTask ? `正在处理 ${a.currentTask}` : '空闲'),
              ` · 心跳 ${ago(a.lastSeenAt)}`)),
          el('span', { class: 'tag role', style: roleStyle(a.role) }, a.role),
          isStale(a) ? el('span', { class: 'pill' }, '无响应') : null,
          a.leaveAsked ? el('span', { class: 'pill', title: '空闲超时，已向 leader 申请下线' }, '申请下线') : null,
          a.rotate && !a.dismiss ? el('span', { class: 'pill', title: `上下文约 ${a.rotate} 万 token，超过「设置 → 换新会话的上下文阈值」：当前任务通过后下线，由新的 worker 接着处理` }, '完成后换新会话') : null,
          a.dismiss ? el('span', { class: 'pill', title: a.role.trim().toLowerCase() === 'critic' ? '审核完待审任务后下线' : '完成当前任务后下线，不再领取新任务' }, a.role.trim().toLowerCase() === 'critic' ? '审完后下线' : '完成后下线') : null,
          pendingCancel(a) ? el('span', { class: 'pill', title: '该 worker 仍在处理已作废的任务' }, `${pendingCancel(a).id} 已作废，尚未通知到`) : null),
        dismissArm === a.id ? null : el('span', { class: 'wcard-acts' },
          el('button', { class: 'btn ghost sm', title: '直接向该 worker 发送消息', onclick: (e) => { e.stopPropagation(); msgArm = msgArm === a.id ? null : a.id; msgState = { id: null, sending: false, error: '', sent: '' }; renderHelper(true); document.querySelector('#helper .msg-input')?.focus(); } }, '发消息'),
          dismissButtons(a))),
      msgArm === a.id ? messageBox(a) : null,
      // 点了「下线」要选怎么下线：单独一条确认栏，按钮不挤在名字那一行里折行
      // 确认时叫醒话先收起来，卡片里只留这一件事
      dismissArm === a.id ? el('div', { class: 'wcard-confirm' },
        el('p', { class: 'q' }, `选择 ${agentLabel(a.id)} 的下线方式`),
        isLastOfRole(a) ? el('p', { class: 'warn-note' }, `该 worker 是 ${a.role} 角色唯一在线的 worker，下线后该角色的新任务将无人领取`) : null,
        el('div', { class: 'wcard-acts' }, dismissButtons(a)))
      : pendingCancel(a) ? [
        el('p', { class: 'hint' }, `${pendingCancel(a).id} 已作废，但该 worker 正在工作，需在下次调用 ateam 命令时才会收到通知。如需立即停止，请在其 agent 窗口中点击停止，并发送以下提示词。`),
        promptBlock(stopPrompt(a, pendingCancel(a)), renderHelper),
      ] : promptBlock(wakePrompt(a), renderHelper))) : el('p', { class: 'hint' }, '暂无在线 worker。'),
    offline.length ? [
      el('div', { class: 'helper-sec' }, el('h4', null, `③ 已离线 worker（${offline.length}）`)),
      el('p', { class: 'hint' }, 'agent 窗口仍在但已离线时：将重连提示词发送至该窗口，worker 将以原编号重新加入并继续工作，无需修改窗口标题。'),
      offline.map((a) => el('div', { class: 'wcard' },
        el('div', { class: 'wcard-head' },
          avatar(a.id, a.role),
          el('span', { class: 'grow' },
            el('span', { class: 'who-line' }, el('b', null, agentLabel(a.id)), el('span', { class: 'hint' }, `最后心跳 ${ago(a.lastSeenAt)}`)),
            el('span', { class: 'tag role', style: roleStyle(a.role) }, a.role))),
        promptBlock(reconnectPrompt(a), renderHelper))),
    ] : null,
    el('div', { class: 'helper-sec' }, el('h4', null, '④ 结束工作')),
    el('p', { class: 'hint' }, '所有需求完成后，在 ② 中点击「全部下线」，worker 将立即停止；也可在 leader 对话中发出「让大家收工」。'),
    ] : [
    el('div', { class: 'helper-sec' }, el('h4', null, '① 启动 leader')),
    el('p', { class: 'hint' }, '在项目目录中新建 Claude Code 会话，发送以下提示词。每个项目只需一个 leader。'),
    el('div', { class: 'wcard' },
      el('div', { class: 'wcard-head' }, el('b', null, '加入'), el('span', { class: 'hint' }, '新建会话或上下文已满需重开会话时，均使用此提示词')),
      promptBlock(leadPrompt(), renderHelper)),
    el('p', { class: 'hint' }, '加入后，直接在对话中向 leader 描述需求（例如「需求是……」）。leader 将拆分任务、派发给 worker，并告知需要启动的 worker 角色与数量。'),
    el('div', { class: 'helper-sec' }, el('h4', null, `② 在线 leader（${data.leader?.online && !data.leader?.away ? 1 : 0}）`)),
    el('p', { class: 'hint' }, 'leader 停止响应或后台监听中断时，复制唤醒提示词并发送至 leader 会话。token 用尽暂时无法恢复时，请点击「下线」。'),
    leaderCard(),
    ]),
  );
  panel.hidden = false;
  panel.scrollTop = scroll;
}
// 提示词：在新的 agent 窗口里对 worker 说的话
// leader 的提示词：在项目目录里开一个 Claude Code 会话发给它
// 「安装」页：一次性安装步骤，命令里的路径用服务所在的真实目录
// 本机安装情况（DeepSeek Harness 的 skill 目录、profile、是否已装好），进「安装」页时读一次
let installInfo = null;
let installProfile = null;
async function loadInstallInfo() {
  installInfo = {}; // 读取中，避免重画时重复请求
  try {
    const out = await (await fetch('/api/install-info', { cache: 'no-store' })).json();
    // 旧服务没有这个接口：按默认路径显示（profiles 为空数组时第 ② 步会提示）
    installInfo = out.ok ? out : { failed: true, profiles: [], profilesDir: '~/.dsh/profiles' };
  } catch { installInfo = { failed: true, profiles: [], profilesDir: '~/.dsh/profiles' }; }
  renderHelper(true);
}
function installGuide() {
  if (installInfo === null) loadInstallInfo();
  const short = (p) => String(p).replace(/^\/Users\/[^/]+/, '~');
  const tool = short(data.toolDir || '~/code/agent-team');
  const info = installInfo || {};
  const skillsDir = short(info.skillsDir || '~/.agents/skills');
  const profiles = info.profiles || [];
  if (!profiles.includes(installProfile)) installProfile = profiles[0] || null;
  const done = (ok, text) => (ok ? el('p', { class: 'hint install-done' }, `✓ ${text}`) : null);
  const project = (data.root || '<项目目录>').replace(/^\/Users\/[^/]+/, '~');
  const port = data.port || 7700;
  const step = (title, hint, cmd) => el('div', { class: 'wcard' },
    el('div', { class: 'wcard-head' }, el('b', null, title)),
    hint ? el('p', { class: 'hint' }, hint) : null,
    cmd ? promptBlock(cmd, renderHelper) : null);
  return [
    // 命令与 skill：装了安装包（安装版或开发模式）就已配好；从源码运行时 npm link + ateam setup 一次搞定
    ['installed', 'dev'].includes(data.update?.mode)
      ? el('div', { class: 'wcard' },
        el('div', { class: 'wcard-head' }, el('b', null, 'ateam 命令与 skill')),
        done(true, `已通过安装包安装（${data.update.modeLabel}），命令和 skill 已自动配置`),
        el('p', { class: 'hint' }, `${data.platform === 'win32' ? '屏幕右下角托盘' : '菜单栏'}的 ateam 图标可启动、停止各项目的服务，有新版本时点页头的「有新版本」更新。skill 链接被删除或平台是后来才安装的，在终端运行 ateam setup 重新配置。`))
      : step('ateam 命令与 skill',
        '推荐使用安装包：在 GitHub 的 agent-team 发布页（Releases）下载对应芯片的安装包，安装后自动完成以下配置，并提供菜单栏图标和自动更新。从源码运行时，在终端执行一次以下命令：ateam setup 会把 skill 链接到本机已安装的 Claude Code、DeepSeek Harness、WorkBuddy，并安装 hook。提示找不到 ateam 命令时，说明 npm 全局目录不在 PATH 中，需将 $(npm prefix -g)/bin 加入 ~/.zshrc 的 PATH。',
        `cd ${tool}\nnpm link\nateam setup`),
    hookStep(info),
    el('div', { class: 'helper-sec' }, el('h4', null, '每个项目')),
    step('在项目根目录启动服务', `项目须为 git 仓库。只输入 ateam 即可启动，保持该终端窗口运行，并确认输出中的「项目目录」为目标项目。也可在菜单栏的 ateam 图标中「添加项目」后启动（需安装包），服务在后台运行，无需保持终端。同时运行多个项目时，${port} 被占用会自动改用下一个空闲端口，看板请访问启动信息中的地址。`,
      `cd ${project}\nateam`),
    el('p', { class: 'hint' }, '安装完成后，在「leader」页启动 leader，在「worker」页添加 worker。'),
    // 测试用浏览器：test worker 做测试、演播都在这个独立的 Chrome 里操作，和你平时用的 Chrome 互不影响
    el('div', { class: 'helper-sec' }, el('h4', null, '可选：测试浏览器')),
    el('p', { class: 'hint' }, `test worker 使用哪个浏览器在「设置 → 测试用的浏览器」中选择，当前为「${(data.config?.testBrowser ?? 'platform') === 'ego' ? 'ego-browser' : '平台自带'}」。二选一配置即可。`),
    el('div', { class: 'wcard' },
      el('div', { class: 'wcard-head' }, el('b', null, '方式一：ego-browser（DeepSeek Harness、WorkBuddy 通用）')),
      info.egoBin
        ? done(true, `已安装（${info.egoBin}）${Object.entries(info.egoSkill ?? {}).filter(([, ok]) => !ok).map(([p]) => `；${p} 的 skill 目录中未找到 ego-browser，请重新运行 ego lite 安装`).join('')}`)
        : el('p', { class: 'hint' }, '在浏览器中打开 ', el('a', { href: 'https://lite.ego.app', target: '_blank', rel: 'noopener' }, 'lite.ego.app'), ' 下载并安装 ego lite。安装时会自动把 ego-browser skill 链接到各 agent 平台，无需手动配置。安装后在「设置」中将「测试用的浏览器」改为 ego-browser。被测网站首次未登录时，test worker 会把浏览器交给你并发起提问，在 ego lite 中登录一次即可。')),
    // Windows 版只支持 ego-browser：dsh-cdp 的启动脚本和窗口控制只有 Mac 版
    ...(data.platform === 'win32' ? [el('p', { class: 'hint' }, 'Windows 版仅支持 ego-browser，无需配置「平台自带」。')] : [
    el('div', { class: 'helper-sec' }, el('h4', null, '方式二：平台自带')),
    el('p', { class: 'hint' }, '仅在 DeepSeek Harness 上使用 test worker 进行测试或演播时需要，只需配置一次；WorkBuddy 上的 test worker 使用其自带的 Chrome 插件，无需以下步骤。DeepSeek Harness 的 test worker 将打开独立的 Chrome 窗口操作页面，与日常使用的 Chrome 相互隔离，不影响书签和登录状态，也不会反复弹出「允许远程调试」提示。'),
    info.browserSkill === 'linked'
      ? el('div', { class: 'wcard' }, el('div', { class: 'wcard-head' }, el('b', null, '① 为 DeepSeek Harness 安装浏览器 skill')), done(true, `已安装（${skillsDir}/browser-cdp-setup）`))
      : step('① 为 DeepSeek Harness 安装浏览器 skill', `test worker 依据该 skill 连接浏览器并规避常见问题。${info.browserSkill === 'copied' ? '目标位置已存在复制的旧文件夹，以下命令将先删除再创建链接。' : ''}`,
        `${info.browserSkill === 'copied' ? `rm -rf ${skillsDir}/browser-cdp-setup\n` : ''}ln -s ${tool}/skills/browser-cdp-setup ${skillsDir}/browser-cdp-setup`),
    installStep2(info, installProfile),
    step('③ 由 test worker 完成后续配置', 'test worker 启动后将自动打开测试专用的 Chrome（独立窗口）并完成自检。被测网站首次未登录时，test worker 会发起提问（任务进入「等待答复」），在该窗口中登录一次即可，登录状态长期有效。', null),
    ]),
  ];
}
// 第 ③ 步：worker 的工具后 hook。每台电脑一次，按装了哪个平台分别显示
let hookInstallState = { platform: null, busy: false, msg: '', error: false };
// 一个平台一块：标题行放名称、状态和按钮，下面是命令；只有点了按钮出错或有新情况时才多一行提示
function hookPlatform(platform, label, installed, note) {
  const mine = hookInstallState.platform === platform ? hookInstallState : { busy: false, msg: '', error: false };
  const run = async (e) => {
    e.stopPropagation();
    if (hookInstallState.busy) return;
    hookInstallState = { platform, busy: true, msg: '', error: false };
    renderHelper(true);
    const out = await post('/api/hook-install', { platform });
    // 装好了由状态标签说明，只在出错时留下提示
    hookInstallState = { platform, busy: false, msg: out.ok ? '' : (out.message || '安装失败。'), error: !out.ok };
    await loadInstallInfo();
  };
  return el('div', { class: 'hook-platform' },
    el('div', { class: 'hook-head' },
      el('b', null, label),
      el('span', { class: installed ? 'hook-state ok' : 'hook-state' }, installed ? '已安装' : '未安装'),
      el('button', { class: installed ? 'btn sm' : 'btn primary sm', disabled: mine.busy, onclick: run }, mine.busy ? '安装中…' : installed ? '重新安装' : '安装')),
    installed && note ? el('p', { class: 'hook-note' }, note) : null,
    mine.msg ? el('p', { class: 'hook-note err' }, mine.msg) : null,
    promptBlock(`ateam hook install --platform ${platform}`, renderHelper));
}
function hookStep(info) {
  const title = el('div', { class: 'wcard-head' }, el('b', null, 'worker 的 hook'));
  const hint = el('p', { class: 'hint' }, '安装后，worker 每完成一次操作即可收到补充说明，空闲等待时不会持续消耗 token，测试时抢焦点的操作也会被拦截（演播卡除外）；DeepSeek Harness 还会一并安装启动插件，用于在「worker」页一键启动 worker。安装包或 ateam setup 已自动安装本机检测到的平台，此处用于查看状态和重新安装。');
  const rows = [];
  if (info.profiles?.length) rows.push(hookPlatform('dsh', 'DeepSeek Harness', info.hookInstalled, '通常几十秒内自动生效；如未生效，在所有 worker 空闲时点击菜单中的「Restart App and Host」。'));
  if (info.workbuddyHook !== null && info.workbuddyHook !== undefined) rows.push(hookPlatform('workbuddy', 'WorkBuddy', info.workbuddyHook, '重启会话后生效。'));
  if (!rows.length) rows.push(el('p', { class: 'hint' }, '未检测到 DeepSeek Harness 或 WorkBuddy。安装并启动一次后，刷新本页。'));
  return el('div', { class: 'wcard' }, title, hint, ...rows,
    el('p', { class: 'hint hook-foot' }, '平台升级后需重新安装。停用：ateam hook uninstall --platform dsh（或 workbuddy）。'));
}
let cdpWrite = { busy: false, msg: '', error: false };
// 可选的浏览器第 ② 步：profile 从本机读出来；有多个就让用户选；已经配好就只显示「已配好」
function installStep2(info, profile) {
  const title = el('div', { class: 'wcard-head' }, el('b', null, '② 在 DeepSeek Harness 中配置浏览器'));
  if (!info.profiles) return el('div', { class: 'wcard' }, title, el('p', { class: 'hint' }, '读取中…'));
  if (info.failed) return el('div', { class: 'wcard' }, title, el('p', { class: 'hint' }, '无法读取本机 DeepSeek Harness 配置（ateam 服务版本过旧），请重启 ateam serve 后重试。'));
  if (!info.profiles.length) {
    return el('div', { class: 'wcard' }, title, el('p', { class: 'hint' }, `在 ${info.profilesDir} 下未找到 DeepSeek Harness 配置。请先安装并启动一次 DeepSeek Harness。`));
  }
  const pick = info.profiles.length > 1 ? el('label', { class: 'install-pick' }, '配置：', (() => {
    const sel = el('select', { class: 'setting-select', onchange: (e) => { installProfile = e.target.value; renderHelper(true); } },
      info.profiles.map((p) => el('option', { value: p }, p)));
    sel.value = profile;
    sel.addEventListener('click', (e) => e.stopPropagation());
    return sel;
  })(), el('span', { class: 'hint' }, '（启动 worker 时使用的配置）')) : null;
  if (info.cdpConfigured?.[profile]) {
    return el('div', { class: 'wcard' }, title, pick, el('p', { class: 'hint install-done' }, `✓ 「${profile}」已配置完成。修改配置后，需在 DeepSeek Harness 菜单中点击「Restart App and Host」重启方可生效。`));
  }
  const file = `${info.profilesDir}/${profile}/cordis.patch.yml`.replace(/^\/Users\/[^/]+/, '~');
  const write = async (e) => {
    e.stopPropagation();
    if (cdpWrite.busy) return;
    cdpWrite = { busy: true, msg: '', error: false };
    renderHelper(true);
    const out = await post('/api/doctor/fix', { key: 'cdp', profile });
    cdpWrite = { busy: false, msg: out.ok ? '' : (out.message || '写入失败。'), error: !out.ok };
    await loadInstallInfo();
  };
  return el('div', { class: 'wcard' }, title, pick,
    el('p', { class: 'hint' }, '点击「写入配置」，或在终端运行以下命令（将设置追加到 DeepSeek Harness 配置文件末尾），然后在 DeepSeek Harness 菜单中点击「Restart App and Host」重启。'),
    el('div', { class: 'cdp-write' }, el('button', { class: 'btn primary sm', disabled: cdpWrite.busy, onclick: write }, cdpWrite.busy ? '写入中…' : '写入配置')),
    cdpWrite.msg ? el('p', { class: 'hook-note err' }, cdpWrite.msg) : null,
    promptBlock(`cat >> ${file} <<'EOF'\n- id: dsh-cdp\n  name: '@dougen/dsh-cdp'\n  config:\n    dataDir: ${info.home}/.chrome-agent\nEOF`, renderHelper));
}
// leader 的加入提示词：不带需求，先就位；新开会话和会话重开都用这一句
function leadPrompt() {
  return `使用 ateam-lead skill，作为 leader 加入这个项目的团队。
先运行 ateam status 了解现状，再用 Monitor 后台启动 ateam watch --follow 监听。
如果「待你处理」里有事，先接着处理；没有的话，简单告诉我现状（有哪些 worker 在线、有没有没做完的需求），然后等我说需求。不要自己找活干。`;
}
// 标准角色：看板上总是列出来，leader skill 里也按这几个拆任务
const STANDARD_ROLES = [
  { key: 'product', label: '产品', what: '编写产品文档，不涉及代码' },
  { key: 'architect', label: '架构', what: '编写架构设计文档，不涉及代码' },
  { key: 'frontend', label: '前端', what: '页面和交互' },
  { key: 'backend', label: '后端', what: '接口和数据' },
  { key: 'test', label: '测试', what: '按验收标准测试并编写报告' },
  { key: 'critic', label: '审卡', what: '审核任务卡质量，不涉及代码' },
];
// 「在 DeepSeek Harness 中启动」：由 ateam 通过 DSH 插件新开会话并发出上面的提示词
let spawnState = { role: null, busy: false, msg: '', error: false };
let spawnTimer = 0;
// 「worker」页和任务详情里都有「启动」，状态共用一份，两边一起重画
function rerenderSpawn() {
  renderHelper(true);
  if (view.task) renderDrawer();
}
const platformLabel = () => ((data.config?.spawnPlatform ?? 'dsh') === 'workbuddy' ? 'WorkBuddy' : 'DeepSeek Harness');
// taskId：从任务详情里点的。worker 加入后很快就领走这张卡，「分配 worker」一节随之消失，提示要换个地方留着
function spawnButton(role, taskId = null) {
  const mine = spawnState.role === role ? spawnState : { busy: false };
  const start = async (e) => {
    e.stopPropagation();
    if (spawnState.busy) return;
    clearTimeout(spawnTimer);
    spawnState = { role, taskId, busy: true, msg: '', error: false };
    rerenderSpawn();
    const out = await post('/api/spawn', { role, by: 'user' });
    spawnState = out.ok
      ? { role, taskId, busy: false, msg: (out.sent ? `已在 ${platformLabel()} 中新建会话，worker 加入后将显示在下方「在线 worker」中。` : (out.note || '已填入提示词，请在对应窗口中按回车发送。')) + (out.over ? `当前在线 worker 将达 ${out.count} 个，已超过设定的上限（${out.max} 个）。` : ''), error: false }
      : { role, taskId, busy: false, msg: out.message || '启动失败。', error: true };
    rerenderSpawn();
    // 提示过一会儿自动消失：成功的 10 秒，出错的 30 秒（留时间看清原因）
    spawnTimer = setTimeout(() => { spawnState = { role: null, busy: false, msg: '', error: false }; rerenderSpawn(); }, spawnState.error ? 30000 : 10000);
  };
  return el('button', { class: 'btn ghost sm spawn-btn', disabled: mine.busy, title: `在 ${platformLabel()} 中新建会话并自动发送下方提示词（平台可在「设置」中切换）`, onclick: start },
    icon('play'), mine.busy ? '启动中…' : '启动');
}
function spawnMessage(role) {
  if (spawnState.role !== role || !spawnState.msg) return null;
  return el('p', { class: `spawn-msg${spawnState.error ? ' err' : ''}` }, spawnState.msg);
}
function workerPrompt(role) {
  return `使用 ateam-worker skill，角色 ${role}`;
}
function promptBox(role) {
  return promptBlock(workerPrompt(role), render);
}
// 一段可复制的提示词；rerender 用来刷新「已复制」状态
function promptBlock(text, rerender) {
  const done = copied === text;
  return el('div', { class: 'pblock' },
    el('code', null, text),
    el('button', {
      class: `btn sm${done ? ' done' : ''}`,
      onclick: async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); copied = text; } catch { copied = null; }
        rerender();
        setTimeout(() => { if (copied === text) { copied = null; rerender(); } }, 2000);
      },
    }, done ? '已复制' : '复制'));
}
// 待领取、依赖已满足、但没有同角色在线 worker 的任务 → 需要有人开新窗口接手
function rolesNeedingWorkers() {
  const { tasks, agents } = data.state;
  const approved = new Set(tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  const onlineRoles = new Set(agents.filter((a) => a.status === 'online').map((a) => a.role.trim().toLowerCase()));
  // 暂停领取的卡（单张或整个需求）不派发，不算缺人
  const heldJobs = new Set(data.state.jobs.filter((j) => j.onHold).map((j) => j.id));
  const byRole = new Map();
  for (const t of tasks) {
    if (t.status !== 'pending' || t.onHold || heldJobs.has(t.jobId) || !t.dependsOn.every((d) => approved.has(d))) continue;
    if (onlineRoles.has(t.role.trim().toLowerCase())) continue;
    if (!byRole.has(t.role)) byRole.set(t.role, []);
    byRole.get(t.role).push(t);
  }
  return byRole;
}
// 「有任务没人做」：并进了页头的「需要你处理」（缺人那几项可以就地展开提示词），这里不再单独弹气泡
function renderNeeds() {
  const box = document.getElementById('needs');
  box.hidden = true;
  box.replaceChildren();
}
