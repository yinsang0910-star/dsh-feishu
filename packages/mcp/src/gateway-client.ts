/**
 * 网关客户端（可选依赖）。
 *
 * 网关没跑的时候所有方法都优雅降级：探头失败就返回 null，调用方走原来的轮询路径。
 * 探测超时故意设得很短 —— 不能因为网关不在而拖慢 feishu_ask。
 */

export interface GatewayWatch {
  token: string;
  chatId: string;
  question: string;
  baselineSec?: number;
}

export interface GatewayAnswer {
  answered: boolean;
  known: boolean;
  text?: string;
  via?: 'button' | 'message';
  by?: string;
}

const DEFAULT_URL = 'http://127.0.0.1:18642';
const PROBE_TIMEOUT_MS = 800;
const CALL_TIMEOUT_MS = 2000;

export function gatewayUrl(): string {
  return (process.env.FEISHU_GATEWAY_URL ?? DEFAULT_URL).replace(/\/+$/, '');
}

/** 网关共享密钥（可选）。网关没配密钥时只接受本机访问，本机调用不需要它。 */
function gatewayToken(): string {
  return (process.env.FEISHU_GATEWAY_TOKEN ?? '').trim();
}

export function gatewayHeaders(): Record<string, string> {
  const t = gatewayToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<T | null> {
  try {
    const res = await fetch(`${gatewayUrl()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...gatewayHeaders(),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 网关在不在？返回 null 表示没跑 */
export async function gatewayHealth(): Promise<Record<string, unknown> | null> {
  return request<Record<string, unknown>>('/health', {}, PROBE_TIMEOUT_MS);
}

/** 登记一个正在等的提问，让按钮点下来能按 token 找到它 */
export async function gatewayWatch(input: GatewayWatch): Promise<boolean> {
  const res = await request<{ ok?: boolean }>('/watch', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res?.ok === true;
}

/** 查这个 token 有没有答案（按钮点了就是毫秒级返回） */
export async function gatewayAnswer(token: string): Promise<GatewayAnswer | null> {
  return request<GatewayAnswer>(`/answer?token=${encodeURIComponent(token)}`);
}

/** 收尾：主动把提问从网关删掉，省得占内存 */
export async function gatewayForget(token: string): Promise<void> {
  await request('/forget', { method: 'POST', body: JSON.stringify({ token }) });
}
