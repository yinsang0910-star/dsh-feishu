/**
 * dsh-feishu 设置页 —— 浏览器（UI）半侧入口。
 *
 * 这不是打包器的产物，而是手写的 CJS factory：DSH 的浏览器模块加载器只接受
 *   window.__ModuleLoader__.load({ id, factory })
 * 且 `id` 必须等于包名；factory 里用 `require()` 只能拿平台基座里的模块
 * （react / react-dom / @deepseek-ai/dsh-client-ui-primitives …）。
 * 依据见同目录 README「Q2」与「Q3」。
 *
 * 注册方式：`ctx.slots.inject('settings.section', () => ctx.slots.register({...}, 组件))`
 * 槽位由 `ui-settings-general/lib/client.js:1136` 声明（kind:list, scope:root），
 * 所以只要有设置面板，这一节就会出现在左侧菜栏里。
 *
 * 后端只有一条路由：`POST dsh-feishu/api`，body 里 `op` 分 status / test / save。
 * 路径写成**文档相对**（无前导斜杠）：shell 的 index 带 `<base href="./">`，
 * 绝对路径会在子路径部署时逃出挂载前缀。
 */
window.__ModuleLoader__.load({
  id: '@dsh-feishu/dsh-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /**
     * 基座自带的 UI 组件库（不需要新依赖、不需要打包）。
     *
     * **Button / Input 是 forwardRef 造出来的，typeof 是 'object' 不是 'function'。**
     * 早先按 `typeof x === 'function'` 判断，于是组件全被判成“取不到”，整页降级成裸
     * 控件 —— 还带着写死的 `#1b1b1b`，在深色主题下按钮直接变成黑底白字。现在改判
     * `$$typeof`：普通函数组件和 forwardRef / memo 都算拿到。
     */
    var primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (error) {
      primitives = {}
    }

    function pick(candidate) {
      if (typeof candidate === 'function') return candidate
      if (candidate && typeof candidate === 'object' && candidate.$$typeof !== undefined) return candidate
      return null
    }

    var UIButton = pick(primitives.Button)
    var UITag = pick(primitives.Tag)
    var UIStateDot = pick(primitives.StateDot)
    var UIPill = pick(primitives.Pill)

    var ID = '@dsh-feishu/dsh-plugin'
    /** 文档相对路径，见文件头注释。 */
    var API = 'dsh-feishu/api'

    /* 全部走 --dsw-* token：明暗主题由基座决定，这里不写任何具体颜色。 */
    var C = {
      text: 'var(--dsw-alias-text-primary, currentColor)',
      dim: 'var(--dsw-alias-text-secondary, #6f6f6f)',
      faint: 'var(--dsw-alias-text-tertiary, #8f8f8f)',
      line: 'var(--dsw-alias-border-subtle, rgba(128,128,128,0.24))',
      code: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,0.12))',
      err: 'var(--dsw-alias-text-danger, #b4232b)',
      warn: 'var(--dsw-alias-text-warning, #8a5a00)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    var S = {
      page: { maxWidth: 620, color: C.text, fontSize: 13, lineHeight: 1.6 },
      lead: { color: C.dim, marginTop: 4 },
      group: { marginTop: 22 },
      groupTitle: { fontSize: 12, fontWeight: 600, color: C.dim, marginBottom: 10 },
      field: { marginBottom: 14 },
      label: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 },
      hint: { fontSize: 11, color: C.faint, marginTop: 5, lineHeight: 1.55 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' },
      spacer: { flex: 1 },
      status: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 26,
        paddingTop: 14,
        borderTop: '1px solid ' + C.line,
      },
      statusText: { fontWeight: 600 },
      statusMeta: { color: C.faint, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      detailToggle: { cursor: 'pointer', fontSize: 12, color: C.dim, marginTop: 10, userSelect: 'none' },
      detailBody: { marginTop: 8, paddingLeft: 2 },
      row: { display: 'flex', gap: 12, padding: '3px 0', fontSize: 12, alignItems: 'baseline' },
      rowKey: { flex: '0 0 92px', color: C.faint },
      rowVal: { minWidth: 0, wordBreak: 'break-all' },
      mono: { fontFamily: C.mono, fontSize: 11.5 },
      notice: {
        marginTop: 12,
        padding: '8px 10px',
        fontSize: 12,
        lineHeight: 1.6,
        borderRadius: 8,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        border: '1px solid ' + C.line,
        background: C.code,
      },
      /** 输入框：按 primitives 的 Input.module.css 取值，但宽度归自己控制。 */
      input: {
        boxSizing: 'border-box',
        display: 'block',
        width: '100%',
        maxWidth: 420,
        height: 32,
        padding: '0 8px',
        fontSize: 14,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary, ' + C.text + ')',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '0.5px solid var(--dsw-alias-border-l4, ' + C.line + ')',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        outline: 'none',
      },
      fallbackButton: {
        padding: '6px 14px',
        fontSize: 13,
        borderRadius: 8,
        border: '1px solid ' + C.line,
        background: 'transparent',
        color: C.text,
        cursor: 'pointer',
      },
    }

    /* ───────────────────────────── 后端调用 ───────────────────────────── */

    /** POST 一次 `dsh-feishu/api`；HTTP 非 2xx 也照样把 JSON 交回上层判断。 */
    function callApi(payload) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      }).then(function (response) {
        return response.text().then(function (text) {
          var data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch (error) {
            data = null
          }
          if (data === null || typeof data !== 'object') {
            throw new Error(
              '后端没返回 JSON（HTTP ' + response.status + '）：' + String(text).slice(0, 200),
            )
          }
          return data
        })
      })
    }

    /* ───────────────────────────── 小零件 ───────────────────────────── */

    function TextInput(props) {
      /**
       * 不用 primitives 的 `Input`：它外层 `.wrap` 是 `inline-flex`，宽度由内容撑开，
       * 而 `style` 会透传到内层 `<input>`（`flex:1;min-width:0`）改不动外层 —— 放进设置页
       * 会缩成一小截。这里按它的 token 自己画，外观一致、宽度可控。
       */
      return h('input', {
        id: props.id,
        type: props.type || 'text',
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        autoComplete: 'off',
        spellCheck: false,
        style: S.input,
        onChange: props.onChange,
      })
    }

    function ActionButton(props) {
      if (UIButton !== null) {
        return h(
          UIButton,
          {
            type: 'button',
            variant: props.variant || 'outline',
            size: 'sm',
            disabled: props.disabled,
            onClick: props.onClick,
          },
          props.children,
        )
      }
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled,
          style: Object.assign({}, S.fallbackButton, { opacity: props.disabled ? 0.5 : 1 }),
          onClick: props.onClick,
        },
        props.children,
      )
    }

    function Field(props) {
      return h(
        'div',
        { style: S.field },
        h('label', { style: S.label, htmlFor: props.htmlFor }, props.label),
        props.children,
        props.hint ? h('div', { style: S.hint }, props.hint) : null,
      )
    }

    function DetailRow(props) {
      return h(
        'div',
        { style: S.row },
        h('div', { style: S.rowKey }, props.label),
        h('div', { style: Object.assign({}, S.rowVal, props.mono ? S.mono : null) }, props.children),
      )
    }

    function Notice(props) {
      if (!props.notice || !props.notice.text) return null
      var tone = props.notice.tone
      var color = tone === 'err' ? C.err : tone === 'warn' ? C.warn : C.text
      return h('div', { role: 'status', style: Object.assign({}, S.notice, { color: color }) }, props.notice.text)
    }

    /* ───────────────────────────── 设置页主体 ───────────────────────────── */

    function FeishuSection() {
      var appIdState = react.useState('')
      var appId = appIdState[0]
      var setAppId = appIdState[1]

      var secretState = react.useState('')
      var secret = secretState[0]
      var setSecret = secretState[1]

      var chatState = react.useState('')
      var chatId = chatState[0]
      var setChatId = chatState[1]

      var profileState = react.useState('')
      var profilePick = profileState[0]
      var setProfilePick = profileState[1]

      var statusState = react.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]

      var noticeState = react.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var busyState = react.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      /** 拉状态，并在表单还空着时把已存的值填进去（secret 回填不了，只回末 4 位）。 */
      var refresh = react.useCallback(function (keepNotice) {
        setBusy(function (current) {
          return current || 'status'
        })
        return callApi({ op: 'status' })
          .then(function (data) {
            setStatus(data)
            if (data && data.profile && data.profile.name) {
              setProfilePick(function (current) {
                return current || data.profile.name
              })
            }
            if (data && data.env) {
              if (data.env.appId) {
                setAppId(function (current) {
                  return current || data.env.appId
                })
              }
              if (data.env.chatId) {
                setChatId(function (current) {
                  return current || data.env.chatId
                })
              }
            }
            if (!keepNotice) setNotice(null)
          })
          .catch(function (error) {
            setNotice({ tone: 'err', text: '读不到后端状态：' + describeError(error) })
          })
          .then(function () {
            setBusy('')
          })
      }, [])

      react.useEffect(function () {
        refresh(true)
      }, [refresh])

      function describeError(error) {
        if (error && typeof error.message === 'string' && error.message !== '') return error.message
        return String(error)
      }

      var onTest = react.useCallback(
        function () {
          setBusy('test')
          setNotice({ tone: 'dim', text: '正在向飞书校验凭据…' })
          callApi({ op: 'test', appId: appId, appSecret: secret, chatId: chatId })
            .then(function (data) {
              if (data.ok === false) {
                setNotice({ tone: 'err', text: data.error || '测试失败（后端没给原因）' })
                return
              }
              var text = data.message || '凭据有效'
              if (data.warning) text = text + '\n注意：' + data.warning
              setNotice({ tone: data.warning ? 'warn' : 'ok', text: text })
            })
            .catch(function (error) {
              setNotice({ tone: 'err', text: '测试请求失败：' + describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret, chatId],
      )

      var onSave = react.useCallback(
        function () {
          if (appId.trim() === '') {
            setNotice({ tone: 'err', text: '先填 App ID（飞书开放平台里 cli_ 开头的那串）。' })
            return
          }
          setBusy('save')
          setNotice({ tone: 'dim', text: '正在写入凭据并挂载 MCP…' })
          callApi({
            op: 'save',
            appId: appId,
            appSecret: secret,
            chatId: chatId,
            profile: profilePick,
          })
            .then(function (data) {
              if (data.ok === false) {
                var text = data.error || '保存失败（后端没给原因）'
                if (data.hint) text = text + '\n' + data.hint
                setNotice({ tone: 'err', text: text })
                return
              }
              setSecret('')
              setNotice({ tone: 'ok', text: data.message || '已保存。重启 DSH 后生效。' })
              refresh(true)
            })
            .catch(function (error) {
              setNotice({ tone: 'err', text: '保存请求失败：' + describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret, chatId, profilePick, refresh],
      )

      var env = status && status.env ? status.env : null
      var profile = status && status.profile ? status.profile : null
      var profiles = status && Array.isArray(status.profiles) ? status.profiles : []
      var configured = status !== null && status.configured === true

      /* 一行说清"现在能不能用"，其余全部收进细节。 */
      var dotState = status === null ? 'ongoing' : configured ? 'done' : 'warning'
      var summaryText = status === null ? '正在读取…' : configured ? '已配置' : '尚未配置'
      var summaryMeta = ''
      if (configured && env) {
        summaryMeta = env.appId + (env.secretTail ? ' · Secret ****' + env.secretTail : '')
      } else if (env && env.exists) {
        summaryMeta = '凭据文件在，缺 App ID 或 Secret'
      }

      var mounted = profile !== null && profile.mcpMounted === true
      var mountLabel = profile === null ? 'MCP 状态未知' : mounted ? 'MCP 已挂载' : 'MCP 未挂载'
      var mountTone = mounted ? 'success' : profile === null ? 'outline' : 'warning'

      var secretHint = env && env.hasSecret && env.secretTail
        ? '已存一份（末 4 位 ****' + env.secretTail + '）。留空沿用，填入覆盖。'
        : '飞书开放平台 → 凭证与基础信息。'

      return h(
        'div',
        { style: S.page },

        /* ── 标题 ── */
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '飞书连接'),
        h('div', { style: S.lead }, '填凭据、测一次、保存。凭据只写在本机文件里，不进任何配置文件。'),

        /* ── 表单 ── */
        h(
          'div',
          { style: S.group },
          h('div', { style: S.groupTitle }, '凭据'),
          h(
            Field,
            {
              label: 'App ID',
              htmlFor: 'dsh-feishu-app-id',
              hint: '飞书开放平台 → 凭证与基础信息，cli_ 开头。',
            },
            h(TextInput, {
              id: 'dsh-feishu-app-id',
              value: appId,
              placeholder: 'cli_xxxxxxxxxxxxxxxx',
              onChange: function (event) {
                setAppId(event.target.value)
              },
            }),
          ),
          h(
            Field,
            { label: 'App Secret', htmlFor: 'dsh-feishu-app-secret', hint: secretHint },
            h(TextInput, {
              id: 'dsh-feishu-app-secret',
              type: 'password',
              value: secret,
              placeholder: env && env.hasSecret ? '留空 = 沿用已存的 Secret' : '粘贴 App Secret',
              onChange: function (event) {
                setSecret(event.target.value)
              },
            }),
          ),
          h(
            Field,
            {
              label: '默认会话',
              htmlFor: 'dsh-feishu-chat-id',
              hint: '可选。不填就用机器人所在的群。',
            },
            h(TextInput, {
              id: 'dsh-feishu-chat-id',
              value: chatId,
              placeholder: 'oc_xxxxxxxxxxxxxxxx',
              onChange: function (event) {
                setChatId(event.target.value)
              },
            }),
          ),
        ),

        /* ── 动作：主操作在左，次操作在后面 ── */
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', disabled: busy !== '', onClick: onSave },
            busy === 'save' ? '保存中…' : '保存并启用',
          ),
          h(
            ActionButton,
            { variant: 'outline', disabled: busy !== '', onClick: onTest },
            busy === 'test' ? '测试中…' : '测试连接',
          ),
          h('div', { style: S.spacer }),
          h(
            ActionButton,
            {
              variant: 'ghost',
              disabled: busy !== '',
              onClick: function () {
                setNotice(null)
                refresh(false)
              },
            },
            busy === 'status' ? '刷新中…' : '刷新',
          ),
        ),

        h(Notice, { notice: notice }),

        /* ── 状态：一行摘要 + 徽标 ── */
        h(
          'div',
          { style: S.status },
          UIStateDot ? h(UIStateDot, { state: dotState }) : null,
          h('span', { style: S.statusText }, summaryText),
          summaryMeta ? h('span', { style: S.statusMeta }, summaryMeta) : null,
          h('div', { style: S.spacer }),
          UITag ? h(UITag, { tone: mountTone }, mountLabel) : h('span', { style: S.statusMeta }, mountLabel),
        ),

        /* ── 细节：默认收起，需要排查时才展开 ── */
        h(
          'details',
          { style: { marginTop: 2 } },
          h('summary', { style: S.detailToggle }, '技术细节'),
          h(
            'div',
            { style: S.detailBody },

            h(DetailRow, { label: '凭据文件', mono: true }, env && env.path ? env.path : '（未知）'),
            h(
              DetailRow,
              { label: '文件状态' },
              env === null
                ? '（未知）'
                : (env.exists ? '存在' : '不存在') +
                  (env.fileMode ? ' · mode ' + env.fileMode : '') +
                  (env.modeApplied ? '' : ' · 不是 0600'),
            ),
            h(
              DetailRow,
              { label: '目标 profile' },
              profile === null
                ? '（未知）'
                : (profile.name || '（未探测出）') + '（来源：' + profile.source + '）',
            ),
            h(DetailRow, { label: 'patch 文件', mono: true }, profile && profile.patchPath ? profile.patchPath : '（未知）'),
            h(
              DetailRow,
              { label: 'MCP 挂载' },
              profile === null
                ? '（未知）'
                : profile.mcpMounted
                  ? '已挂载（mcp-feishu，重启后连上）'
                  : profile.managedBlock
                    ? '有块，但块里没有 mcp-feishu 行'
                    : '未挂载',
            ),
            h(
              DetailRow,
              { label: '启动包装', mono: true },
              profile === null
                ? '（未知）'
                : profile.wrapperPath + (profile.wrapperExists ? ' · 存在' : ' · 不存在'),
            ),
            h(DetailRow, { label: '控件库' }, UIButton !== null || UITag !== null ? '基座组件已加载' : '基座组件未取到（降级样式）'),

            profiles.length > 1
              ? h(
                  'div',
                  { style: { marginTop: 10 } },
                  h('div', { style: S.label }, '写 patch 到哪个 profile'),
                  h(
                    'select',
                    {
                      value: profilePick,
                      style: Object.assign({}, S.input, { maxWidth: 220 }),
                      onChange: function (event) {
                        setProfilePick(event.target.value)
                      },
                    },
                    h('option', { value: '' }, '（自动探测）'),
                    profiles.map(function (entry) {
                      return h('option', { key: entry, value: entry }, entry)
                    }),
                  ),
                )
              : null,

            status && status.hints && status.hints.length
              ? h(
                  'ul',
                  {
                    style: {
                      margin: '8px 0 0',
                      paddingLeft: 16,
                      fontSize: 11,
                      lineHeight: 1.7,
                      color: C.faint,
                    },
                  },
                  status.hints.map(function (hint, index) {
                    return h('li', { key: String(index) }, hint)
                  }),
                )
              : null,
          ),
        ),
      )
    }

    /* ───────────────────────────── 注册 ───────────────────────────── */

    /**
     * 等 `settings.section` 被声明（由 ui-settings-general 声明）后再登记，
     * `register` 返回注销函数，交给 ctx.effect / 槽位生命周期收走。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'feishu',
            order: 60,
            label: '飞书连接',
          },
          FeishuSection,
        )
      })
    }

    exports.name = ID
    exports.inject = ['slots']
    exports.apply = apply
    exports.FeishuSection = FeishuSection
    return module.exports
  },
})
