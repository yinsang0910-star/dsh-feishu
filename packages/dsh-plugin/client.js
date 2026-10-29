/**
 * dsh-plugin-skeleton —— 浏览器（UI）半侧入口。
 *
 * 这不是打包器的产物，而是手写的 CJS factory：DSH 的模块加载器只要求
 *   window.__ModuleLoader__.load({ id, factory })
 * 且 `id` 必须等于包名；factory 里能用 `require()` 拿到的只有平台基座
 * （react / react-dom / @deepseek-ai/cordis / dsh-client-ui-slots / ui-primitives …）。
 * 依据见 README「Q2」。
 */
window.__ModuleLoader__.load({
  id: '@dsh-feishu/dsh-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var ID = '@dsh-feishu/dsh-plugin'
    // 文档相对路径（无前导斜杠）：shell 的 index 带 <base href="./">，
    // 写成绝对路径会在子路径部署时逃出挂载前缀、请求打不到这条路由。
    var API = 'dsh-plugin-skeleton/api'

    function Section() {
      var state = react.useState('[idle] 还没调用过后端')
      var text = state[0]
      var setText = state[1]

      var ping = react.useCallback(function () {
        setText('[busy] 请求中…')
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'ping', at: Date.now() }),
        })
          .then(function (res) {
            return res.text()
          })
          .then(function (body) {
            setText('[ok] ' + body)
          })
          .catch(function (err) {
            setText('[err] ' + String((err && err.message) || err))
          })
      }, [])

      return h(
        'div',
        { style: { fontSize: 13, lineHeight: 1.7 } },
        h('p', null, 'dsh-plugin-skeleton：这一段是注册到 settings.section 槽位的设置页。'),
        h('button', { type: 'button', onClick: ping }, 'POST /dsh-plugin-skeleton/api'),
        h(
          'pre',
          { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 } },
          text,
        ),
      )
    }

    /**
     * 注册设置页：先等 settings.section 这个槽位被声明（由 ui-settings-general 声明），
     * 再到槽位里登记一条 list 条目。label 直接给字符串（SlotLabel = string | (() => string)）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: ID,
            order: 500,
            label: '插件骨架',
          },
          Section,
        )
      })
    }

    exports.name = ID
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
