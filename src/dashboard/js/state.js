// 全局状态和常量：泳道、状态名、当前数据、视图（选中的需求和卡）

export const LANES = [
  { key: 'pending', label: '待领取' },
  { key: 'working', label: '进行中' },
  { key: 'rework', label: '返工中' },
  { key: 'asking', label: '等待答复' },
  { key: 'submitted', label: '待 review' },
  { key: 'approved', label: '已通过' },
  { key: 'held', label: '已挂起' },
];
export const LANE_LABEL = { ...Object.fromEntries(LANES.map((l) => [l.key, l.label])), cancelled: '已作废' };
export const JOB_STATUS = { planning: '规划中', active: '进行中', awaiting_acceptance: '待验收', accepted: '已验收', cancelled: '已作废' };
export const HISTORY = {
  created: ['创建', 'pending'], claimed: ['领取', 'working'], progress: ['进度', 'working'],
  asked: ['提问', 'asking'], answered: ['答复', 'asking'], submitted: ['交付', 'submitted'],
  approved: ['通过', 'approved'], rejected: ['打回', 'rework'], handoff: ['离线交接', 'held'],
  held: ['挂起', 'held'], released: ['放回', 'pending'], edited: ['修改', 'pending'], cancelled: ['作废', 'cancelled'],
  demo_ended: ['运行结束', 'approved'], demo_saved: ['操作记录', 'approved'],
  note: ['补充说明', 'pending'], note_delivered: ['已送达', 'working'], critique: ['审卡', 'held'], demo_paused: ['暂停', 'asking'], demo_resumed: ['继续', 'working'], parked: ['转做其他任务', 'held'], profile: ['浏览器 profile', 'working'], check: ['提交检查', 'submitted'],
};
// 演播卡的状态：名称、lozenge 颜色
export const DEMO_STATUS = { ready: ['待演播', 'pending'], queued: ['等待开始', 'asking'], demoing: ['演播中', 'working'], wrapping: ['收尾中', 'submitted'], cancelled: ['已作废', 'cancelled'] };
export const RUN_OUTCOME = { done: '完成', stopped: '叫停', interrupted: '中断' };
export const RUN_MODE = { rehearsal: '预演', show: '演播' };
// 当前数据（/api/state 的结果，app.js 轮询时更新）和视图（选中的需求、卡、是否在看汇报）
export let data = null;
export let view = { job: null, task: null, report: false };
export function setData(v) { data = v; }
export function setView(v) { view = v; }
let showPrompts = false;
