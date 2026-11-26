'use strict';
// 「推送到手机」设置和每日摘要

let pushCfg = null;
let pushOn = false; // 总开关
let pushLoading = false;
const pushDraft = {}; // 渠道 → 正在输入、还没保存的字段
const pushMsg = {};   // 渠道 → { text, error }
const PUSH_FIELD = { token: 'token', webhook: 'webhook 地址', secret: '签名密钥（未开启签名校验时留空）' };
const PUSH_HINT = {
  pushplus: '在 pushplus.plus 用微信扫码登录，复制 token。免费版每天有发送条数上限。',
  feishu: '群设置 → 群机器人 → 添加「自定义机器人」，复制 webhook 地址；开启了「签名校验」时同时填写密钥。',
  wecom: '群聊 → 添加群机器人，复制 webhook 地址。',
  dingtalk: '群设置 → 机器人 → 添加「自定义」机器人，复制 webhook 地址；安全设置选「加签」时填写密钥，选「自定义关键词」时将关键词设为 ateam。',
};
async function loadPush() {
  pushLoading = true;
  try { const out = await (await fetch('/api/push', { cache: 'no-store' })).json(); pushCfg = out.channels ?? null; pushOn = !!out.enabled; pushExtra = out.prefs ? { prefs: out.prefs, digest: out.digest, eventTypes: out.eventTypes, digestSections: out.digestSections } : null; } catch {}
  pushLoading = false;
  if (helper.open && helper.tab === 'push') renderHelper(true);
}
async function savePushChannel(ch, on) {
  try {
    const out = await post('/api/push', { channel: ch, values: pushDraft[ch] ?? {}, ...(on === undefined ? {} : { on }) });
    if (out.ok) { pushCfg = out.channels; pushOn = !!out.enabled; delete pushDraft[ch]; pushMsg[ch] = { text: on === undefined ? '已保存。' : on ? '已开启。' : '已关闭。' }; }
    else pushMsg[ch] = { text: out.message || '保存失败。', error: true };
  } catch { pushMsg[ch] = { text: '无法连接 ateam 服务。', error: true }; }
  renderHelper(true);
}
async function testPush(ch) {
  if (pushDraft[ch] && Object.keys(pushDraft[ch]).length) { pushMsg[ch] = { text: '请先保存再发送测试。', error: true }; renderHelper(true); return; }
  pushMsg[ch] = { text: '发送中…' };
  renderHelper(true);
  try {
    const out = await post('/api/push/test', { channel: ch });
    pushMsg[ch] = out.ok ? { text: '已发送，请在手机上查看。' } : { text: out.message || '发送失败。', error: true };
  } catch { pushMsg[ch] = { text: '无法连接 ateam 服务。', error: true }; }
  renderHelper(true);
}
// 推送页各块默认收起，只显示一行摘要；展开的记在这里（重画不丢）
const pushOpen = new Set();
function pushFold(key, title, summary, right) {
  const open = pushOpen.has(key);
  return el('div', {
    class: `push-fold${open ? ' open' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
    onclick: (e) => { if (e.target.closest('input, select, button, label')) return; e.stopPropagation(); if (open) pushOpen.delete(key); else pushOpen.add(key); renderHelper(true); },
    onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.currentTarget.click(); } },
  }, icon('chev-down'), el('b', null, title), el('span', { class: 'hint fold-sum' }, summary), right ?? null);
}
// 推哪些事、格式、定时小结（push.json 里，所有项目共用）
let pushExtra = null;
let pushExtraMsg = '';
let pushPreview = null; // { kind, title, lines } 或 { kind, error }
async function savePushPrefs(body) {
  const out = await post('/api/push/prefs', body);
  if (out.ok) { pushExtra.prefs = out.prefs; pushExtraMsg = '已保存。'; } else pushExtraMsg = out.message || '保存失败。';
  renderHelper(true);
}
async function saveDigestCfg(kind, body) {
  const out = await post('/api/push/digest', { kind, ...body });
  if (out.ok) { pushExtra.digest = out.digest; pushExtraMsg = '已保存。'; } else pushExtraMsg = out.message || '保存失败。';
  renderHelper(true);
}
async function previewDigest(kind) {
  pushPreview = { kind, loading: true };
  renderHelper(true);
  try {
    const out = await (await fetch(`/api/push/digest?kind=${kind}`, { cache: 'no-store' })).json();
    pushPreview = !out.ok ? { kind, error: out.message } : out.preview ? { kind, ...out.preview } : { kind, error: '这段时间没有任何进展，到点时不会发送。' };
  } catch { pushPreview = { kind, error: '无法连接 ateam 服务。' }; }
  renderHelper(true);
}
async function sendDigestNow(kind) {
  pushExtraMsg = '发送中…';
  renderHelper(true);
  const out = await post('/api/push/digest/send', { kind });
  pushExtraMsg = out.ok ? `已发送到 ${out.sent} 个渠道${out.failed?.length ? `，${out.failed.length} 个失败` : ''}。` : out.message || '发送失败。';
  renderHelper(true);
}
function pushOptions() {
  if (!pushExtra) return el('p', { class: 'hint' }, '当前服务版本不支持推送内容和定时小结设置，请重启 ateam 服务。');
  const { prefs, digest, eventTypes, digestSections } = pushExtra;
  const stop = (n) => { n.addEventListener('click', (e) => e.stopPropagation()); return n; };
  const sw = (checked, onChange, label) => { const i = stop(el('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label })); i.checked = checked; i.addEventListener('change', () => onChange(i.checked)); return i; };
  const row = (input, title, hint) => el('label', { class: 'setting' }, input, el('span', null, el('b', null, title), hint ? el('span', { class: 'hint' }, hint) : null));
  const timeInput = (value, onChange) => { const i = stop(el('input', { type: 'time', class: 'setting-num', value })); i.addEventListener('change', () => i.value && onChange(i.value)); return i; };
  const fmt = prefs.format;
  const style = stop(el('select', { class: 'setting-num' }, el('option', { value: 'detail' }, '详细'), el('option', { value: 'brief' }, '简洁')));
  style.value = fmt.brief ? 'brief' : 'detail';
  style.addEventListener('change', () => savePushPrefs({ format: { brief: style.value === 'brief' } }));
  const prefix = stop(el('input', { type: 'text', class: 'setting-text', value: fmt.prefix, placeholder: '不加前缀', maxlength: '20' }));
  prefix.style.width = '140px';
  prefix.addEventListener('change', () => savePushPrefs({ format: { prefix: prefix.value } }));
  const weekday = stop(el('select', { class: 'setting-num' }, ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((w, i) => el('option', { value: String(i) }, w))));
  weekday.value = String(digest.weekly.weekday);
  weekday.addEventListener('change', () => saveDigestCfg('weekly', { weekday: Number(weekday.value) }));
  const pv = pushPreview;
  const evOn = Object.keys(eventTypes).filter((k) => prefs.events[k] !== false).length;
  const fmtSum = [fmt.brief ? '简洁' : '详细', fmt.link ? '附链接' : '不附链接', fmt.merge ? '合并推送' : '逐条推送', fmt.prefix ? `前缀「${fmt.prefix}」` : '无前缀'].join(' · ');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const digestSum = [digest.daily.on ? `每日 ${digest.daily.time}` : null, digest.weekly.on ? `每${week[digest.weekly.weekday]} ${digest.weekly.time}` : null].filter(Boolean).join('、') || '未开启';
  const sec = (key, title, summary, body) => el('div', { class: 'push-group' }, pushFold(key, title, summary), pushOpen.has(key) ? el('div', { class: 'push-group-body' }, body) : null);
  return [
    sec('events', '推送哪些事项', evOn === Object.keys(eventTypes).length ? '全部类型' : `${evOn} / ${Object.keys(eventTypes).length} 类`, [
    el('p', { class: 'hint' }, '「待处理」中新出现的事项按类型推送。关闭的类型不推送，看板和菜单栏照常提示。'),
    Object.entries(eventTypes).map(([k, label]) => row(sw(prefs.events[k] !== false, (on) => savePushPrefs({ events: { [k]: on } }), label), label))]),
    sec('format', '格式', fmtSum, [
    el('label', { class: 'setting' }, style, el('span', null, el('b', null, '内容'), el('span', { class: 'hint' }, '详细：标题加逐项明细；简洁：只推一行标题（几件事合并时只写数量，小结压成一行）。'))),
    row(sw(fmt.link, (on) => savePushPrefs({ format: { link: on } }), '附带看板链接'), '附带看板链接', '附局域网只读看板的地址，手机连接同一网络时可直接打开并定位到对应事项。'),
    row(sw(fmt.merge, (on) => savePushPrefs({ format: { merge: on } }), '多项合并为一条'), '同时出现的多项合并为一条', '关闭后每件事单独推送一条。'),
    el('label', { class: 'setting' }, prefix, el('span', null, el('b', null, '标题前缀'), el('span', { class: 'hint' }, '标题形如「前缀 · 项目名：内容」，留空则不加。钉钉机器人用「自定义关键词」校验时，关键词须出现在标题中。')))]),
    sec('digest', '定时小结', digestSum, [
    el('p', { class: 'hint' }, '到点时，通过上方开启的渠道推送各项目的小结：每日小结统计当天，每周小结统计最近 7 天。服务未运行时不补发；这段时间没有任何进展时不发送。'),
    el('label', { class: 'setting' }, sw(digest.daily.on, (on) => saveDigestCfg('daily', { on }), '每日小结'), el('span', null, el('b', null, '每日小结'), el('span', { class: 'hint push-time' }, '每天 ', timeInput(digest.daily.time, (v) => saveDigestCfg('daily', { time: v })), ' 发送'))),
    el('label', { class: 'setting' }, sw(digest.weekly.on, (on) => saveDigestCfg('weekly', { on }), '每周小结'), el('span', null, el('b', null, '每周小结'), el('span', { class: 'hint push-time' }, '每', weekday, ' ', timeInput(digest.weekly.time, (v) => saveDigestCfg('weekly', { time: v })), ' 发送'))),
    el('p', { class: 'hint' }, '小结包含：'),
    el('div', { class: 'push-sections' }, Object.entries(digestSections).map(([k, [label, def]]) => {
      const c = stop(el('input', { type: 'checkbox' }));
      c.checked = digest.sections[k] ?? def;
      c.addEventListener('change', () => saveDigestCfg('sections', { sections: { [k]: c.checked } }));
      return el('label', { class: 'push-section' }, c, label);
    })),
    el('div', { class: 'push-actions' },
      el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); previewDigest('daily'); } }, '预览每日小结'),
      el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); previewDigest('weekly'); } }, '预览每周小结'),
      pv && !pv.loading && !pv.error ? el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); sendDigestNow(pv.kind); } }, '立即发送这份') : null,
      pushExtraMsg ? el('span', { class: 'hint' }, pushExtraMsg) : null),
    pv ? el('div', { class: 'push-preview' }, pv.loading ? '生成中…' : pv.error ? pv.error : [el('b', null, pv.title), pv.lines.map((l) => {
      // 「**今天完成**」这样的小标题加粗显示，「**Token**：…」只加粗前面一段
      const m = l.match(/^\*\*(.+?)\*\*(.*)$/);
      return m ? el('div', { class: m[2] ? '' : 'push-preview-h' }, el('b', { class: 'inline' }, m[1]), m[2]) : el('div', null, l);
    })]) : null]),
  ];
}
async function setPushOn(on) {
  const out = await post('/api/push', { enabled: on });
  if (out.ok) { pushCfg = out.channels; pushOn = !!out.enabled; }
  renderHelper(true);
}
function pushPage() {
  if (READONLY) return el('p', { class: 'hint' }, '推送配置仅可在运行 ateam 的电脑上查看和修改。');
  if (!pushCfg) { if (!pushLoading) loadPush(); return el('p', { class: 'hint' }, '读取中…'); }
  const master = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  master.checked = pushOn;
  master.addEventListener('change', () => setPushOn(master.checked));
  master.addEventListener('click', (e) => e.stopPropagation());
  const head = el('label', { class: 'setting push-master' }, master, el('span', null, el('b', null, '推送到手机'),
    el('span', { class: 'hint' }, '开启后，待你处理的事项通过下方开启的渠道推送到手机或群聊。关闭时所有渠道都不推送，已填写的配置保留。')));
  if (!pushOn) return [head];
  return [
    head,
    el('p', { class: 'hint' }, '「待处理」中新出现的事项持续 1 分钟后推送一次，可同时开启多个渠道。点各项标题展开设置。配置保存在本机 ~/.config/ateam/push.json，所有项目共用；推送内容会经过对应服务商的服务器。'),
    Object.entries(pushCfg).map(([ch, c]) => {
      const sw = el('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `开启${c.label}` });
      sw.checked = !!c.on;
      sw.addEventListener('change', () => savePushChannel(ch, sw.checked));
      const fields = c.fields.map((f) => {
        const input = el('input', { type: 'text', class: 'setting-text', placeholder: c.values[f] ? `已保存 ${c.values[f]}，留空则不修改` : '未填写', autocomplete: 'off', spellcheck: 'false' });
        input.value = pushDraft[ch]?.[f] ?? '';
        input.addEventListener('input', () => { (pushDraft[ch] ??= {})[f] = input.value; });
        return el('label', { class: 'push-field' }, el('span', { class: 'hint' }, PUSH_FIELD[f]), input);
      });
      const msg = pushMsg[ch];
      const first = c.values[c.fields[0]];
      const summary = c.on ? `已开启 · ${first || '未填写'}` : first ? `已填写，未开启 · ${first}` : '未配置';
      const open = pushOpen.has(`ch:${ch}`) || !!msg;
      if (!open) return el('div', { class: 'wcard push-channel' }, pushFold(`ch:${ch}`, c.label, summary, sw));
      return el('div', { class: 'wcard push-channel' },
        pushFold(`ch:${ch}`, c.label, summary, sw),
        el('p', { class: 'hint' }, PUSH_HINT[ch]),
        fields,
        el('div', { class: 'push-actions' },
          el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); savePushChannel(ch); } }, '保存'),
          el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); testPush(ch); } }, '发送测试'),
          msg ? el('span', { class: msg.error ? 'hint push-err' : 'hint' }, msg.text) : null));
    }),
    pushOptions(),
  ];
}
