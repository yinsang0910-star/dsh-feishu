import type { IncomingMessage, ServerResponse } from 'node:http';
/** Cordis 里的插件名，用于日志/诊断。 */
export declare const name = "dsh-feishu-settings";
/** 必需服务：只写确实要用、且在目标 profile 里必然存在的那个。 */
export declare const inject: string[];
interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
interface WebServerLike {
    /** 重复的 (kind, path) 会抛错；返回值是注销函数。 */
    register(route: WebRoute): () => void;
}
interface LoggerLike {
    info(format: string, ...args: unknown[]): void;
    warn?(format: string, ...args: unknown[]): void;
}
interface PluginContext {
    webServer: WebServerLike;
    logger: LoggerLike;
    /** 把清理函数挂到插件生命周期：禁用/热重载时自动注销。 */
    effect(execute: () => (() => void) | void, label?: string): unknown;
}
/** patch 行里的 config（全部可选，默认值见 resolveTargets）。 */
interface PluginConfig {
    /** 路由路径，默认 `/dsh-feishu/api`。必须唯一（重复 (kind,path) 会抛错）。 */
    endpointPath?: string;
    /** 覆盖凭据文件路径（离线测试用）。默认 `~/.config/dsh/feishu.env`。 */
    envPath?: string;
    /** 目标 profile 名；不写就自动探测（见 resolveProfile）。 */
    profile?: string;
    /** 目标 profile 目录；给出时优先级最高。 */
    profileDir?: string;
    /** `$DSH_HOME`；默认取 env.DSH_HOME，否则 `~/.dsh`。 */
    dshHome?: string;
    /** profiles 根目录；默认 `<dshHome>/profiles`。 */
    profilesRoot?: string;
    /** 覆盖家目录（离线测试用）。 */
    homeDir?: string;
    /** MCP 启动包装路径；默认 `~/.local/bin/dsh-feishu-mcp[.cmd]`。 */
    mcpWrapperPath?: string;
}
export declare function apply(ctx: PluginContext, config?: PluginConfig): void;
/** 具名 + default 两种导出都给：Loader 两种写法都能吃。 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
