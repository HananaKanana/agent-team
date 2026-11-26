// 「设置」页：设置项、保存、测试报告模板

import { prefs } from './prefs.js';
import { data } from './state.js';
import { el, renderMarkdown } from './util.js';
import { renderHelper } from './helper.js';
import { renderMain } from './jobs.js';
import { syncSettings } from './sync.js';
import { markRelated } from './search.js';
import { openConfirm } from './dialogs.js';
import { poll } from './app.js';

// 改一项存一项。数字框在失去焦点或回车时保存；正在输入时轮询不重画面板（见 renderHelper）。
const SETTING_ITEMS = [
  { group: 'worker' },
  { key: 'idleMin', type: 'num', label: '空闲申请下线时长（分钟）', hint: 'worker 空闲超过该时长后直接下线，避免空等消耗 token。该角色还有等待依赖的任务、有需求正在拆分任务，或它是需保留的最后一个时，改为向 leader 申请下线；leader 未连接时直接下线（开启「每个角色至少保留一个 worker」时，该角色的最后一个除外）。只剩暂停领取或依赖未完成的任务时也算空闲。' },
  { key: 'leaseMin', type: 'num', label: '无响应判定时长（分钟）', hint: '持有任务的 worker 超过该时长无活动时，弹窗请求确认其状态；空闲 worker 直接判定为离线。活动从最后一次调用 ateam 或工具调用（已安装 hook 时）算起；执行耗时命令前已报备的 worker 不受影响。' },
  { key: 'leaderSpawn', type: 'bool', label: '允许 leader 自动启动 worker', hint: '开启后，某一角色有待领取的任务但没有在线 worker 时，leader 可自行在下方选择的平台中启动 worker。关闭时 leader 只会提醒你；「worker」页的「启动」按钮不受此项限制。' },
  { key: 'spawnPlatform', type: 'choice', options: [['dsh', 'DeepSeek Harness'], ['workbuddy', 'WorkBuddy']], label: '启动 worker 的平台', hint: '「worker」页的「启动」按钮和 leader 的自动启动都在该平台中新建会话。DeepSeek Harness 需先在「安装」页安装 hook（含启动插件）。WorkBuddy 会被切到前台并自动填入提示词，自动发送需要在「系统设置 → 隐私与安全性 → 辅助功能」中允许运行 ateam serve 的终端，否则需手动按回车。' },
  { key: 'maxWorkers', type: 'int', min: 0, label: '同时在线 worker 上限', hint: 'leader 自动启动 worker 时，在线 worker（含刚启动、尚未加入的）达到该数量后不再启动，避免过多 worker 同时消耗额度。「worker」页的「启动」按钮不受限制，超出时仅作提示。设为 0 表示不限。' },
  { key: 'rotateCtx', type: 'int', min: 0, label: '换新会话的上下文阈值（万 token）', hint: 'worker 连续在同一会话中处理多张任务时，先前的对话会保留在上下文中，此后每次调用都需重新读入，单张任务的消耗随之上升。worker 最近一次调用读入的上下文超过该值时，当前任务通过后不再领取新任务并下线，服务随即在上方选择的平台中启动一个同角色的新 worker 继续处理（该角色暂无可领取的任务时不启动）。仅适用于 DeepSeek Harness 和 Claude Code 的 worker；WorkBuddy 没有本机用量记录，不受影响。设为 0 表示不换。' },
  { key: 'testBrowser', type: 'choice', options: [['platform', '平台自带'], ['ego', 'ego-browser']], label: '测试用的浏览器', hint: 'test worker 测试和预演时使用的浏览器，派发测试卡时写入任务说明，worker 按此使用。「平台自带」：DeepSeek Harness 使用 dsh-cdp，WorkBuddy 使用其自带的 Chrome 插件。「ego-browser」：两个平台均使用 ego lite 浏览器（需先安装，见「安装」页）。演播按预演时记录的工具执行，更换浏览器后需重新预演。' },
  { key: 'keepOnePerRole', type: 'bool', label: '每个角色至少保留一个 worker', hint: '开启后，某一角色的最后一个 worker 下线需经用户同意（leader 会先行征询）。关闭后 leader 可直接让其下线。' },
  { group: '审卡' },
  { key: 'criticAutoLeave', type: 'bool', label: '审核完成后自动下线', hint: '审卡 worker 审核完所有待审任务后自动下线（新启动的同样适用），有新任务需审核时再启动。关闭后审卡 worker 常驻，仅在用户要求时下线。' },
  { group: 'review' },
  { key: 'submitChecks', type: 'text', label: '提交检查命令', placeholder: 'bash build-tools/scripts/check-size.sh\nbash build-tools/scripts/check-dup.sh', hint: '开发任务执行 ateam submit 时，在 worker 一侧的项目目录中逐行运行以下命令，任一命令退出码非 0 即拒绝提交，并将输出末尾返回给 worker；时间线记录检查结果。每行一条，以 # 开头的行忽略；留空表示不检查。命令可读取环境变量 ATEAM_CHANGED_FILES（本任务改动的文件，每行一个）与 ATEAM_TASK_PATHS（任务路径），用于只检查本任务的改动。测试、产品、架构任务不运行。' },
  { key: 'submitCheckMin', type: 'int', label: '单条检查命令超时（分钟）', hint: '单条命令超过该时长未结束即视为未通过。' },
  { key: 'rejectLimit', type: 'int', label: '打回次数上限', hint: '同一任务被打回达到该次数后停止自动派发并挂起，转由 leader 处理（改写任务或直接修改）。' },
  { group: 'leader' },
  { key: 'autoNoLeader', type: 'bool', label: 'leader 离线时自动进入无 leader 模式', hint: '关闭时，仅在「帮助 → leader」中点击「下线」后进入。开启时，leader 离线（超过下方时长既未监听也未执行命令）也会自动进入，重新监听或执行命令后自动退出。token 用尽后，leader 的后台监听最多仍会保持约半小时，期间视为在线。' },
  { key: 'leaderAwayMin', type: 'int', label: '离线判定时长（分钟）', hint: '仅在上方自动进入开关开启时生效。' },
];
let settingsMsg = '';
export function clearSettingsMsg() { settingsMsg = ''; }
// 触屏模式：默认关闭。开了以后按住拖动就滚动，但拖选文字会变成滚动
export let touchScroll = false;
try { touchScroll = prefs.get('ateam.touchScroll') === '1'; } catch {}
// 触屏模式下没有悬停，靠悬停才出现的按钮（概览卡的「暂停领取」等）一直显示
document.documentElement.classList.toggle('touch-mode', touchScroll);
// 看板空列收窄：没有卡的列收成窄竖条。默认关闭
export let slimLanes = false;
try { slimLanes = prefs.get('ateam.slimLanes') === '1'; } catch {}
// 悬停卡片时标出依赖关系：默认关闭（框和标签多了看着重）
export let showRelations = false;
try { showRelations = prefs.get('ateam.showRelations') === '1'; } catch {}
// 「测试用的浏览器」选 ego-browser 时：列出自动启用的测试用 profile（ego 中名称以 ateam 开头的 profile）
let egoRefreshing = false;
async function refreshEgoProfiles() {
  egoRefreshing = true;
  renderHelper(true);
  try { await fetch('/api/ego-profiles?fresh=1', { cache: 'no-store' }); } catch {}
  egoRefreshing = false;
  await poll();
  renderHelper(true);
}
function egoProfilesSetting() {
  const info = data.egoProfiles ?? { list: [], at: 0, error: null };
  const list = info.list ?? [];
  const status = !info.at ? '正在读取 ego 中的 profile……'
    : list.length ? `已启用 ${list.length} 个：${list.map((p) => p.name).join('、')}。`
    : '未找到名称以 ateam 开头的 profile，所有 test worker 均使用默认 profile，登录状态互相共用。';
  const btn = el('button', { class: 'btn', type: 'button', disabled: egoRefreshing, onclick: (e) => { e.preventDefault(); e.stopPropagation(); refreshEgoProfiles(); } }, egoRefreshing ? '读取中…' : '刷新');
  return el('div', { class: 'setting' }, btn, el('span', null,
    el('b', null, '测试用 profile'),
    el('span', { class: 'hint' }, status, info.error ? ` ${info.error}` : ''),
    el('span', { class: 'hint' }, '各 profile 的 Cookie 和登录状态相互独立。test worker 领取测试卡或开始预演、演播时，自动分配一个未被占用的 profile 供其独占：优先沿用该 worker 或该任务上次使用的 profile；任务提交、作废、收回或 worker 离线后释放；全部被占用时使用默认 profile，并在任务说明中提示可能互相挤下线。ego 未提供新建 profile 的接口：如需增加，请在 ego lite 中新建 profile 并以 ateam 开头命名（如 ateam4），然后点击「刷新」。')));
}
export async function saveSetting(key, value) {
  try {
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: value }) });
    const out = await res.json();
    settingsMsg = out.ok ? '已保存。' : out.message;
  } catch { settingsMsg = '无法连接 ateam 服务。'; }
  await poll();
  renderHelper(true);
}
export function settingsPage() {
  const cfg = data.config || {};
  if (!data.config) return el('p', { class: 'hint' }, '当前服务版本不支持设置，请重启 ateam serve。');
  return [
    el('p', { class: 'tab-hint' }, '以下设置对整个项目生效，修改后立即生效，重启服务后保留。'),
    SETTING_ITEMS.map((it) => {
      if (it.group) return el('div', { class: 'helper-sec' }, el('h4', null, it.group));
      let input;
      if (it.type === 'bool') {
        input = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
        input.checked = !!cfg[it.key];
        input.addEventListener('change', () => saveSetting(it.key, input.checked));
      } else if (it.type === 'choice') {
        input = el('select', { class: 'setting-num' }, it.options.map(([value, label]) => el('option', { value }, label)));
        input.value = String(cfg[it.key]);
        input.addEventListener('change', () => saveSetting(it.key, input.value));
        // Windows 版只支持 ego-browser（服务端也按 ego 处理）
        if (it.key === 'testBrowser' && data.platform === 'win32') input.disabled = true;
      } else if (it.type === 'text') {
        input = el('textarea', { class: 'setting-text setting-area', rows: '4', spellcheck: 'false', placeholder: it.placeholder || '' });
        input.value = String(cfg[it.key] ?? '');
        input.addEventListener('change', () => saveSetting(it.key, input.value));
      } else {
        input = el('input', { type: 'number', class: 'setting-num', min: String(it.min ?? 1), step: it.type === 'int' ? '1' : 'any' });
        input.value = String(cfg[it.key]);
        input.addEventListener('change', () => saveSetting(it.key, input.value));
      }
      input.addEventListener('click', (e) => e.stopPropagation());
      const hint = it.key === 'testBrowser' && data.platform === 'win32' ? `${it.hint}Windows 版仅支持 ego-browser。` : it.hint;
      const row = el(it.type === 'text' ? 'div' : 'label', { class: it.type === 'text' ? 'setting setting-block' : 'setting' }, input, el('span', null, el('b', null, it.label), el('span', { class: 'hint' }, hint)));
      return it.key === 'testBrowser' && cfg.testBrowser === 'ego' ? [row, egoProfilesSetting()] : row;
    }),
    settingsMsg ? el('p', { class: 'hint' }, settingsMsg) : null,
    el('div', { class: 'helper-sec' }, el('h4', null, '多人协作')),
    syncSettings(),
    el('div', { class: 'helper-sec' }, el('h4', null, '显示偏好')),
    (() => {
      const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
      input.checked = touchScroll;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        touchScroll = input.checked;
        document.documentElement.classList.toggle('touch-mode', touchScroll);
        try { prefs.set('ateam.touchScroll', touchScroll ? '1' : '0'); } catch {}
      });
      return el('label', { class: 'setting' }, input, el('span', null, el('b', null, '触屏模式'),
        el('span', { class: 'hint' }, '适用于 Mac 外接触摸屏：在列表、看板和详情面板中按住拖动即可上下或左右滚动。开启后，鼠标拖选文字也会变为滚动（输入框除外，提示词请使用复制按钮）。保存在本机，所有项目通用。')));
    })(),
    (() => {
      const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
      input.checked = slimLanes;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        slimLanes = input.checked;
        try { prefs.set('ateam.slimLanes', slimLanes ? '1' : '0'); } catch {}
        renderMain();
      });
      return el('label', { class: 'setting' }, input, el('span', null, el('b', null, '空列收窄'),
        el('span', { class: 'hint' }, '看板中没有任务的列收窄显示，空间留给有任务的列；关闭后各列等宽。保存在本机，所有项目通用。')));
    })(),
    (() => {
      const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
      input.checked = showRelations;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        showRelations = input.checked;
        try { prefs.set('ateam.showRelations', showRelations ? '1' : '0'); } catch {}
        markRelated(null);
      });
      return el('label', { class: 'setting' }, input, el('span', null, el('b', null, '悬停显示依赖关系'),
        el('span', { class: 'hint' }, '鼠标悬停在任务卡上时，高亮其依赖的任务和下游任务并显示标签。关闭后，卡片上的「等依赖」和右键菜单中的相关任务仍可使用。保存在本机，所有项目通用。')));
    })(),
  ];
}
// 测试报告模板编辑器：存在 .ateam/test-template.md。没改过、或重置了，显示和使用 ateam 自带的模板
export let testTpl = { loaded: false, loading: false, saved: '', draft: '', custom: false, def: '', status: '', mode: 'edit' };
async function loadTestTpl() {
  if (testTpl.loading) return;
  testTpl.loading = true;
  try {
    const json = await (await fetch('/api/test-template', { cache: 'no-store' })).json();
    if (!json.ok) throw new Error(json.message);
    // 上次没保存的修改保留着（比如切到别的页又切回来）
    const keep = testTpl.draft !== testTpl.saved;
    testTpl = { ...testTpl, loaded: true, saved: json.text, draft: keep ? testTpl.draft : json.text, custom: json.custom, def: json.default, status: keep ? '有未保存的修改。' : '' };
  } catch {
    testTpl = { ...testTpl, loaded: true, status: '读取失败，请重启 ateam serve 以更新服务版本。' };
  }
  testTpl.loading = false;
  renderHelper(true);
}
async function saveTestTpl(text, okMsg) {
  try {
    const res = await fetch('/api/test-template', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.message);
    testTpl = { ...testTpl, saved: json.text, draft: json.text, custom: json.custom, def: json.default, status: json.custom ? okMsg : '已恢复为默认模板。' };
  } catch (err) {
    testTpl = { ...testTpl, status: `保存失败：${err.message}` };
  }
  renderHelper(true);
}
// 预览用的示例卡
const TPL_SAMPLE = { id: 'T12', title: '登录页测试', acceptance: ['输错密码提示「用户名或密码错误」', '登录成功后跳到首页，右上角显示用户名'] };
function fillTestTemplate(text, task, agentId) { // 同 src/format.js 的 fillTestTemplate
  const one = (a) => String(a).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return String(text)
    .replace(/\{\{#每条\}\}\n?([\s\S]*?)\{\{\/每条\}\}\n?/g, (_, block) => task.acceptance.map((a, i) => block.replace(/\{\{序号\}\}/g, String(i + 1)).replace(/\{\{验收标准\}\}/g, one(a))).join(''))
    .replace(/\{\{卡号\}\}/g, task.id).replace(/\{\{标题\}\}/g, task.title).replace(/\{\{测试人\}\}/g, agentId)
    .replace(/\{\{验收标准\}\}/g, task.acceptance.map((a, i) => `${i + 1}. ${one(a)}`).join('\n'));
}
export function testTemplateEditor() {
  if (!testTpl.loaded) { loadTestTpl(); return el('p', { class: 'hint' }, '读取中……'); }
  const dirty = testTpl.draft !== testTpl.saved;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const setMode = (m) => stop(() => { testTpl.mode = m; renderHelper(true); });
  const saveBtn = el('button', { class: 'btn primary sm', disabled: !dirty, onclick: stop(() => saveTestTpl(testTpl.draft, '已保存。此后领取的测试任务将按此模板编写报告。')) }, '保存');
  const undoBtn = el('button', { class: 'btn ghost sm', disabled: !dirty, onclick: stop(() => { testTpl = { ...testTpl, draft: testTpl.saved, status: '' }; renderHelper(true); }) }, '撤销修改');
  const resetBtn = el('button', {
    class: 'btn ghost sm', disabled: !testTpl.custom && !dirty,
    onclick: stop(() => openConfirm({
      title: '重置为默认模板？', body: '将删除自定义模板（.ateam/test-template.md），此后测试任务使用默认模板。', ok: '重置',
      run: async () => { await saveTestTpl('', ''); return { ok: true }; },
    })),
  }, '重置为默认模板');
  let body;
  if (testTpl.mode === 'view') {
    const box = el('div', { class: 'tpl-preview md' });
    box.innerHTML = renderMarkdown(fillTestTemplate(testTpl.draft, TPL_SAMPLE, 'test-1')); // renderMarkdown 先转义了 HTML
    body = box;
  } else {
    const area = el('textarea', { class: 'rules-editor tpl-editor', spellcheck: 'false' });
    area.value = testTpl.draft;
    area.addEventListener('click', (e) => e.stopPropagation());
    area.addEventListener('input', () => {
      testTpl.draft = area.value;
      saveBtn.disabled = testTpl.draft === testTpl.saved;
      undoBtn.disabled = saveBtn.disabled;
      resetBtn.disabled = !testTpl.custom && saveBtn.disabled;
    });
    body = area;
  }
  const code = (t) => el('code', {}, t);
  return el('div', { class: 'rules-page tpl-page' },
    el('div', { class: 'tpl-head' }, el('b', null, '测试报告模板'),
      el('span', { class: `tpl-badge${testTpl.custom ? ' custom' : ''}` }, testTpl.custom ? '自定义模板' : '默认模板')),
    el('p', { class: 'tab-hint' }, 'test worker 领取测试任务时，按此模板创建测试报告并编写用例（Markdown 格式）。如需采用客户指定格式，请在此按客户模板调整栏目；客户提供 Excel / Word 模板时，可由 leader 派发任务转换为 Markdown 后粘贴至此。可用占位符：',
      code('{{卡号}}'), ' ', code('{{标题}}'), ' ', code('{{测试人}}'), ' ', code('{{验收标准}}'), '（编号列表）；', code('{{#每条}}'), '…', code('{{/每条}}'),
      ' 之间的内容按验收标准逐条重复，其中可使用 ', code('{{序号}}'), ' ', code('{{验收标准}}'), '。'),
    el('div', { class: 'rules-bar' },
      el('div', { class: 'seg' },
        el('button', { class: testTpl.mode !== 'view' ? 'on' : '', onclick: setMode('edit') }, '编辑'),
        el('button', { class: testTpl.mode === 'view' ? 'on' : '', onclick: setMode('view') }, '示例预览'))),
    body,
    el('div', { class: 'rules-foot' }, saveBtn, undoBtn, resetBtn,
      testTpl.status ? el('span', { class: 'hint' }, testTpl.status) : null,
      el('span', { class: 'path' }, testTpl.custom ? '存储位置：.ateam/test-template.md' : '当前使用默认模板')));
}
