/**
 * 网关状态：谁在等回答、最近收过什么消息。
 *
 * 设计要点：
 *  - 全是内存态，进程重启即空 —— 这里存的是"正在进行的事"，不是账本；
 *  - ask 用 token 精确匹配，解决并发两问互相偷答案的问题；
 *  - 消息只留最近 N 条，给 feishu_recent 当"实时上下文"用（比拉 API 快、且不受读权限限制）。
 */

export type AnswerVia = 'button' | 'message';

export interface PendingAsk {
  token: string;
  chatId: string;
  question: string;
  createdAt: number;
  /** 发起时的时间（秒），用来判断哪些是新消息 */
  baselineSec: number;
  answered?: {
    text: string;
    via: AnswerVia;
    at: number;
    byOpenId?: string;
    messageId?: string;
  };
}

export interface CachedMessage {
  messageId: string;
  chatId: string;
  msgType: string;
  createTime: number;
  senderOpenId?: string;
  senderType?: string;
  text: string;
  threadId?: string;
}

const MAX_ASK_AGE_MS = 15 * 60 * 1000;
const MAX_MESSAGES = 500;

export class GatewayState {
  private asks = new Map<string, PendingAsk>();
  private messages: CachedMessage[] = [];
  private eventCount = 0;
  private startedAt = Date.now();

  registerAsk(input: {
    token: string;
    chatId: string;
    question: string;
    baselineSec?: number;
  }): PendingAsk {
    const now = Date.now();
    const ask: PendingAsk = {
      token: input.token,
      chatId: input.chatId,
      question: input.question,
      createdAt: now,
      baselineSec: input.baselineSec ?? Math.floor(now / 1000),
    };
    this.asks.set(ask.token, ask);
    this.eventCount++;
    this.sweep();
    return ask;
  }

  resolveAsk(
    token: string,
    answer: { text: string; via: AnswerVia; byOpenId?: string; messageId?: string },
  ): boolean {
    const ask = this.asks.get(token);
    if (!ask || ask.answered) return false;
    ask.answered = { ...answer, at: Date.now() };
    this.eventCount++;
    return true;
  }

  getAsk(token: string): PendingAsk | undefined {
    return this.asks.get(token);
  }

  /** 本地调试用：列出还在等的提问（不含答案正文，避免日志泄漏） */
  pendingList(): Array<{ token: string; chatId: string; ageMs: number; answered: boolean }> {
    const now = Date.now();
    return [...this.asks.values()].map((a) => ({
      token: a.token,
      chatId: a.chatId,
      ageMs: now - a.createdAt,
      answered: Boolean(a.answered),
    }));
  }

  dropAsk(token: string): void {
    this.asks.delete(token);
  }

  pushMessage(msg: CachedMessage): void {
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.eventCount++;

    // 消息也可能是对某个 ask 的回答：找同会话里还在等、且消息在 baseline 之后的 ask
    // 只在"恰好只有一个待答问题"时才自动认领，避免并发时张冠李戴。
    const open = [...this.asks.values()].filter(
      (a) => !a.answered && a.chatId === msg.chatId && msg.createTime >= a.baselineSec,
    );
    if (open.length === 1) {
      const only = open[0]!;
      if (msg.senderOpenId !== only.chatId) {
        this.resolveAsk(only.token, {
          text: msg.text,
          via: 'message',
          ...(msg.senderOpenId ? { byOpenId: msg.senderOpenId } : {}),
          messageId: msg.messageId,
        });
      }
    }
  }

  recentMessages(chatId: string, limit = 20): CachedMessage[] {
    return this.messages.filter((m) => m.chatId === chatId).slice(-limit);
  }

  stats(): Record<string, unknown> {
    const open = [...this.asks.values()].filter((a) => !a.answered).length;
    return {
      uptimeMs: Date.now() - this.startedAt,
      events: this.eventCount,
      pendingAsks: open,
      cachedMessages: this.messages.length,
    };
  }

  /** 清掉超过 15 分钟还没人答的 ask */
  sweep(): void {
    const cutoff = Date.now() - MAX_ASK_AGE_MS;
    for (const [token, ask] of this.asks) {
      if (ask.createdAt < cutoff) this.asks.delete(token);
    }
  }
}
