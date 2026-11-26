// 安装引导：安装检查、hook 安装、浏览器插件、leader 提示词所在的安装页

import { data } from './state.js';
import { el, post } from './util.js';
import { promptBlock, renderHelper } from './helper.js';

// 提示词：在新的 agent 窗口里对 worker 说的话
// leader 的提示词：在项目目录里开一个 Claude Code 会话发给它
// 「安装」页：一次性安装步骤，命令里的路径用服务所在的真实目录
// 本机安装情况（DeepSeek Harness 的 skill 目录、profile、是否已装好），进「安装」页时读一次
let installInfo = null;
export let installProfile = null;
// 下次进「安装」页时重新读本机情况
export function resetInstallInfo() { installInfo = null; }
async function loadInstallInfo() {
  installInfo = {}; // 读取中，避免重画时重复请求
  try {
    const out = await (await fetch('/api/install-info', { cache: 'no-store' })).json();
    // 旧服务没有这个接口：按默认路径显示（profiles 为空数组时第 ② 步会提示）
    installInfo = out.ok ? out : { failed: true, profiles: [], profilesDir: '~/.dsh/profiles' };
  } catch { installInfo = { failed: true, profiles: [], profilesDir: '~/.dsh/profiles' }; }
  renderHelper(true);
}
export function installGuide() {
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
