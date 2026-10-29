/**
 * 卡片模板单测。
 *
 * cards.ts 是纯函数，最适合用"结构化断言"锁死：卡片的 config/header/elements
 * 形态一旦被改动（比如漏了 update_multi，卡片就会刷屏），这里必须红。
 */

import { describe, expect, it } from 'vitest';
import {
  approvalCard,
  askCard,
  chatListCard,
  escapeMd,
  infoCard,
  progressCard,
  resultCard,
} from '../src/cards.js';
import type { FeishuCard } from '../src/types.js';

type El = Record<string, any>;

const els = (card: FeishuCard): El[] => card.elements as El[];

/** 所有 lark_md 文本块的内容 */
const divTexts = (card: FeishuCard): string[] =>
  els(card)
    .filter((e) => e.tag === 'div')
    .map((e) => e.text.content as string);

const noteOf = (card: FeishuCard): string | undefined => {
  const n = els(card).find((e) => e.tag === 'note');
  return n ? (n.elements as El[])[0]!.content as string : undefined;
};

const titleOf = (card: FeishuCard): string => (card.header as El).title.content as string;
const toneOf = (card: FeishuCard): string => (card.header as El).template as string;
const actionsOf = (card: FeishuCard): El[] =>
  (els(card).find((e) => e.tag === 'action')?.actions ?? []) as El[];

describe('escapeMd', () => {
  it('普通中文原样返回', () => {
    expect(escapeMd('今天的日报已经发好了')).toBe('今天的日报已经发好了');
  });

  it('空字符串返回空字符串', () => {
    expect(escapeMd('')).toBe('');
  });

  it('转义 lark_md 的三种行内标记 * _ ~', () => {
    expect(escapeMd('*粗*')).toBe('\\*粗\\*');
    expect(escapeMd('a_b')).toBe('a\\_b');
    expect(escapeMd('a~b')).toBe('a\\~b');
  });

  it('反斜杠先被转义，所以用户输入的 \\* 不会被当成"转义星号"', () => {
    expect(escapeMd('C:\\temp')).toBe('C:\\\\temp');
    // 输入一个反斜杠 + 一个星号 → 反斜杠翻倍，星号再加一个反斜杠
    expect(escapeMd('\\*')).toBe('\\\\\\*');
  });

  it('同时出现多个标记时全部转义', () => {
    expect(escapeMd('*a*_b_~c~')).toBe('\\*a\\*\\_b\\_\\~c\\~');
  });
});

