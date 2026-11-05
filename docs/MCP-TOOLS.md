# MCP 工具全表

`dsh-feishu` 的 MCP server 一共暴露 **36 个工具**，覆盖飞书 IM、群管理、云空间、文档、多维表格、电子表格、知识库、通讯录七个域。

工具名在客户端里带服务前缀，形如 `mcp__feishu__feishu_send_text`。前缀由 profile 里的 `serverName` 决定（本项目默认 `feishu`），改了前缀工具名跟着变。

标注 **⚠️** 的是写操作或不可撤销操作，调用前应当确认参数。标注 **🔒** 的是只读工具，探索阶段可以放心反复调用。

---

## 一、身份与发消息（6）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_whoami` | 返回机器人身份（open_id、名字）与默认会话配置。发消息前不确定目标会话时先调它 |
| `feishu_send_text` | 往指定会话发一条纯文本。适合短结论、一句话确认；超过约 30 行或需要排版请改用卡片 |
| `feishu_send_card` | 发一张飞书交互卡片（JSON 原样提交，不做模板加工）。需要分块、分隔线、脚注，或之后要原地刷新的场景 |
| `feishu_send_info_card` | 把「标签 + 值」结构化信息渲染成信息卡。适合汇报状态、列项目、展示统计 |
| `feishu_update_card` | 把已发出的卡片整张替换，聊天里不新增气泡。这是「不刷屏」的关键手段，要求发卡时带 `config.update_multi = true` |
| `feishu_reply` | 对某条消息做引用回复（挂在原消息下面）。适合点名提问、避免刷屏群里的歧义 |

## 二、文件与图片（3）

| 工具 | 说明 |
| --- | --- |
| `feishu_send_file` | 把本地文件上传并发到会话。单个上限 30 MB，支持一次多个 + 说明文字 |
| `feishu_send_image` | 把本地图片以图片消息发出（png / jpg / jpeg / gif / webp），聊天里直接显示缩略图 |
| `feishu_download` | 下载某条消息的附件到本地，返回绝对路径。典型链路：收 docx → 下载 → 本地处理 → `feishu_send_file` 发回 |

## 三、上下文与提问（2）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_recent` | 拉某个会话的最近消息，按时间正序拍平成 `[时间] 发送人：内容`。动手之前先读一次，知道刚才聊了什么 |
| `feishu_ask` | 发一张带选项的卡片提问，阻塞等回答（默认 120 秒，最多 600 秒）。真缺关键信息时才用 |

## 四、会话与成员（2）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_chats` | 列出机器人所在的所有会话（群 + 单聊），返回 `chat_id` 与名字 |
| 🔒 `feishu_members` | 列出某个会话的成员，返回名字 + `open_id` |

## 五、群与消息管理（8）

| 工具 | 说明 |
| --- | --- |
| ⚠️ `feishu_recall` | 撤回机器人自己发的消息（24 小时内、只能撤自己的）。**删群里的旧文件也走它** —— 文件挂在消息上，删消息文件就没了 |
| `feishu_forward` | 把某条消息原样转发到别的群或某个人，卡片 / 图片 / 文件都保持原样 |
| `feishu_pin` | 置顶或取消置顶一条消息（钉最终结论、规范文件、长期清单） |
| `feishu_chat_update` | 改群名、群描述，或调整「谁能邀请成员 / 谁能分享群名片 / 谁能 @所有人」。只传要改的字段 |
| `feishu_chat_create` | 建群并拉人（成员用 `open_id`）。机器人建完即群主 |
| ⚠️ `feishu_chat_dissolve` | 解散群。**不可撤销**，群和消息一起消失，机器人必须是群主 |
| 🔒 `feishu_chat_files` | 列群里发过的文件（对应群聊顶部「文件」标签页），带 `message_id`、文件名、大小、时间。要删文件就把它返回的 `message_id` 交给 `feishu_recall` |
| ⚠️ `feishu_file_delete` | 删云空间里的文件 / 文档 / 表格 / 多维表格 / 空文件夹。参数是 `file_token`，**不是**消息的 `file_key` |

