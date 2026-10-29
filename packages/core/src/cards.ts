/**
 * 飞书卡片模板。
 *
 * 设计原则：
 *  - 所有卡片带 `config.update_multi = true`，这样同一张卡可以原地刷新，不刷屏；
 *  - 文案用中文、面向人；不要出现工具名、JSON、字段名；
 *  - 只做"能被 updateCard 复用"的纯函数，不持有状态。
 */

import type { FeishuCard } from './types.js';

export type CardTone = 'blue' | 'green' | 'red' | 'orange' | 'grey';

const TONE_TEMPLATE: Record<CardTone, string> = {
  blue: 'blue',
  green: 'green',
  red: 'red',
  orange: 'orange',
  grey: 'grey',
};

function md(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function note(content: string): Record<string, unknown> {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] };
}

/** lark_md 会把 *_~ 当标记吃掉，用户内容要先转义 */
export function escapeMd(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/_/g, '\\_').replace(/~/g, '\\~');
}

function base(tone: CardTone, title: string, elements: Array<Record<string, unknown>>): FeishuCard {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: TONE_TEMPLATE[tone],
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

// ─────────────────────────── 进度卡 ───────────────────────────

export interface ProgressCardInput {
  title?: string;
  /** 当前任务的一句话摘要 */
  task: string;
  /** 已完成的步骤（人话） */
  steps: string[];
  /** 只显示最后几条，前面的折叠成"…前面 N 步已完成" */
  visibleSteps?: number;
  footer?: string;
  tone?: CardTone;
}

export function progressCard(input: ProgressCardInput): FeishuCard {
  const visible = input.visibleSteps ?? 5;
  const total = input.steps.length;
  const tail = input.steps.slice(-visible);
  const lines: string[] = [];
  if (total > tail.length) lines.push(`_… 前面 ${total - tail.length} 步已完成_`);
  for (const s of tail) lines.push(`· ${escapeMd(s)}`);
  if (!lines.length) lines.push('_正在想…_');

  const elements: Array<Record<string, unknown>> = [
    md(`**${escapeMd(input.task)}**`),
    { tag: 'hr' },
    md(lines.join('\n')),
  ];
  if (input.footer) elements.push(note(input.footer));
  return base(input.tone ?? 'blue', input.title ?? '🧠 正在处理', elements);
}

// ─────────────────────────── 结果卡 ───────────────────────────

export interface ResultCardInput {
  ok: boolean;
  title?: string;
  body: string;
  footer?: string;
}

export function resultCard(input: ResultCardInput): FeishuCard {
  const elements: Array<Record<string, unknown>> = [md(input.body || '_没有输出_')];
  if (input.footer) elements.push(note(input.footer));
  return base(
    input.ok ? 'green' : 'red',
    input.title ?? (input.ok ? '✅ 完成' : '⛔ 没成'),
    elements,
  );
}

// ─────────────────────────── 信息卡 ───────────────────────────

export interface InfoCardInput {
  title: string;
  /** 键值对，渲染成两列 */
  fields: Array<{ label: string; value: string }>;
  footer?: string;
  tone?: CardTone;
}

export function infoCard(input: InfoCardInput): FeishuCard {
  const lines = input.fields.map(
    (f) => `**${escapeMd(f.label)}**：${escapeMd(f.value)}`,
  );
  const elements: Array<Record<string, unknown>> = [md(lines.join('\n'))];
  if (input.footer) elements.push(note(input.footer));
  return base(input.tone ?? 'grey', input.title, elements);
}

// ─────────────────────────── 提问卡 ───────────────────────────

export interface AskCardInput {
  question: string;
  /** 建议选项；用户也可以直接打字回复 */
  options?: string[];
  footer?: string;
  /** 选项按钮回调里带回来的标识，用于把回答对应到这次提问 */
  token: string;
}

export function askCard(input: AskCardInput): FeishuCard {
  const elements: Array<Record<string, unknown>> = [md(escapeMd(input.question))];
  if (input.options?.length) {
    elements.push({
      tag: 'action',
      actions: input.options.slice(0, 5).map((opt, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.slice(0, 40) },
        type: i === 0 ? 'primary' : 'default',
        value: { act: 'answer', token: input.token, answer: opt },
      })),
    });
  }
  elements.push(note(input.footer ?? '直接回一句也行；带按钮的点按钮更快。'));
  return base('orange', '❓ 想确认一下', elements);
}

// ─────────────────────────── 审批卡 ───────────────────────────

export interface ApprovalCardInput {
  /** 要批准的事，一句话 */
  title: string;
  /** 具体内容（命令、参数、目标） */
  detail: string;
  token: string;
  footer?: string;
}

export function approvalCard(input: ApprovalCardInput): FeishuCard {
  return base('orange', `需要批准：${input.title}`, [
    md('```\n' + input.detail.slice(0, 1200) + '\n```'),
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '批准' },
          type: 'primary',
          value: { act: 'approve', token: input.token },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '取消' },
          type: 'danger',
          value: { act: 'cancel', token: input.token },
        },
      ],
    },
    note(input.footer ?? '点按钮即可，10 分钟内有效。'),
  ]);
}

// ─────────────────────────── 会话列表卡 ───────────────────────────

export interface ChatListCardInput {
  chats: Array<{ chatId: string; name: string; memberCount?: number }>;
  footer?: string;
}

export function chatListCard(input: ChatListCardInput): FeishuCard {
  const lines = input.chats.length
    ? input.chats.map(
        (c) =>
          `· **${escapeMd(c.name || '(无名)')}**　\`${c.chatId}\`${
            c.memberCount !== undefined ? `　${c.memberCount} 人` : ''
          }`,
      )
    : ['_机器人还没被拉进任何群_'];
  const elements: Array<Record<string, unknown>> = [md(lines.join('\n'))];
  if (input.footer) elements.push(note(input.footer));
  return base('grey', '📋 会话列表', elements);
}
