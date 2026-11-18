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
  mkdirSync(join(homedir(), '.config', 'ateam'), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file(), 0o600); } catch {}
  return maskedPush();
}

export function anyPushOn() {
  const cfg = readPush();
  return Object.keys(CHANNELS).some((k) => cfg[k]?.on);
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
    const body = { msg_type: 'text', content: { text: [title, ...lines, ...(link ? [link] : [])].join('\n') } };
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
