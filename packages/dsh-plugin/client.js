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
 * 后端只有一条路由：`POST dsh-feishu/api`，body 里 `op` 分
 * status / test / save / discover-chats / self-test。
 * 路径写成**文档相对**（无前导斜杠）：shell 的 index 带 `<base href="./">`，
 * 绝对路径会在子路径部署时逃出挂载前缀。
 */
window.__ModuleLoader__.load({
  id: '@dshfeishu/plugin',
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

    var ID = '@dshfeishu/plugin'
    /** 文档相对路径，见文件头注释。 */
    var API = 'dsh-feishu/api'

    /* 全部走 --dsw-* token：明暗主题由基座决定，这里不写任何具体颜色。
       变量名取自基座 primitives 的 *.module.css（见 README「Q4」），不存在的名字
       会让整页退回 fallback 硬编码色，深色主题下必然难看。核过的名字：
         label-primary / label-secondary / label-tertiary / label-error
         border-l1..l4 / bg-base / bg-layer-1..4 / radius-sm|md|lg
         state-success-primary / state-warn-primary / state-error-primary / link

       注意 bg-layer-1/2 在**亮色**主题下都是纯白（和页面同色），当提示框背景会看不见，
       所以提示框走 markdown-code-block（亮 #fafafa / 暗 #1b1b1c），输入框走
       specific-input-major（亮 #fff / 暗 #353638，基座输入框专用的那个）。 */
    var C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      dim: 'var(--dsw-alias-label-secondary, #6f6f6f)',
      faint: 'var(--dsw-alias-label-tertiary, #8f8f8f)',
      line: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.24))',
      code: 'var(--dsw-alias-markdown-code-block, rgba(128,128,128,0.10))',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f4b)',
      err: 'var(--dsw-alias-state-error-primary, #b4232b)',
      warn: 'var(--dsw-alias-state-warn-primary, #8a5a00)',
      accent: 'var(--dsw-alias-link, #2f6fdb)',
      inputBg: 'var(--dsw-specific-input-major, transparent)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    var S = {
      page: { maxWidth: 640, color: C.text, fontSize: 13, lineHeight: 1.6 },
      lead: { color: C.dim, marginTop: 4 },
      group: { marginTop: 20 },
      groupTitle: { fontSize: 12, fontWeight: 600, color: C.dim, marginBottom: 10 },
      field: { marginBottom: 14 },
      label: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 },
      hint: { fontSize: 11, color: C.faint, marginTop: 5, lineHeight: 1.55 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' },
      spacer: { flex: 1 },
      status: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 14,
        paddingTop: 12,
        borderTop: '1px solid ' + C.line,
        fontSize: 12,
      },
      statusText: { fontWeight: 600 },
      statusMeta: {
        color: C.faint,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      detailToggle: { cursor: 'pointer', fontSize: 12, color: C.dim, marginTop: 16, userSelect: 'none' },
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
        background: C.inputBg,
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

      /* ── 步骤条 ── */
      stepBar: { display: 'flex', alignItems: 'stretch', gap: 0, marginTop: 18, flexWrap: 'wrap' },
      stepItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        userSelect: 'none',
        border: '1px solid transparent',
      },
      stepItemActive: {
        border: '1px solid ' + C.line,
        background: C.code,
      },
      stepNum: {
        width: 18,
        height: 18,
        lineHeight: '17px',
        textAlign: 'center',
        borderRadius: 9,
        fontSize: 11,
        fontWeight: 600,
        border: '1px solid ' + C.line,
        color: C.faint,
        flex: '0 0 auto',
      },
      stepNumDone: { background: C.code, color: C.ok, border: '1px solid ' + C.ok },
      stepNumActive: { background: C.accent, color: '#fff', border: '1px solid ' + C.accent },
      stepTitle: { fontSize: 12, fontWeight: 600 },
      stepSep: { alignSelf: 'center', color: C.faint, fontSize: 11, padding: '0 2px' },

      /* ── 步骤内容卡 ── */
      card: { marginTop: 16 },
      cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 4 },
      cardLead: { color: C.dim, fontSize: 12, marginBottom: 14 },

      /* ── 权限表 ── */
      scopeBox: {
        marginTop: 10,
        border: '1px solid ' + C.line,
        borderRadius: 8,
        overflow: 'hidden',
      },
      scopeRow: {
        display: 'flex',
        gap: 10,
        padding: '6px 10px',
        fontSize: 12,
        alignItems: 'baseline',
        borderTop: '1px solid ' + C.line,
      },
      scopeName: { fontFamily: C.mono, fontSize: 11, color: C.text, flex: '0 0 200px', wordBreak: 'break-all' },
      scopeWhy: { color: C.faint, minWidth: 0 },

      /* ── 会话列表 ── */
      chatItem: {
        display: 'flex',
        gap: 9,
        alignItems: 'baseline',
        padding: '7px 10px',
        borderTop: '1px solid ' + C.line,
        cursor: 'pointer',
      },
      chatItemOn: { background: C.code },
      chatName: { fontWeight: 600, fontSize: 12.5 },
      chatMeta: { color: C.faint, fontSize: 11, fontFamily: C.mono },

      /* ── 自检行 ── */
      checkRow: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', fontSize: 12.5 },
      checkIcon: { flex: '0 0 16px', textAlign: 'center', fontWeight: 700, lineHeight: '20px' },
      checkBody: { minWidth: 0, flex: 1 },
      checkLabel: { fontWeight: 600 },
      checkDetail: { color: C.faint, fontSize: 11, marginTop: 1, wordBreak: 'break-word' },

      link: { color: C.accent, textDecoration: 'none', cursor: 'pointer', fontSize: 11 },

      /* ── 扫码创建面板 ── */
      qrPanel: {
        marginTop: 4,
        marginBottom: 16,
        padding: '10px 12px',
        border: '1px solid ' + C.line,
        borderRadius: 8,
      },
      qrHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      qrTitle: { fontSize: 12.5, fontWeight: 600 },
      qrBody: { marginTop: 12 },
      qrImg: {
        width: 168,
        height: 168,
        background: '#fff',
        borderRadius: 6,
        padding: 6,
        boxSizing: 'content-box',
        lineHeight: 0,
        marginBottom: 10,
      },
      qrSide: { fontSize: 11.5, color: C.faint, lineHeight: 1.75 },
    }

    /* ───────────────────────────── 常量 ───────────────────────────── */

    /** 向导第一步要用户开通的权限：每一项都在这里出现过说明是完整集合。 */
    var SCOPES = [
      { scope: 'im:message', why: '机器人回话、发卡片' },
      { scope: 'im:message:send_as_bot', why: '以机器人身份投递' },
      { scope: 'im:chat:readonly', why: '列会话、查群名' },
      { scope: 'im:chat', why: '读群成员' },
      { scope: 'im:resource', why: '上传文件与图片' },
      { scope: 'im:message.group_msg', why: '读群里的聊天记录' },
      { scope: 'drive:drive', why: '云空间读写' },
      { scope: 'docx:document', why: '建文档、写正文' },
      { scope: 'wiki:wiki:readonly', why: '读知识库' },
      { scope: 'bitable:app', why: '多维表格增删改查' },
      { scope: 'contact:user.id:readonly', why: '按邮箱 / 手机找人' },
    ]

    var STEPS = [
      { id: 1, title: '建应用' },
      { id: 2, title: '填凭据' },
      { id: 3, title: '选会话' },
      { id: 4, title: '自检' },
    ]

    var OPEN_PLATFORM = 'https://open.feishu.cn/app'

    /** 飞书后台的权限申请页：q 里塞逗号分隔的 scope，一次带过去。 */
    function authUrl(appId, scopes) {
      if (!appId) return OPEN_PLATFORM
      var base = OPEN_PLATFORM + '/' + encodeURIComponent(appId) + '/auth'
      if (!scopes || scopes.length === 0) return base
      return (
        base +
        '?q=' +
        encodeURIComponent(scopes.join(',')) +
        '&op_from=openapi&token_type=tenant'
      )
    }

    function openUrl(url) {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        /* 弹窗被拦时无副作用：地址也以文本形式显示在旁边。 */
      }
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(
            function () {
              return true
            },
            function () {
              return false
            },
          )
        }
      } catch (error) {
        /* 走下面的兜底 */
      }
      return Promise.resolve(false)
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

    function describeError(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
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
        style: props.mono ? Object.assign({}, S.input, S.mono) : S.input,
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
      var color = tone === 'err' ? C.err : tone === 'warn' ? C.warn : tone === 'ok' ? C.ok : C.text
      return h('div', { role: 'status', style: Object.assign({}, S.notice, { color: color }) }, props.notice.text)
    }

    function LinkButton(props) {
      return h(
        'a',
        {
          href: props.href,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: S.link,
          onClick: function (event) {
            event.preventDefault()
            openUrl(props.href)
          },
        },
        props.children,
      )
    }

    function StepBar(props) {
      var items = []
      for (var i = 0; i < STEPS.length; i += 1) {
        var step = STEPS[i]
        if (i > 0) items.push(h('span', { key: 'sep' + step.id, style: S.stepSep }, '›'))
        var done = props.done[step.id] === true
        var active = props.current === step.id
        var numStyle = Object.assign(
          {},
          S.stepNum,
          done ? S.stepNumDone : null,
          active ? S.stepNumActive : null,
        )
        items.push(
          h(
            'div',
            {
              key: 'step' + step.id,
              role: 'button',
              tabIndex: 0,
              style: Object.assign({}, S.stepItem, active ? S.stepItemActive : null),
              onClick: function (target) {
                return function () {
                  props.onPick(target)
                }
              }(step.id),
            },
            h('span', { style: numStyle }, done && !active ? '✓' : String(step.id)),
            h('span', { style: S.stepTitle }, step.title),
          ),
        )
      }
      return h('div', { style: S.stepBar }, items)
    }

    function CheckIcon(props) {
      if (props.status === 'pass') return h('span', { style: Object.assign({}, S.checkIcon, { color: C.ok }) }, '✓')
      if (props.status === 'fail') return h('span', { style: Object.assign({}, S.checkIcon, { color: C.err }) }, '✕')
      return h('span', { style: Object.assign({}, S.checkIcon, { color: C.faint }) }, '–')
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

      var stepState = react.useState(1)
      var step = stepState[0]
      var setStep = stepState[1]

      var chatsState = react.useState(null)
      var chats = chatsState[0]
      var setChats = chatsState[1]

      var checksState = react.useState(null)
      var checks = checksState[0]
      var setChecks = checksState[1]

      var manualChatState = react.useState(false)
      var manualChat = manualChatState[0]
      var setManualChat = manualChatState[1]

      var copiedState = react.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]

      /** 扫码创建应用：qr 是二维码数据，qrPhase 是那台手机上的进度。 */
      var qrState = react.useState(null)
      var qr = qrState[0]
      var setQr = qrState[1]

      var qrPhaseState = react.useState('')
      var qrPhase = qrPhaseState[0]
      var setQrPhase = qrPhaseState[1]

      /** 只在第一次拿到后端状态时决定停在第几步，之后不再覆盖用户的选择。 */
      var seeded = react.useRef(false)

      function initialStep(data) {
        if (!data) return 1
        var env = data.env || {}
        if (!env.appId || !env.hasSecret) return 1
        if (!env.chatId) return 3
        return 4
      }

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
            if (!seeded.current) {
              seeded.current = true
              setStep(initialStep(data))
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

      /* ── 第 2 步备用入口：扫码直接建一个应用 ── */

      var onQrStart = react.useCallback(function () {
        setQrPhase('starting')
        setNotice({ tone: 'dim', text: '正在向飞书申请一个创建码…' })
        callApi({ op: 'register-begin' })
          .then(function (data) {
            if (data.ok === false) {
              throw new Error(data.error || '申请创建码失败（后端没给原因）')
            }
            setQr(data)
            setQrPhase('waiting')
            setNotice({
              tone: 'dim',
              text: '用手机飞书扫下面的码，在手机上确认创建；确认后这一步会自动完成。',
            })
          })
          .catch(function (error) {
            setQrPhase('')
            setNotice({ tone: 'err', text: describeError(error) })
          })
      }, [])

      /** 轮询扫码结果。成功时后端已经把凭据写进 env，这里只负责推进界面。 */
      react.useEffect(
        function () {
          if (qrPhase !== 'waiting' || !qr || !qr.attemptId) return undefined
          var stopped = false
          var intervalMs = Math.max(2, Number(qr.pollIntervalSeconds) || 5) * 1000
          var timer = null

          function tick() {
            if (stopped) return
            callApi({ op: 'register-poll', attemptId: qr.attemptId })
              .then(function (data) {
                if (stopped) return
                var state = data.state || ''
                if (state === 'succeeded') {
                  setQrPhase('succeeded')
                  setNotice({ tone: 'ok', text: data.message || '应用已创建，凭据已写入本机。' })
                  if (data.appId) setAppId(data.appId)
                  setQr(null)
                  refresh(true)
                  setStep(3)
                  return
                }
                if (state === 'expired' || state === 'denied') {
                  setQrPhase(state)
                  setNotice({ tone: 'warn', text: data.error || '扫码没完成' })
                  return
                }
                timer = setTimeout(tick, intervalMs)
              })
              .catch(function () {
                if (!stopped) timer = setTimeout(tick, intervalMs)
              })
          }

          timer = setTimeout(tick, intervalMs)
          return function () {
            stopped = true
            if (timer !== null) clearTimeout(timer)
          }
        },
        [qrPhase, qr, refresh],
      )

      /* ── 第 2 步：先验凭据，再落盘；验不过就不写坏数据 ── */
      var onSaveCredentials = react.useCallback(
        function () {
          if (String(appId).trim() === '') {
            setNotice({ tone: 'err', text: '先填 App ID（开放平台里 cli_ 开头的那串）。' })
            return
          }
          setBusy('save')
          setNotice({ tone: 'dim', text: '正在向飞书校验凭据…' })
          callApi({ op: 'test', appId: appId, appSecret: secret, chatId: '' })
            .then(function (tested) {
              if (tested.ok === false) {
                throw new Error(tested.error || '凭据校验没过（后端没给原因）')
              }
              setNotice({ tone: 'dim', text: '凭据有效，正在写入并挂载 MCP…' })
              return callApi({
                op: 'save',
                appId: appId,
                appSecret: secret,
                chatId: '',
                profile: profilePick,
              })
            })
            .then(function (saved) {
              if (saved.ok === false) {
                var text = saved.error || '保存失败（后端没给原因）'
                if (saved.hint) text = text + '\n' + saved.hint
                throw new Error(text)
              }
              setSecret('')
              setChecks(null)
              setNotice({ tone: 'ok', text: '凭据已保存。下一步选一个群。' })
              setStep(3)
              refresh(true)
            })
            .catch(function (error) {
              setNotice({ tone: 'err', text: describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret, profilePick, refresh],
      )

      /* ── 第 3 步：扫会话 ── */
      var onScanChats = react.useCallback(
        function () {
          setBusy('scan')
          setNotice({ tone: 'dim', text: '正在向飞书要会话列表…' })
          callApi({ op: 'discover-chats', appId: appId, appSecret: secret })
            .then(function (data) {
              if (data.ok === false) {
                var text = data.error || '扫描失败（后端没给原因）'
                if (data.scope) {
                  text =
                    text +
                    '\n缺权限 ' +
                    data.scope +
                    '：开通后重新扫描（应用 ID ' +
                    (appId || '未填') +
                    '）。'
                }
                throw new Error(text)
              }
              setChats(Array.isArray(data.chats) ? data.chats : [])
              setNotice({
                tone: data.chats && data.chats.length ? 'ok' : 'warn',
                text: data.message || ('找到 ' + String((data.chats || []).length) + ' 个会话'),
              })
            })
            .catch(function (error) {
              setChats([])
              setNotice({ tone: 'err', text: describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret],
      )

      var onSaveChat = react.useCallback(
        function (nextChatId) {
          if (String(nextChatId).trim() === '') {
            setNotice({ tone: 'warn', text: '先选一个会话，或展开手动填写 chat_id。' })
            return
          }
          setBusy('save-chat')
          callApi({
            op: 'save',
            appId: appId,
            appSecret: secret,
            chatId: nextChatId,
            profile: profilePick,
          })
            .then(function (data) {
              if (data.ok === false) {
                throw new Error(data.error || '保存失败（后端没给原因）')
              }
              setChatId(nextChatId)
              setChecks(null)
              setNotice({ tone: 'ok', text: '已设为默认会话。最后跑一次自检。' })
              setStep(4)
              refresh(true)
            })
            .catch(function (error) {
              setNotice({ tone: 'err', text: describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret, profilePick, refresh],
      )

      /* ── 第 4 步：逐项自检 ── */
      var onSelfTest = react.useCallback(
        function () {
          setBusy('self-test')
          setNotice({ tone: 'dim', text: '正在逐项检查（大约 2 秒）…' })
          callApi({ op: 'self-test', appId: appId, appSecret: secret, chatId: chatId })
            .then(function (data) {
              if (data.ok === false && !Array.isArray(data.checks)) {
                throw new Error(data.error || '自检失败（后端没给原因）')
              }
              setChecks(Array.isArray(data.checks) ? data.checks : [])
              setNotice({
                tone: data.failed > 0 ? 'err' : 'ok',
                text: data.message || '自检结束',
              })
              refresh(true)
            })
            .catch(function (error) {
              setChecks(null)
              setNotice({ tone: 'err', text: describeError(error) })
            })
            .then(function () {
              setBusy('')
            })
        },
        [appId, secret, chatId, refresh],
      )

      var onCopyScopes = react.useCallback(function () {
        var text = SCOPES.map(function (item) {
          return item.scope
        }).join('\n')
        copyText(text).then(function (ok) {
          setCopied(ok)
          setNotice({
            tone: ok ? 'ok' : 'warn',
            text: ok
              ? '权限清单已复制（' + String(SCOPES.length) + ' 条），粘到飞书后台的「批量导入权限」里。'
              : '浏览器不让写剪贴板：直接照下面的表在后台勾选即可，共 ' + String(SCOPES.length) + ' 项。',
          })
        })
      }, [])

      var env = status && status.env ? status.env : null
      var profile = status && status.profile ? status.profile : null
      var profiles = status && Array.isArray(status.profiles) ? status.profiles : []
      var configured = status !== null && status.configured === true
      var hasSecret = env !== null && env.hasSecret === true
      var hasAppId = env !== null && env.appId !== null && env.appId !== undefined && env.appId !== ''

      var doneMap = {}
      doneMap[1] = true
      doneMap[2] = hasAppId && hasSecret
      doneMap[3] = doneMap[2] && env.chatId !== null && env.chatId !== undefined && env.chatId !== ''
      doneMap[4] = false
      if (checks !== null && checks.length > 0) {
        var failedCount = 0
        for (var ci = 0; ci < checks.length; ci += 1) {
          if (checks[ci].status === 'fail') failedCount += 1
        }
        doneMap[4] = failedCount === 0
      }

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

      var busyAny = busy !== ''

      /* ── 第 1 步：建应用 + 权限 ── */
      var step1 = h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '在飞书开放平台建一个企业自建应用'),
        h(
          'div',
          { style: S.cardLead },
          '打开开放平台 → 创建企业自建应用 → 把下面这些权限一次勾上。只有第 3 步要手抄的东西（App ID / Secret）在这一页。',
        ),
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', onClick: function () { openUrl(OPEN_PLATFORM) } },
            '打开飞书开放平台',
          ),
          h(
            ActionButton,
            { variant: 'outline', disabled: busyAny, onClick: onCopyScopes },
            copied ? '已复制' : '复制权限清单',
          ),
        ),
        h(
          'div',
          { style: S.scopeBox },
          SCOPES.map(function (item, index) {
            return h(
              'div',
              {
                key: item.scope,
                style: index === 0 ? Object.assign({}, S.scopeRow, { borderTop: 'none' }) : S.scopeRow,
              },
              h('span', { style: S.scopeName }, item.scope),
              h('span', { style: S.scopeWhy }, item.why),
            )
          }),
        ),
        h(
          'div',
          { style: S.hint },
          '在开放平台的「权限管理」里搜权限名逐个勾，或用「批量导入权限」粘贴上面复制的清单。少勾不会立刻报错，会在第 4 步自检里指出来。',
        ),
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', onClick: function () { setNotice(null); setStep(2) } },
            '下一步：填凭据',
          ),
        ),
      )

      /* ── 第 2 步：凭据 ── */
      var secretHint = hasSecret && env && env.secretTail
        ? '已存一份（末 4 位 ****' + env.secretTail + '）。留空沿用，填入覆盖。'
        : '开放平台 → 凭证与基础信息 → App Secret。它只在后台可见，任何扫码都拿不到。'

      var step2 = h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '把 App ID 和 App Secret 填进来'),
        h(
          'div',
          { style: S.cardLead },
          '只写进本机 ' +
            (env && env.path ? env.path : '~/.config/dsh/feishu.env') +
            '，不进任何随仓库分发的文件。',
        ),

        /* ── 备选：扫码直接建一个，省掉去后台抄凭据 ── */
        h(
          'div',
          { style: S.qrPanel },
          h(
            'div',
            { style: S.qrHead },
            h('span', { style: S.qrTitle }, '还没有自建应用？用手机飞书扫一下直接建一个'),
            h(
              ActionButton,
              {
                variant: qr ? 'ghost' : 'outline',
                disabled: busyAny || qrPhase === 'starting',
                onClick: onQrStart,
              },
              qrPhase === 'starting' ? '生成中…' : qr ? '换个码' : '扫码创建',
            ),
          ),
          qr && (qrPhase === 'waiting' || qrPhase === 'slow_down')
            ? h(
                'div',
                { style: S.qrBody },
                h('div', {
                  style: S.qrImg,
                  dangerouslySetInnerHTML: { __html: qr.qrSvg || '' },
                }),
                h(
                  'div',
                  { style: S.qrSide },
                  h('div', null, '手机飞书 → 扫一扫 → 确认创建。'),
                  h('div', null, '确认之后应用会自动建好，凭据直接写进本机，不用你抄。'),
                  qr.qrUrl
                    ? h(
                        'div',
                        { style: { marginTop: 8 } },
                        h(LinkButton, { href: qr.qrUrl }, '在浏览器里打开这个页面'),
                      )
                    : null,
                ),
              )
            : null,
          qrPhase === 'expired'
            ? h('div', { style: S.hint }, '二维码过期了，点「换个码」重新生成。')
            : null,
          qrPhase === 'denied'
            ? h('div', { style: S.hint }, '你在手机上取消了创建。可以再扫一次。')
            : null,
        ),

        h(
          Field,
          {
            label: 'App ID',
            htmlFor: 'dsh-feishu-app-id',
            hint: hasAppId ? '已读到已保存的值：' + env.appId + '（扫码建好的也会填在这里）' : 'cli_ 开头的那一串。',
          },
          h(TextInput, {
            id: 'dsh-feishu-app-id',
            value: appId,
            placeholder: 'cli_xxxxxxxxxxxxxxxx',
            mono: true,
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
            placeholder: hasSecret ? '留空 = 沿用已存的 Secret' : '粘贴 App Secret',
            onChange: function (event) {
              setSecret(event.target.value)
            },
          }),
        ),
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', disabled: busyAny, onClick: onSaveCredentials },
            busy === 'save' ? '校验并保存…' : '校验并保存',
          ),
          h(
            ActionButton,
            { variant: 'ghost', disabled: busyAny, onClick: function () { setStep(1) } },
            '上一步',
          ),
        ),
      )

      /* ── 第 3 步：会话 ── */
      var chatRows = []
      if (chats !== null) {
        if (chats.length === 0) {
          chatRows.push(
            h(
              'div',
              { key: 'empty', style: Object.assign({}, S.scopeRow, { borderTop: 'none', color: C.faint }) },
              '没有可见会话：先把机器人拉进一个群，再点「重新扫描」。',
            ),
          )
        } else {
          chats.forEach(function (item, index) {
            var on = chatId === item.chatId
            chatRows.push(
              h(
                'div',
                {
                  key: item.chatId,
                  role: 'button',
                  tabIndex: 0,
                  style: Object.assign(
                    {},
                    S.chatItem,
                    index === 0 ? { borderTop: 'none' } : null,
                    on ? S.chatItemOn : null,
                  ),
                  onClick: function () {
                    setChatId(item.chatId)
                  },
                },
                h('span', { style: { flex: '0 0 12px', color: on ? C.accent : C.faint } }, on ? '●' : '○'),
                h(
                  'span',
                  { style: { minWidth: 0, flex: 1 } },
                  h('div', { style: S.chatName }, item.name || '(无名会话)'),
                  h(
                    'div',
                    { style: S.chatMeta },
                    /* im/v1/chats 的列表项只有 name / description / chat_id / external 等 8 个字段，
                       没有 user_count —— 人数得再查一次详情，列表里不值得为此多打 N 个请求。 */
                    (item.description ? item.description + ' · ' : '') +
                      item.chatId +
                      (item.external ? ' · 外部群' : ''),
                  ),
                ),
              ),
            )
          })
        }
      }

      var step3 = h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '选一个默认会话'),
        h(
          'div',
          { style: S.cardLead },
          '默认会话是 bot 主动发消息、跑任务时回话的地方。列出来点一下就行，不用再手抄 oc_ 开头的那串 ID。',
        ),
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', disabled: busyAny, onClick: onScanChats },
            busy === 'scan' ? '扫描中…' : chats === null ? '扫描我的会话' : '重新扫描',
          ),
          h(
            ActionButton,
            { variant: 'ghost', disabled: busyAny, onClick: function () { setManualChat(!manualChat) } },
            manualChat ? '收起手动填写' : '手动填写 chat_id',
          ),
        ),
        chats !== null ? h('div', { style: S.scopeBox }, chatRows) : null,
        manualChat
          ? h(
              'div',
              { style: { marginTop: 14 } },
              h(
                Field,
                {
                  label: 'chat_id',
                  htmlFor: 'dsh-feishu-chat-id',
                  hint: '群设置里看不到这个值：能扫就用扫描，手填一般用于已知 ID 的场景。',
                },
                h(TextInput, {
                  id: 'dsh-feishu-chat-id',
                  value: chatId,
                  placeholder: 'oc_xxxxxxxxxxxxxxxx',
                  mono: true,
                  onChange: function (event) {
                    setChatId(event.target.value)
                  },
                }),
              ),
            )
          : null,
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: 'primary', disabled: busyAny || String(chatId).trim() === '', onClick: function () { onSaveChat(chatId) } },
            busy === 'save-chat' ? '保存中…' : '用这个会话',
          ),
          h(
            ActionButton,
            { variant: 'ghost', disabled: busyAny, onClick: function () { setStep(2) } },
            '上一步',
          ),
        ),
      )

      /* ── 第 4 步：自检 ── */
      var checkRows = []
      if (checks !== null) {
        checks.forEach(function (item, index) {
          var lines = [
            h(CheckIcon, { key: 'icon', status: item.status }),
            h(
              'div',
              { key: 'body', style: S.checkBody },
              h('div', { style: S.checkLabel }, item.label),
              item.detail ? h('div', { style: S.checkDetail }, item.detail) : null,
              item.status === 'fail' && item.scope
                ? h(
                    'div',
                    { style: { marginTop: 2 } },
                    h(
                      LinkButton,
                      { href: authUrl(appId || (env && env.appId) || '', [item.scope]) },
                      '去开通 ' + item.scope + ' →',
                    ),
                  )
                : null,
            ),
          ]
          checkRows.push(h('div', { key: 'check' + index, style: S.checkRow }, lines))
        })
      }

      var failCount = 0
      if (checks !== null) {
        for (var fi = 0; fi < checks.length; fi += 1) {
          if (checks[fi].status === 'fail') failCount += 1
        }
      }
      var allPassed = checks !== null && checks.length > 0 && failCount === 0

      var step4 = h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '跑一遍自检'),
        h(
          'div',
          { style: S.cardLead },
          '逐项真的调飞书接口：凭据、机器人身份、会话列表、目标群、读历史、上传文件、云空间。不上传就不发消息，聊天里不会多出东西。',
        ),
        h(
          'div',
          { style: S.actions },
          h(
            ActionButton,
            { variant: allPassed ? 'outline' : 'primary', disabled: busyAny, onClick: onSelfTest },
            busy === 'self-test' ? '检查中…' : checks === null ? '开始自检' : '重新自检',
          ),
          h(
            ActionButton,
            { variant: 'ghost', disabled: busyAny, onClick: function () { setStep(3) } },
            '上一步',
          ),
        ),
        checks !== null ? h('div', { style: { marginTop: 14 } }, checkRows) : null,
        allPassed
          ? h(
              'div',
              { style: Object.assign({}, S.notice, { color: C.ok, marginTop: 14 }) },
              '全部通过。工具已经挂进 profile，重启 DSH 之后 mcp__feishu__* 就能用了。',
            )
          : null,
        !allPassed && checks !== null && failCount > 0
          ? h(
              'div',
              { style: S.actions },
              h(
                ActionButton,
                {
                  variant: 'outline',
                  onClick: function () {
                    var scopes = []
                    for (var i = 0; i < checks.length; i += 1) {
                      var item = checks[i]
                      if (item.status === 'fail' && item.scope && scopes.indexOf(item.scope) < 0) {
                        scopes.push(item.scope)
                      }
                    }
                    openUrl(authUrl(appId || (env && env.appId) || '', scopes))
                  },
                },
                '一次开通全部缺的权限',
              ),
            )
          : null,
      )

      var body = step === 1 ? step1 : step === 2 ? step2 : step === 3 ? step3 : step4

      return h(
        'div',
        { style: S.page },

        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '飞书连接'),
        h(
          'div',
          { style: S.lead },
          '四个步骤走完就能用。凭据只落在本机文件里；下面每一步都会先验证再写入。',
        ),

        h(StepBar, { current: step, done: doneMap, onPick: setStep }),

        body,

        h(Notice, { notice: notice }),

        h(
          'div',
          { style: S.status },
          UIStateDot ? h(UIStateDot, { state: dotState }) : null,
          h('span', { style: S.statusText }, summaryText),
          summaryMeta ? h('span', { style: S.statusMeta }, summaryMeta) : null,
          h('div', { style: S.spacer }),
          UITag ? h(UITag, { tone: mountTone }, mountLabel) : h('span', { style: S.statusMeta }, mountLabel),
        ),

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
            h(
              DetailRow,
              { label: 'patch 文件', mono: true },
              profile && profile.patchPath ? profile.patchPath : '（未知）',
            ),
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
            h(
              DetailRow,
              { label: '控件库' },
              UIButton !== null || UITag !== null ? '基座组件已加载' : '基座组件未取到（降级样式）',
            ),

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