> **为什么群文件要绕一圈**：飞书没有「群文件列表」这个 OpenAPI。群里的文件是挂在消息上的附件，所以 `feishu_chat_files` 的实现是翻最近的群消息、筛出 `file` / `media` / `audio` 类型再整理。删文件同理 —— 删的是那条消息。

## 六、多维表格（6）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_bitable_tables` | 列出 Base 里的数据表，返回 `table_id`。**所有 bitable 操作的入口** |
| 🔒 `feishu_bitable_fields` | 列字段：名字、`field_id`、类型码 + 中文类型名、写入时的值形态。写记录前必看 |
| 🔒 `feishu_bitable_records` | 读记录，带 `record_id`，字段值展开成人话（人员显示名字、日期显示毫秒） |
| ⚠️ `feishu_bitable_add` | 新增一条记录，返回 `record_id` |
| ⚠️ `feishu_bitable_update` | 按 `record_id` 更新部分字段（只覆盖传了的字段） |
| ⚠️ `feishu_bitable_delete` | 按 `record_id` 删一条记录。**不可撤销**，无回收站。需传 `confirm: true` |

## 七、云空间 / 文档 / 表格 / 知识库（8）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_drive_list` | 列云空间某个文件夹下的文件，返回类型、名字、`token`、修改时间 |
| 🔒 `feishu_doc_read` | 读 docx 纯文本正文（不含图片、表格结构、评论），适合通读与总结 |
| 🔒 `feishu_doc_blocks` | 按块读文档结构：每块有 `block_id`、`block_type` 与内容。适合定位段落、表格，或按 `block_id` 精细操作 |
| `feishu_doc_create` | 新建空 docx，返回 `document_id`。只建空文档，不写正文 |
| ⚠️ `feishu_sheet_create` | 新建空电子表格，返回 `spreadsheet_token` 与分享链接 |
| 🔒 `feishu_sheet_read` | 按 A1 区间读表格值（`Sheet1!A1:D20`、`Sheet1!A:A`），返回二维数组 |
| 🔒 `feishu_wiki_spaces` / 🔒 `feishu_wiki_node` | 列知识库空间 / 查知识库节点（给 `space_id` 列根节点，给 `token` 查该节点） |

## 八、通讯录（1）

| 工具 | 说明 |
| --- | --- |
| 🔒 `feishu_user_lookup` | 用邮箱、手机号或 `open_id` 查用户，返回 `open_id` 与名字。拿到 `open_id` 才能私聊或 @ 人 |

---

## 还没开放的能力（以及为什么）

| 能力 | 状态 |
| --- | --- |
| 电子表格写值 | 飞书写入接口要求先拿 `sheet_id`（`spreadsheet_token` 不等于 `sheet_id`），需要多一次元数据请求。目前只读 |
| 文档写正文 | 需要按块构造 `children` 并处理 block 类型，复杂度高。目前只能建空文档 |
| 群文件「列表」 | 飞书没有这个端点，用 `feishu_chat_files` 翻消息代替 |
| 消息表情回应（reaction） | 端点存在（`im/v1/message_reaction`），尚未封装 |
| 合并转发（merge_forward） | 端点存在，尚未封装 |
| 群公告 / 群标签页 / 群菜单 | 端点存在（`chat_announcement`、`chat_tab`、`chat_menu_*`），尚未封装 |
| 云空间权限成员（`permission_member`） | 端点存在，尚未封装 |

这些不是遗漏，是按「agent 真的会用到的频率」排的优先级。要用哪个提 issue。

## 错误约定

所有工具的错误都经过统一翻译：

- 权限不足时，`FeishuApiError.missingScopes` 会把该开通的 scope 名字拼进错误文本，模型能照着提示你去开放平台勾选；
- 参数错、资源不存在、限流等各自给出中文说明；
- handler 内部整体 `try/catch`，异常一律变成 `fail(...)` 返回，不向上抛（MCP 协议不允许 handler 抛异常）。

## 改代码时的两条硬约束

1. **stdout 只能出 MCP 的 JSON-RPC**。任何 `console.log` 都会破坏协议，日志一律走 `ctx.log`（内部写 stderr）。
2. **新工具必须在 `packages/mcp/src/tools/index.ts` 里注册**，否则不会出现在 `tools/list` 里 —— 加了文件却忘了注册，就是「接口没开放」最常见的原因。
