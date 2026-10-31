# npm 发布为什么卡住，以及怎么解

四个包已经打包就绪（`@yisang0910/core` / `mcp` / `gateway` / `plugin`，均 0.1.0），
但发布被 npm 的 2FA 政策挡住。这份文档记录实测结论，避免以后重查。

## 一句话结论

**npm 现在要求：发布必须「账号开了 2FA 且当场提供一次性密码」或「持有一个 bypass-2FA 的
granular token」。** 而建这种 token、改 2FA 模式、关 2FA，本身又都要一次性密码。
账号的 2FA 是 `auth-and-writes`（连写入都要码），但手上没有能产生 TOTP 的认证器 —— 于是闭环卡死。

## 实测证据

```
GET /-/npm/v1/user    → {"tfa":{"mode":"auth-and-writes","pending":null}, ...}
PUT /@yisang0910%2fcore → 401 {"error":"You must provide a one-time pass. ..."}
                          WWW-Authenticate: OTP
POST /-/npm/v1/user {"tfa":{"mode":"auth-only"}} → 401
POST /-/npm/v1/tokens  → 400（classic token 创建已禁）
GET  /-/npm/v1/tokens  → 现有 token bypass_2fa=false
```

政策出处：`https://gh.io/npm-gat-bypass2fa-deprecation`
→ `github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/`

- 2026-07-31 起：bypass-2FA 的 granular token 不能再做账号级操作
  （建/删 token、改包权限、配 trusted publishing、管组织成员，全部要交互式 2FA）
- 目标 2027-01：bypass-2FA token 连直接发布也收走，只剩「读私有包 + 暂存发布」
- 官方推荐的替代：**trusted publishing（OIDC）** 或 **staged publishing**

## 试过但行不通的路（别再试）

| 尝试 | 结果 |
|---|---|
| `npm publish --otp=<16 位数字>` | 401 / 404，不是 TOTP 格式 |
| 用 2FA **恢复码**当 otp | 401，报错明确写 `from your authenticator` |
| `npm token create --bypass-2fa --password <密码>` | 403，政策禁止 |
| basic auth（`_auth=base64(user:pass)`） | whoami 通，publish 404 |
| API 建 granular token（`/-/npm/v1/tokens/granular`） | 404，无此端点 |
| API 建组织（`PUT /-/org/<name>`） | 404，npm 没有建组织的 API |
| `npm profile set tfa auth-only` | npm 11 报「tfa is not a property we can set」 |
| `npm login --auth-type=web` 拿到的 token | `bypass_2fa=false`，发布仍是 EOTP |
| Edge 默认 profile 开 `--remote-debugging-port` | 不生效（需非默认 user-data-dir，但那样 cookie 解不开） |
| 复制 Edge profile 到新目录免登录 | App-Bound 加密绑定路径，cookie 失效 |
| 从 Edge `Login Data` 解出密码登 Gmail 读验证码 | 卡在 Google 手机验证码 |

## 三条可行出路（按省力排序）

### 1. 手机认证器扫码（最标准）

npm 上 **Disable** 现有 2FA → 重新 **Enable** → 选 Authenticator app → 出现二维码时
用手机 App 扫（Microsoft / Google Authenticator 都行）→ 之后每次发布给 6 位码。

注意：Disable 也需要一次性密码，所以**先用恢复码登录网页**再操作（恢复码在 `recovery codes`
里，一次性消耗）。恢复码只能用于网页登录，**不能**当 `--otp`。

### 2. 网页建一个 long-lived token（一次搞定，之后全自动）

https://www.npmjs.com/settings/yisang0910/tokens → Generate New Token → **Granular Access Token**

- **Allow this token to bypass two-factor authentication** ← 必须勾（这就是替代 OTP 的开关）
- Permissions = **Read and write**
- Packages and scopes = **All packages**

拿到 `npm_...` 后写进 `~/.npmrc`：

```
//registry.npmjs.org/:_authToken=npm_xxx
registry=https://registry.npmjs.org/
```

然后 `./scripts/release-npm.ps1` 就能一路发完，以后新版本也复用这个 token。

### 3. Trusted Publishing（最长期，需一次网页登记）

`.github/workflows/publish-npm.yml` 已经写好，走 GitHub Actions 的 OIDC：

- `permissions: id-token: write`（已配置）
- `--provenance`（已配置）
- 顺序：core → mcp → gateway → plugin（core 不在 registry 上时另两个的 `workspace:*` 装不上）

只需在 npm 上把这个仓库 + workflow 文件名登记为 trusted publisher，之后打 tag 自动发布，
**永远不需要任何 token 和验证码**。这是 npm 官方推的方向。

## 已经验证过的打包细节

```
pnpm pack  →  workspace:* 会被正确替换成 0.1.0
npm  pack  →  workspace:* 原样保留，装上去会报错
```

所以发布**必须走 pnpm**，不能用裸 `npm publish`。

四个 tarball 的大小（`pnpm pack` 实测）：

| 包 | 大小 |
|---|---|
| `@yisang0910/core@0.1.0` | 21.9 KB |
| `@yisang0910/mcp@0.1.0` | 60.7 KB |
| `@yisang0910/gateway@0.1.0` | 13.2 KB |
| `@yisang0910/plugin@0.1.0` | 60.1 KB |

## npm 没发出去，影响什么

**不影响任何使用路径。** 现在可用的四条分发：

| 方式 | 状态 |
|---|---|
| dsh.so 插件目录 | ✅ 已收录，标「低风险已验证」（slug `dsh-feishu-plugin-3`） |
| dsh.pub 官方仓库 | ✅ PR #173 已合并，等站点索引重建 |
| `npx github:yinsang0910-star/dsh-feishu-mcp` | ✅ 真机跑通 |
| `dsh-feishu-mcp.mcpb` 双击安装 | ✅ v0.1.0 Release 已发，manifest 通过官方校验 |

README 里也明确写了「不从 npm 装」，不会让用户踩空。npm 只是让 `npm install` 少打几个字。