describe('progressCard', () => {
  it('默认是蓝色进度卡，标题为「正在处理」，并带 update_multi 以便原地刷新', () => {
    const card = progressCard({ task: '整理周报', steps: ['读文件'] });
    expect(card.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(toneOf(card)).toBe('blue');
    expect(titleOf(card)).toBe('🧠 正在处理');
  });

  it('任务摘要加粗并转义，步骤前缀为「· 」', () => {
    const card = progressCard({ task: '*重要* 任务', steps: ['第一_步'] });
    const [task, steps] = divTexts(card);
    expect(task).toBe('**\\*重要\\* 任务**');
    expect(steps).toBe('· 第一\\_步');
  });

  it('步骤为空时显示「正在想…」而不是空白', () => {
    const card = progressCard({ task: '发呆', steps: [] });
    expect(divTexts(card)).toEqual(['**发呆**', '_正在想…_']);
  });

  it('步骤超过 visibleSteps 时折叠成「前面 N 步已完成」', () => {
    const steps = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const card = progressCard({ task: 't', steps, visibleSteps: 3 });
    expect(divTexts(card)[1]).toBe('_… 前面 4 步已完成_\n· s5\n· s6\n· s7');
  });

  it('默认只显示最后 5 步', () => {
    const steps = ['1', '2', '3', '4', '5', '6', '7'];
    expect(divTexts(progressCard({ task: 't', steps }))[1]).toBe(
      '_… 前面 2 步已完成_\n· 3\n· 4\n· 5\n· 6\n· 7',
    );
  });

  it('步骤数不超过 visibleSteps 时不出现折叠提示', () => {
    const card = progressCard({ task: 't', steps: ['a', 'b'], visibleSteps: 5 });
    expect(divTexts(card)[1]).toBe('· a\n· b');
  });

  it('中间有一条分隔线，且 footer 渲染成 note', () => {
    const card = progressCard({ task: 't', steps: ['a'], footer: '已用 12 秒' });
    expect(els(card).some((e) => e.tag === 'hr')).toBe(true);
    expect(noteOf(card)).toBe('已用 12 秒');
  });

  it('不传 footer 时没有 note 元素', () => {
    const card = progressCard({ task: 't', steps: ['a'] });
    expect(noteOf(card)).toBeUndefined();
  });

  it('可以自定义标题与色调', () => {
    const card = progressCard({ task: 't', steps: [], title: '收尾中', tone: 'green' });
    expect(titleOf(card)).toBe('收尾中');
    expect(toneOf(card)).toBe('green');
  });
});

describe('resultCard', () => {
  it('成功是绿卡 + 「完成」', () => {
    const card = resultCard({ ok: true, body: '都发完了' });
    expect(toneOf(card)).toBe('green');
    expect(titleOf(card)).toBe('✅ 完成');
    expect(divTexts(card)).toEqual(['都发完了']);
  });

  it('失败是红卡 + 「没成」', () => {
    const card = resultCard({ ok: false, body: '权限不够' });
    expect(toneOf(card)).toBe('red');
    expect(titleOf(card)).toBe('⛔ 没成');
  });

  it('body 为空时兜底「没有输出」', () => {
    expect(divTexts(resultCard({ ok: true, body: '' }))).toEqual(['_没有输出_']);
  });

  it('自定义标题覆盖默认标题，成功/失败都不影响 body 转义', () => {
    const card = resultCard({ ok: false, title: '发送失败', body: 'a_b' });
    expect(titleOf(card)).toBe('发送失败');
    // body 不转义：结果是模型输出，保留原始 markdown 更可读
    expect(divTexts(card)).toEqual(['a_b']);
  });

  it('footer 渲染成 note', () => {
    expect(noteOf(resultCard({ ok: true, body: 'x', footer: '耗时 3s' }))).toBe('耗时 3s');
  });
});

describe('infoCard', () => {
  it('字段渲染成「**label**：value」两列形式，默认灰色', () => {
    const card = infoCard({
      title: '群信息',
      fields: [
        { label: '群名', value: '研发群' },
        { label: '人数', value: '12' },
      ],
    });
    expect(toneOf(card)).toBe('grey');
    expect(titleOf(card)).toBe('群信息');
    expect(divTexts(card)).toEqual(['**群名**：研发群\n**人数**：12']);
  });

  it('label 与 value 都转义，避免用户数据破坏排版', () => {
    const card = infoCard({ title: 't', fields: [{ label: 'a_b', value: '*v*' }] });
    expect(divTexts(card)).toEqual(['**a\\_b**：\\*v\\*']);
  });

  it('字段为空数组时仍然产出合法的空文本块', () => {
    const card = infoCard({ title: 't', fields: [] });
    expect(divTexts(card)).toEqual(['']);
  });

  it('支持自定义 tone 与 footer', () => {
    const card = infoCard({ title: 't', fields: [], tone: 'orange', footer: 'f' });
    expect(toneOf(card)).toBe('orange');
    expect(noteOf(card)).toBe('f');
  });
});

describe('askCard', () => {
  it('橙色提问卡，问题文本被转义，默认带兜底 footer', () => {
    const card = askCard({ question: '选 *A* 还是 B？', token: 'tk1' });
    expect(toneOf(card)).toBe('orange');
    expect(titleOf(card)).toBe('❓ 想确认一下');
    expect(divTexts(card)).toEqual(['选 \\*A\\* 还是 B？']);
    expect(noteOf(card)).toBe('直接回一句也行；带按钮的点按钮更快。');
  });

  it('选项渲染成按钮：第一个 primary，其余 default，value 里带 token', () => {
    const card = askCard({ question: 'q', options: ['选 A', '选 B'], token: 'tk1' });
    const actions = actionsOf(card);
    expect(actions).toHaveLength(2);
    expect(actions[0]!.type).toBe('primary');
    expect(actions[1]!.type).toBe('default');
    expect(actions[1]!.value).toEqual({ act: 'answer', token: 'tk1', answer: '选 B' });
    expect(actions[0]!.text.content).toBe('选 A');
  });

  it('选项最多 5 个（超出部分丢弃）', () => {
    const options = ['1', '2', '3', '4', '5', '6', '7'];
    expect(actionsOf(askCard({ question: 'q', options, token: 'tk' }))).toHaveLength(5);
  });

  it('超长选项按钮文案截断到 40 字，但回传的 answer 仍是原文', () => {
    const long = 'x'.repeat(50);
    const [btn] = actionsOf(askCard({ question: 'q', options: [long], token: 'tk' }));
    expect((btn!.text.content as string)).toHaveLength(40);
    expect(btn!.value.answer).toBe(long);
  });

  it('没有选项时不渲染 action 区块', () => {
    expect(actionsOf(askCard({ question: 'q', token: 'tk' }))).toEqual([]);
    expect(actionsOf(askCard({ question: 'q', options: [], token: 'tk' }))).toEqual([]);
  });

  it('自定义 footer 覆盖默认文案', () => {
    expect(noteOf(askCard({ question: 'q', token: 'tk', footer: '一分钟内回' }))).toBe('一分钟内回');
  });
});

describe('approvalCard', () => {
  it('橙色卡，标题带「需要批准：」前缀，detail 放进代码块', () => {
    const card = approvalCard({ title: '删除文件', detail: 'rm -rf /tmp/x', token: 'tk' });
    expect(toneOf(card)).toBe('orange');
    expect(titleOf(card)).toBe('需要批准：删除文件');
    expect(divTexts(card)).toEqual(['```\nrm -rf /tmp/x\n```']);
  });

  it('超长 detail 截断到 1200 字，避免卡片超限', () => {
    const card = approvalCard({ title: 't', detail: 'd'.repeat(5000), token: 'tk' });
    expect(divTexts(card)[0]).toBe('```\n' + 'd'.repeat(1200) + '\n```');
  });

  it('两个按钮：批准(primary/approve) 与 取消(danger/cancel)，都带 token', () => {
    const actions = actionsOf(approvalCard({ title: 't', detail: 'd', token: 'tk9' }));
    expect(actions).toHaveLength(2);
    expect(actions[0]!.type).toBe('primary');
    expect(actions[0]!.text.content).toBe('批准');
    expect(actions[0]!.value).toEqual({ act: 'approve', token: 'tk9' });
    expect(actions[1]!.type).toBe('danger');
    expect(actions[1]!.text.content).toBe('取消');
    expect(actions[1]!.value).toEqual({ act: 'cancel', token: 'tk9' });
  });

  it('默认 footer 说明有效期，自定义 footer 覆盖', () => {
    expect(noteOf(approvalCard({ title: 't', detail: 'd', token: 'tk' }))).toBe(
      '点按钮即可，10 分钟内有效。',
    );
    expect(noteOf(approvalCard({ title: 't', detail: 'd', token: 'tk', footer: '五分钟' }))).toBe(
      '五分钟',
    );
  });
});

describe('chatListCard', () => {
  it('列表项带加粗群名与等宽 chatId', () => {
    const card = chatListCard({ chats: [{ chatId: 'oc_1', name: '研发群', memberCount: 12 }] });
    expect(titleOf(card)).toBe('📋 会话列表');
    expect(toneOf(card)).toBe('grey');
    expect(divTexts(card)).toEqual(['· **研发群**　`oc_1`　12 人']);
  });

  it('没有 memberCount 时不显示人数', () => {
    expect(divTexts(chatListCard({ chats: [{ chatId: 'oc_1', name: 'g' }] }))).toEqual([
      '· **g**　`oc_1`',
    ]);
  });

  it('memberCount 为 0 时仍然显示「0 人」（0 不等于未提供）', () => {
    expect(divTexts(chatListCard({ chats: [{ chatId: 'oc_1', name: 'g', memberCount: 0 }] }))).toEqual(
      ['· **g**　`oc_1`　0 人'],
    );
  });

  it('空数组时给出「还没被拉进任何群」的提示', () => {
    expect(divTexts(chatListCard({ chats: [] }))).toEqual(['_机器人还没被拉进任何群_']);
  });

  it('群名为空时兜底「(无名)」，名字里的标记会被转义', () => {
    expect(divTexts(chatListCard({ chats: [{ chatId: 'oc_1', name: '' }] }))).toEqual([
      '· **(无名)**　`oc_1`',
    ]);
    expect(divTexts(chatListCard({ chats: [{ chatId: 'oc_1', name: 'a_b' }] }))).toEqual([
      '· **a\\_b**　`oc_1`',
    ]);
  });

  it('多行拼接 + footer', () => {
    const card = chatListCard({
      chats: [
        { chatId: 'oc_1', name: 'a' },
        { chatId: 'oc_2', name: 'b' },
      ],
      footer: '共 2 个',
    });
    expect(divTexts(card)).toEqual(['· **a**　`oc_1`\n· **b**　`oc_2`']);
    expect(noteOf(card)).toBe('共 2 个');
  });
});
