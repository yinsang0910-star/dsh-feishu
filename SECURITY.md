# 安全说明

## 报告问题

用 GitHub 的 [Private vulnerability reporting](https://github.com/yinsang0910-star/dsh-feishu/security/advisories/new) 提交，不要开公开 issue。请在报告里写清版本、复现步骤与影响面；收到后一周内回复。

## 凭据存放

本项目的凭据全部落在本机，不上传、不写日志：

| 凭据 | 位置 | 权限 |
| --- | --- | --- |
| 飞书 App ID / Secret（本机 DSH） | `~/.config/dsh/feishu.env` | `0600` |
| 飞书 App ID / Secret（机器人） | `/opt/feishu-bot/config.env` | `0600` |
| 机器人配置（含白名单、网关 token） | `/opt/feishu-bot/config.json` | `0600` |
| 模型 API Key | agent 机 `~/.config/dsh/opencode-go.env` | `0600` |

设置页写入凭据时使用 `0600`，自检只回显末四位。

## 上报内容

以下内容不要出现在 issue、PR、截图或提交历史里：

- App Secret、tenant_access_token、gateway token
- 真实的 `open_id`、`chat_id`、`file_key`、`app_id`
- 设备授权二维码与 `user_code`（一次性，但会被截图留存）
- 服务器地址、SSH 私钥路径、本机用户名

## 设计上的边界

- **机器人默认只认白名单**。`allowed_open_ids` 为空时不响应任何人；群聊里白名单外的发言直接忽略，不回提示（避免刷屏）。
- **群聊默认不用 @**（`group_require_mention: false`）。这意味着群里任何白名单成员的发言都会进入 agent，包括闲聊。需要严格模式就发 `/要@`，或把该键设为 `true`。
- **文件与图片落在 agent 机的工作目录内**（`<cwd>/.feishu-inbox/`）。DSH 的文件沙箱是 `workspace-write`，沙箱外读写会被拒绝；需要更大范围时显式改 `DSH_PERMISSION_MODE`。
- **危险操作走审批**。删除消息、解散群、删文件等工具要求 `confirm`；机器人侧的批量命令需要 `/批` 放行。
- **模型输出的内容不受信**。文本消息按纯文本发送，卡片正文按 Markdown 渲染；两者都不会被当作代码或指令执行，但被投毒的模型输出仍可能诱导群成员点击链接，需要人工判断。

## 已知限制

- 机器人走长连接，不监听公网端口；这不等于它不可被滥用——白名单与 `/要@` 是唯一的访问控制，请按需收紧。
- 引用还原会把被引用消息的正文拼进 prompt，被引用内容同样视为不可信输入。
