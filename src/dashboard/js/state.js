'use strict';
// 全局状态和常量：泳道、状态名、当前数据、视图（选中的需求和卡）

const LANES = [
  { key: 'pending', label: '待领取' },
  { key: 'working', label: '进行中' },
  { key: 'rework', label: '返工中' },
  { key: 'asking', label: '等待答复' },
  { key: 'submitted', label: '待 review' },
  { key: 'approved', label: '已通过' },
  { key: 'held', label: '已挂起' },
];
const LANE_LABEL = { ...Object.fromEntries(LANES.map((l) => [l.key, l.label])), cancelled: '已作废' };
const JOB_STATUS = { planning: '规划中', active: '进行中', awaiting_acceptance: '待验收', accepted: '已验收', cancelled: '已作废' };
const JOB_LOZENGE = { planning: 'pending', active: 'working', awaiting_acceptance: 'asking', accepted: 'approved', cancelled: 'cancelled' };
let descOpenJob = null; // 展开了说明的需求
let acceptArm = null; // 「验收通过」两步确认：记需求编号
const HISTORY = {
  created: ['创建', 'pending'], claimed: ['领取', 'working'], progress: ['进度', 'working'],
  asked: ['提问', 'asking'], answered: ['答复', 'asking'], submitted: ['交付', 'submitted'],
  approved: ['通过', 'approved'], rejected: ['打回', 'rework'], handoff: ['离线交接', 'held'],
  held: ['挂起', 'held'], released: ['放回', 'pending'], edited: ['修改', 'pending'], cancelled: ['作废', 'cancelled'],
  demo_ended: ['运行结束', 'approved'], demo_saved: ['操作记录', 'approved'],
  note: ['补充说明', 'pending'], note_delivered: ['已送达', 'working'], critique: ['审卡', 'held'], demo_paused: ['暂停', 'asking'], demo_resumed: ['继续', 'working'], parked: ['转做其他任务', 'held'], profile: ['浏览器 profile', 'working'], check: ['提交检查', 'submitted'],
};
// 演播卡的状态：名称、lozenge 颜色
const DEMO_STATUS = { ready: ['待演播', 'pending'], queued: ['等待开始', 'asking'], demoing: ['演播中', 'working'], wrapping: ['收尾中', 'submitted'], cancelled: ['已作废', 'cancelled'] };
const RUN_OUTCOME = { done: '完成', stopped: '叫停', interrupted: '中断' };
const RUN_MODE = { rehearsal: '预演', show: '演播' };
let data = null;
let lastJson = '';
let lastEtag = '';
let view = { job: null, task: null, report: false };
let showPrompts = false;
let copied = null; // 刚复制的提示词，用来显示「已复制」
// 抽屉是否展开到大半屏；记在本浏览器里，下次打开保持
let drawerWide = false;
try { drawerWide = prefs.get('ateam.drawerWide') === '1'; } catch {}
// 右键（触屏模式下长按）卡片：跳到相关的卡、常用操作、复制。会改动东西又不好撤回的（收回、作废）先弹确认框
let flashId = null; // 刚跳到的卡，闪一下（jumpToTask 设置，card() 读）
let flashTimer = 0;
