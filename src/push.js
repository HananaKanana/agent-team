// 推送到手机：pushplus（微信）、飞书、企业微信、钉钉群机器人。
// 配置存在 ~/.config/ateam/push.json（只有本人可读、不在项目里），所有项目共用。
// 推什么由 server.js 决定（与看板「待处理」同一份清单，持续 1 分钟的新事项推一次）。
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = () => join(homedir(), '.config', 'ateam', 'push.json');

// 各渠道要填的字段。secret 是飞书、钉钉机器人「签名校验」的密钥，没开签名校验就留空
export const CHANNELS = {
  pushplus: { label: 'pushplus（微信）', fields: ['token'] },
  feishu: { label: '飞书群机器人', fields: ['webhook', 'secret'] },
  wecom: { label: '企业微信群机器人', fields: ['webhook'] },
  dingtalk: { label: '钉钉群机器人', fields: ['webhook', 'secret'] },
};
const SECRET_FIELDS = new Set(['token', 'secret']);

export function readPush() {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

// 看板显示用：token、密钥只露末 4 位，webhook 地址只露域名和末 6 位（地址本身就是凭据）
export function maskedPush() {
  const cfg = readPush();
  const out = {};
  for (const [key, def] of Object.entries(CHANNELS)) {
    const c = cfg[key] ?? {};
    out[key] = { label: def.label, fields: def.fields, on: !!c.on, values: {} };
    for (const f of def.fields) {
      const v = String(c[f] ?? '');
      if (!v) { out[key].values[f] = ''; continue; }
      if (SECRET_FIELDS.has(f)) out[key].values[f] = `••••${v.slice(-4)}`;
      else {
        let host = '';
        try { host = new URL(v).host; } catch {}
        out[key].values[f] = `${host ? `${host}/` : ''}…${v.slice(-6)}`;
      }
    }
  }
  return out;
}

// 改一个渠道：values 里没给的字段不动（看板只回传改过的），给空字符串表示清掉
export function savePush(channel, { on, values = {} } = {}) {
  const def = CHANNELS[channel];
  if (!def) throw new Error(`没有这个推送渠道：${channel}`);
  const cfg = readPush();
  const c = { ...(cfg[channel] ?? {}) };
  for (const f of def.fields) {
    if (!(f in values)) continue;
    const v = String(values[f] ?? '').trim();
    if (f === 'webhook' && v && !/^https:\/\//.test(v)) throw new Error('webhook 地址应以 https:// 开头。');
    c[f] = v;
  }
  if (on !== undefined) c.on = !!on;
  if (c.on && !c[def.fields[0]]) throw new Error(`请先填写${def.fields[0] === 'token' ? ' token ' : ' webhook 地址'}再开启。`);
  cfg[channel] = c;
  writeConfig(cfg);
  return maskedPush();
}

function writeConfig(cfg) {
  mkdirSync(join(homedir(), '.config', 'ateam'), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file(), 0o600); } catch {}
}

// 总开关（看板「推送」页最上面），默认关闭
export function pushEnabled() {
  return readPush().enabled === true;
}

export function setPushEnabled(on) {
  const cfg = readPush();
  cfg.enabled = !!on;
  writeConfig(cfg);
}

export function anyPushOn() {
  const cfg = readPush();
  return cfg.enabled === true && Object.keys(CHANNELS).some((k) => cfg[k]?.on);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'ateam' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ?? {};
}

// 各渠道的发送。title 是一行标题，lines 是正文各行，link 是可点的地址（可能为空）
const SENDERS = {
  async pushplus(c, { title, lines, link }) {
    const content = [...lines, ...(link ? [`[在局域网中打开看板](${link})`] : [])].join('\n\n');
    const out = await post('https://www.pushplus.plus/send', { token: c.token, title, content, template: 'markdown' });
    if (out.code !== 200) throw new Error(out.msg || `返回码 ${out.code}`);
  },
  async feishu(c, { title, lines, link }) {
    // 飞书发纯文本：去掉 Markdown 的加粗记号
    const body = { msg_type: 'text', content: { text: [title, ...lines.map((l) => l.replace(/\*\*/g, '')), ...(link ? [link] : [])].join('\n') } };
    if (c.secret) {
      // 飞书签名：以「时间戳\n密钥」为 key 对空字符串做 HmacSHA256，再 base64
      const timestamp = String(Math.floor(Date.now() / 1000));
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', `${timestamp}\n${c.secret}`).update('').digest('base64');
    }
    const out = await post(c.webhook, body);
    const code = out.code ?? out.StatusCode ?? 0;
    if (code !== 0) throw new Error(out.msg || out.StatusMessage || `返回码 ${code}`);
  },
  async wecom(c, { title, lines, link }) {
    const content = [`**${title}**`, ...lines, ...(link ? [`[在局域网中打开看板](${link})`] : [])].join('\n');
    const out = await post(c.webhook, { msgtype: 'markdown', markdown: { content } });
    if (out.errcode !== 0) throw new Error(out.errmsg || `返回码 ${out.errcode}`);
  },
  async dingtalk(c, { title, lines, link }) {
    let url = c.webhook;
    if (c.secret) {
      // 钉钉签名：以密钥为 key 对「时间戳\n密钥」做 HmacSHA256，再 base64、URL 编码
      const timestamp = String(Date.now());
      const sign = createHmac('sha256', c.secret).update(`${timestamp}\n${c.secret}`).digest('base64');
      url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }
    // 标题里带 ateam：机器人开了「自定义关键词」时，把 ateam 设为关键词即可
    const text = [`#### ${title}`, ...lines, ...(link ? [`[在局域网中打开看板](${link})`] : [])].join('\n\n');
    const out = await post(url, { msgtype: 'markdown', markdown: { title, text } });
    if (out.errcode !== 0) throw new Error(out.errmsg || `返回码 ${out.errcode}`);
  },
};

// 发到所有开启的渠道（或只发 only 指定的一个，测试用）。返回 [{ channel, ok, error }]
export async function sendPush(message, only = null) {
  const cfg = readPush();
  const targets = Object.keys(CHANNELS).filter((k) => (only ? k === only : cfg[k]?.on) && cfg[k]?.[CHANNELS[k].fields[0]]);
  if (only && !targets.length) throw new Error('请先填写并保存这个渠道的配置。');
  return Promise.all(targets.map(async (k) => {
    try {
      await SENDERS[k](cfg[k], message);
      return { channel: k, ok: true };
    } catch (err) {
      return { channel: k, ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }));
}

// ---------- 定时小结（每日 / 每周），所有项目共用这份设置，各项目的服务各发各的 ----------
// daily：每天 time 发当天的小结；weekly：每周 weekday（0 = 周日 … 6 = 周六）的 time 发最近 7 天的小结
const DIGEST_DEFAULT = { daily: { on: false, time: '18:00' }, weekly: { on: false, weekday: 5, time: '18:00' }, sections: {} };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function readDigest() {
  const d = readPush().digest ?? {};
  return {
    daily: { ...DIGEST_DEFAULT.daily, ...(d.daily ?? {}) },
    weekly: { ...DIGEST_DEFAULT.weekly, ...(d.weekly ?? {}) },
    sections: { ...(d.sections ?? {}) }, // 段落开关，缺省都要（见 digest.js 的 DIGEST_SECTIONS）
  };
}

export function saveDigest(kind, { on, time, weekday, sections } = {}) {
  const cfg = readPush();
  if (kind === 'sections') {
    cfg.digest = { ...readDigest(), sections: { ...readDigest().sections, ...Object.fromEntries(Object.entries(sections ?? {}).map(([k, v]) => [k, !!v])) } };
    writeConfig(cfg);
    return readDigest();
  }
  if (kind !== 'daily' && kind !== 'weekly') throw new Error(`没有这种小结：${kind}`);
  const cur = readDigest()[kind];
  if (on !== undefined) cur.on = !!on;
  if (time !== undefined) {
    if (!TIME_RE.test(String(time))) throw new Error('时间格式应为 HH:MM，比如 18:00。');
    cur.time = String(time);
  }
  if (kind === 'weekly' && weekday !== undefined) {
    const w = Number(weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error('星期应为 0（周日）到 6（周六）。');
    cur.weekday = w;
  }
  cfg.digest = { ...readDigest(), [kind]: cur };
  writeConfig(cfg);
  return readDigest();
}

// ---------- 推哪些事、什么格式 ----------
// 待处理事项按类型（待处理清单里 key 的前缀）开关，缺省都推
export const EVENT_TYPES = { accept: '需求待验收', needs: '缺少 worker', quiet: 'worker 无响应', dispute: '审卡分歧待决定', assign: '指派的 worker 不在线', cancel: 'worker 仍在处理已作废的任务', leader: 'leader 未连接' };
// brief：简洁（只推一行标题）；link：附看板链接；merge：同时出现的几件事合成一条；prefix：标题前缀
const FORMAT_DEFAULT = { brief: false, link: true, merge: true, prefix: 'ateam' };

export function readPrefs() {
  const p = readPush().prefs ?? {};
  return { events: { ...(p.events ?? {}) }, format: { ...FORMAT_DEFAULT, ...(p.format ?? {}) } };
}

export function savePrefs({ events, format } = {}) {
  const cfg = readPush();
  const cur = readPrefs();
  if (events) for (const [k, v] of Object.entries(events)) if (k in EVENT_TYPES) cur.events[k] = !!v;
  if (format) {
    for (const k of ['brief', 'link', 'merge']) if (k in format) cur.format[k] = !!format[k];
    if ('prefix' in format) {
      const v = String(format.prefix ?? '').trim();
      if (v.length > 20) throw new Error('标题前缀最多 20 个字。');
      cur.format.prefix = v;
    }
  }
  cfg.prefs = cur;
  writeConfig(cfg);
  return readPrefs();
}

export const eventOn = (prefs, key) => prefs.events[String(key).split(':')[0]] !== false;
