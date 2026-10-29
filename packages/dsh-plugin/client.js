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
     * 官方 UI primitives 在基座表里（不需要新依赖、不需要打包）。
     * 但取不到时退回原生元素：宁可样式朴素，也不能让整节设置页消失。
     */
    var primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (error) {
      primitives = {}
    }
    var UIButton = typeof primitives.Button === 'function' ? primitives.Button : null
    var UIInput = typeof primitives.Input === 'function' ? primitives.Input : null

    var ID = '@dsh-feishu/dsh-plugin'
    /** 文档相对路径，见文件头注释。 */
    var API = 'dsh-feishu/api'

    var COLOR = {
      text: 'var(--dsw-alias-text-primary, #1b1b1b)',
      dim: 'var(--dsw-alias-text-secondary, #6f6f6f)',
      line: 'var(--dsw-alias-border-subtle, rgba(0,0,0,0.12))',
      ok: '#177245',
      warn: '#8a5a00',
      err: '#b4232b',
      code: 'var(--dsw-alias-bg-secondary, rgba(0,0,0,0.04))',
    }

    var fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
    var labelStyle = { fontSize: 12, fontWeight: 600, color: COLOR.text }
    var hintStyle = { fontSize: 11, color: COLOR.dim, lineHeight: 1.5 }
    var inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 460,
      padding: '6px 9px',
      fontSize: 13,
      color: COLOR.text,
      background: 'transparent',
      border: '1px solid ' + COLOR.line,
      borderRadius: 8,
      outline: 'none',
    }
    var codeStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11,
      background: COLOR.code,
      padding: '1px 5px',
      borderRadius: 4,
      wordBreak: 'break-all',
    }
    var buttonRowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0 6px' }

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
      var shared = {
        type: props.type || 'text',
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        autoComplete: 'off',
        spellCheck: false,
        onChange: props.onChange,
      }
      if (UIInput !== null) {
        shared.style = { width: '100%', maxWidth: 460 }
        return h(UIInput, shared)
      }
      shared.style = inputStyle
      return h('input', shared)
    }

    function ActionButton(props) {
      if (UIButton !== null) {
        return h(
          UIButton,
          {
            type: 'button',
            variant: props.variant || 'primary',
            size: 'sm',
            disabled: props.disabled,
            onClick: props.onClick,
          },
          props.children,
        )
      }
      var style = {
        padding: '6px 14px',
        fontSize: 13,
        borderRadius: 8,
        border: '1px solid ' + COLOR.line,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
        background: props.variant === 'primary' ? COLOR.text : 'transparent',
        color: props.variant === 'primary' ? '#fff' : COLOR.text,
      }
      return h('button', { type: 'button', style: style, disabled: props.disabled, onClick: props.onClick }, props.children)
    }

    function Field(props) {
      return h(
        'div',
        { style: fieldStyle },
        h('label', { style: labelStyle }, props.label),
        props.children,
        props.hint ? h('div', { style: hintStyle }, props.hint) : null,
      )
    }

    function StatusRow(props) {
      var value = props.value
      var valueNode
      if (props.mono) {
        valueNode = h('code', { style: codeStyle }, String(value))
      } else {
        valueNode = h('span', null, String(value))
      }
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 10,
            padding: '3px 0',
            fontSize: 12,
            lineHeight: 1.6,
            alignItems: 'baseline',
          },
        },
        h('span', { style: { minWidth: 92, color: COLOR.dim, flex: '0 0 auto' } }, props.label),
        h('span', { style: { color: props.tone ? COLOR[props.tone] : COLOR.text, minWidth: 0 } }, valueNode),
      )
    }

    function Notice(props) {
      if (!props.notice || !props.notice.text) return null
      return h(
        'div',
        {
          role: 'status',
          style: {
            marginTop: 10,
            padding: '8px 10px',
            fontSize: 12,
            lineHeight: 1.6,
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: COLOR[props.notice.tone] || COLOR.text,
            background: COLOR.code,
            border: '1px solid ' + COLOR.line,
          },
        },
        props.notice.text,
      )
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
            setNotice({ tone: 'err', text: '先填 App ID（飞书开放平台的 cli_ 开头的那串）。' })
            return
          }
          setBusy('save')
          setNotice({ tone: 'dim', text: '正在写凭据文件与 profile patch…' })
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
              var lines = [data.message || '已保存。重启 DSH 后生效。']
              if (data.patch && data.patch.path) {
                lines.push('patch：' + data.patch.path + '（' + data.patch.mode + '）')
              }
              if (data.warnings && data.warnings.length) {
                lines.push('注意：' + data.warnings.join(' / '))
              }
              setNotice({ tone: 'ok', text: lines.join('\n') })
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

      var configuredText
      if (env === null) configuredText = '未知（还没读到状态）'
      else if (status.configured) {
        configuredText =
          '已配置 · App ID ' + env.appId + ' · Secret ' + (env.secretTail ? '****' + env.secretTail : '已存')
      } else if (env.exists) {
        configuredText = '凭据文件在，但缺 App ID 或 Secret'
      } else {
        configuredText = '未配置'
      }

      var secretHint = '密码框：只在点「测试连接 / 保存并启用」时发给本机后端；留空表示沿用已存的那份。'
      if (env && env.hasSecret && env.secretTail) {
        secretHint = '已存一份（末 4 位 ****' + env.secretTail + '）；留空则沿用，填入则覆盖。'
      }

      return h(
        'div',
        { style: { maxWidth: 720, color: COLOR.text, fontSize: 13, lineHeight: 1.7 } },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '飞书连接'),
        h(
          'div',
          { style: hintStyle },
          '把飞书接进 DSH：填 App ID / App Secret / 默认会话，先测连接，再保存并启用。凭据写到 ',
          h('code', { style: codeStyle }, env && env.path ? env.path : '~/.config/dsh/feishu.env'),
          '（0600），MCP 行写进当前 profile 的 ',
          h('code', { style: codeStyle }, 'cordis.patch.yml'),
          '。',
        ),

        /* ── 表单 ── */
        h(
          'div',
          { style: { marginTop: 18 } },
          h(
            Field,
            {
              label: 'App ID',
              hint: '飞书开放平台 → 凭证与基础信息 → App ID（cli_ 开头）。',
            },
            h(TextInput, {
              value: appId,
              placeholder: 'cli_xxxxxxxxxxxxxxxx',
              onChange: function (event) {
                setAppId(event.target.value)
              },
            }),
          ),
          h(
            Field,
            { label: 'App Secret', hint: secretHint },
            h(TextInput, {
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
              label: '默认会话 chat_id（可选）',
              hint: '群设置里拿到的 oc_ 开头的 chat_id；机器人必须在群里，否则测试会报「查不到」。',
            },
            h(TextInput, {
              value: chatId,
              placeholder: 'oc_xxxxxxxxxxxxxxxx',
              onChange: function (event) {
                setChatId(event.target.value)
              },
            }),
          ),
        ),

        /* ── 动作 ── */
        h(
          'div',
          { style: buttonRowStyle },
          h(
            ActionButton,
            { variant: 'outline', disabled: busy !== '', onClick: onTest },
            busy === 'test' ? '测试中…' : '测试连接',
          ),
          h(
            ActionButton,
            { variant: 'primary', disabled: busy !== '', onClick: onSave },
            busy === 'save' ? '保存中…' : '保存并启用',
          ),
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
            busy === 'status' ? '刷新中…' : '刷新状态',
          ),
        ),

        h(Notice, { notice: notice }),

        /* ── 状态区 ── */
        h(
          'div',
          {
            style: {
              marginTop: 18,
              paddingTop: 14,
              borderTop: '1px solid ' + COLOR.line,
            },
          },
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, '当前状态'),
          h(StatusRow, {
            label: '凭据',
            value: configuredText,
            tone: env === null ? 'dim' : status.configured ? 'ok' : 'warn',
          }),
          h(StatusRow, {
            label: '凭据文件',
            mono: true,
            value: env === null ? '(未知)' : env.path,
          }),
          h(StatusRow, {
            label: '文件状态',
            value:
              env === null
                ? '(未知)'
                : (env.exists ? '存在' : '不存在') +
                  (env.fileMode ? ' · mode ' + env.fileMode : '') +
                  (env.modeApplied ? '' : ' · 不是 0600'),
            tone: env && env.exists ? 'ok' : 'warn',
          }),
          h(StatusRow, {
            label: '目标 profile',
            value:
              profile === null
                ? '(未知)'
                : (profile.name || '(未探测出)') + '（来源：' + profile.source + '）',
            tone: profile && profile.name ? 'text' : 'warn',
          }),
          h(StatusRow, {
            label: 'patch 文件',
            mono: true,
            value: profile && profile.patchPath ? profile.patchPath : '(未知)',
          }),
          h(StatusRow, {
            label: 'MCP 挂载',
            value:
              profile === null
                ? '(未知)'
                : profile.mcpMounted
                  ? '已挂载（mcp-feishu，重启后连上）'
                  : profile.managedBlock
                    ? '有块但缺 mcp-feishu 行'
                    : '未挂载',
            tone: profile && profile.mcpMounted ? 'ok' : 'warn',
          }),
          h(StatusRow, {
            label: '启动包装',
            mono: true,
            value:
              profile === null
                ? '(未知)'
                : profile.wrapperPath + (profile.wrapperExists ? ' · 存在' : ' · 不存在'),
            tone: profile && profile.wrapperExists ? 'text' : 'warn',
          }),

          profiles.length > 1
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { style: labelStyle }, '写 patch 到哪个 profile'),
                h(
                  'select',
                  {
                    value: profilePick,
                    style: Object.assign({}, inputStyle, { maxWidth: 240 }),
                    onChange: function (event) {
                      setProfilePick(event.target.value)
                    },
                  },
                  h('option', { value: '' }, '(自动探测)'),
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
                    margin: '10px 0 0',
                    paddingLeft: 18,
                    fontSize: 11,
                    lineHeight: 1.7,
                    color: COLOR.dim,
                  },
                },
                status.hints.map(function (hint, index) {
                  return h('li', { key: String(index) }, hint)
                }),
              )
            : null,
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
