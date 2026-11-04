/**
 * outbox + 幂等。
 *
 * 为什么必须先落盘再投 agent：LangGraph 官方文档明确说过，首个 checkpoint
 * 落盘前崩溃的线程，与「从来没收到过请求」无法区分（get_tuple() 返回 None，
 * invoke(None) 抛 EmptyInputError）。IM 接单是同一个形状 —— 飞书长连接会在
 * 网络抖动后重投事件，如果先投 agent 再记录，崩溃窗口里就会重复执行。
 *
 * 所以顺序固定为：
 *   1. claim(key) —— 写一行 state=accepted（fsync 落盘），返回是否首见
 *   2. 投给 agent（followup / steer / inject）
 *   3. mark(key, 'delivered', { messageId })
 * 重投时第 1 步返回 false，直接丢或改走 inbox.replace。
 *
 * 存储用追加式 JSONL（official 的 OpenHands 也是「快照 + 只追加事件」这条路），
 * 每行一个 JSON，读取时后者覆盖前者。文件很小（一行几十字节），不需要 SQLite。
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATES = new Set(['accepted', 'delivered', 'failed', 'cancelled']);

export class Outbox {
  /**
   * @param {string} dir 状态目录
   * @param {object} [opts]
   * @param {number} [opts.compactAfter] 超过多少行触发一次压缩重写
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.path = join(dir, 'outbox.jsonl');
    this.compactAfter = opts.compactAfter ?? 20000;
    /** @type {Map<string, object>} */
    this.rows = new Map();
    this.appended = 0;
    mkdirSync(dir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!existsSync(this.path)) {
      writeFileSync(this.path, '', 'utf8');
      return;
    }
    const text = readFileSync(this.path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // 崩溃留下的半行，忽略
      }
      if (row && typeof row.key === 'string') this.rows.set(row.key, row);
    }
  }

  /** 幂等键：同一条飞书消息永远得到同一个 key */
  static keyOf(chatId, msgId) {
    return `${chatId}\u0000${msgId}`;
  }

  /**
   * 占位。首次见到返回 true 并落盘 accepted；重复投递返回 false。
   * @param {string} key
   * @param {object} payload 需要保留以支持补投的原始信息
   * @returns {boolean}
   */
  claim(key, payload) {
    const prev = this.rows.get(key);
    // 只有「已经交付过」或「已取消」才算重复；failed 允许重试
    if (prev && (prev.state === 'delivered' || prev.state === 'cancelled')) return false;
    const row = {
      key,
      state: 'accepted',
      at: Date.now(),
      attempt: (prev?.attempt ?? 0) + 1,
      payload,
    };
    this.#append(row);
    return true;
  }

  /**
   * @param {string} key
   * @param {'delivered'|'failed'|'cancelled'} state
   * @param {object} [extra]
   */
  mark(key, state, extra = {}) {
    if (!STATES.has(state)) throw new Error(`bad state ${state}`);
    const prev = this.rows.get(key);
    if (!prev) throw new Error(`unknown key ${key}`);
    this.#append({ ...prev, ...extra, state, updatedAt: Date.now() });
  }

  get(key) {
    return this.rows.get(key);
  }

  /** 崩溃恢复：返回所有卡在 accepted 的行（接到了，但没确认投出去） */
  pending() {
    const out = [];
    for (const row of this.rows.values()) {
      if (row.state === 'accepted') out.push(row);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  #append(row) {
    this.rows.set(row.key, row);
    const line = `${JSON.stringify(row)}\n`;
    appendFileSync(this.path, line, 'utf8');
    // 关键行做一次 fsync，保证「先落盘」这个承诺是真的
    try {
      const fd = openSync(this.path, 'r');
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      /* fsync 失败不阻断主流程，但会在日志里体现 */
    }
    if (++this.appended > this.compactAfter) this.compact();
  }

  /** 折叠成最后状态，重写文件 */
  compact() {
    const lines = [];
    for (const row of this.rows.values()) lines.push(JSON.stringify(row));
    writeFileSync(this.path, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    this.appended = 0;
  }
}

/**
 * 简单 KV 存储：会话键 → { cwd, ownerOpenId, cardMsgId, ... }。
 * 卡片 message_id 存这里，重启后还能继续 patch 同一张卡，而不是再发一张。
 */
/**
 * 「群 → 会话」的持久绑定。
 *
 * 为什么需要：binding 只活在内存里，dsh-web 一重启就全清，之后门房的 SSE 全部 404、
 * 卡片停在重启那一刻，要等用户再发一条才重建。落盘之后 /events 能就地复活。
 *
 * 只存复活必需的四个字段；steps/replies/订阅者这些是运行时状态，重启后重建即可。
 */
export class BindingStore {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'bindings.json');
    mkdirSync(dir, { recursive: true });
    /** @type {Record<string, object>} */
    this.data = {};
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8')) || {};
      } catch {
        this.data = {};
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  keys() {
    return Object.keys(this.data);
  }

  save(key, fields) {
    this.data[key] = { ...(this.data[key] || {}), ...fields, savedAt: Date.now() };
    this.flush();
    return this.data[key];
  }

  delete(key) {
    delete this.data[key];
    this.flush();
  }

  flush() {
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }
}

export class SessionState {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'sessions.json');
    mkdirSync(dir, { recursive: true });
    /** @type {Record<string, object>} */
    this.data = {};
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8')) || {};
      } catch {
        this.data = {};
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  patch(key, fields) {
    this.data[key] = { ...(this.data[key] || {}), ...fields };
    this.flush();
    return this.data[key];
  }

  delete(key) {
    delete this.data[key];
    this.flush();
  }

  flush() {
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }
}
