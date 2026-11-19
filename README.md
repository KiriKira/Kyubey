<p align="center">
  <img src="icon.png" width="112" alt="Kyubey">
</p>
<h1 align="center">Kyubey</h1>
<p align="center"><b>无状态、零存储的 FCM 推送唤醒中继——让服务端不碰 Firebase 密钥也能叫醒 Madoka。</b></p>
<p align="center">
  <a href="#-部署自己的-kyubey">快速部署</a> ·
  <a href="#-工作原理与特性">工作原理</a> ·
  <a href="#-节点调用接口">节点接口</a> ·
  <a href="#-运维注意">运维注意</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Push-FCM%20Wire%202-FFCA28?style=flat-square&logo=firebase&logoColor=black" alt="FCM">
  <img src="https://img.shields.io/badge/Storage-Stateless-success?style=flat-square" alt="Stateless">
  <img src="https://img.shields.io/badge/Version-1.0.1-ff69b4?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License">
</p>

**Kyubey** 是 MahoGSM 系列的专用推送唤醒中继。平时使用官方构建的 Madoka 时，你不需要自己申请 Firebase 账号；而在你自建 [SoulGem](https://github.com/KiriKira/SoulGem) 或 [GriefSeed](https://github.com/KiriKira/GriefSeed) 时，服务端也不用持有任何 Firebase 密钥，直接通过 Kyubey 就能在来电或新短信到达时唤醒主力手机。

## ✨ 工作原理与特性

```
Madoka ──FCM token──▶ POST /v1/register ──▶ 生成加密唤醒链接
Madoka ──唤醒链接───▶ 上报给已配对的服务端节点
节点   ──有新来电/短信──▶ POST 唤醒链接 ──FCM──▶ Madoka 醒来并同步
```

- **不存任何数据：** 手机的 FCM token 会用 `SEAL_KEY`（AES-GCM）直接加密进唤醒 URL 里。服务端只拿得到一个链接，Kyubey 自己也不设数据库。
- **不传短信与通话内容：** 只发送不含正文的唤醒信号（`sms` / `call` / `check`），支持 Wire 2 携带 `call_id` 让手机精准拉取那一通来电。
- **免费额度管够：** 跑在 Cloudflare Workers 免费版上即可满足个人日常使用；内置每分钟 60 次限流，且来电与短信额度分开计算，短信再多也不会挤占来电唤醒。
- **自建客户端也能用：** 如果你自己编译了 Madoka 并换了自己的 Firebase 项目，只需部署一个自己的 Kyubey，填入对应的 relay 地址即可。

## 🚀 部署自己的 Kyubey

准备你的 Madoka 构建所使用的 Firebase 项目（`google-services.json`）及对应的 Service Account JSON 密钥：

```sh
npm install
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put SEAL_KEY
npx wrangler secret put FCM_SERVICE_ACCOUNT < firebase-service-account.json
npx wrangler deploy
```

部署完成后会输出中继地址（例如 `https://kyubey.<account>.workers.dev`）。编译 Madoka 时把它设为推送中继地址（`MAHOGSM_PUSH_RELAY_URL`）。SoulGem 接受任意 `https://` 唤醒链接，无需配置；GriefSeed 需要把 `PUSH_ALLOWED_HOSTS` 改成你的中继主机名。

## 🔌 节点调用接口

节点（SoulGem / GriefSeed）只需要往手机上报的唤醒链接发一个 POST：

```sh
curl -X POST "$ENDPOINT" -H 'Content-Type: application/json' \
  -H 'TTL: 30' -H 'Urgency: high' \
  -d '{"kind":"call"}'
```

- `kind`：`sms`、`call` 或 `check`（只让 FCM 校验 token、不真正推送，节点登记链接时用）。其他字段一律忽略。
- **Wire 2：** 带上 `"v": 2` 后可附加 `wake_id`、`call_id`（UUID，仅来电）、`revision`、`endpoint_generation`，手机据此只拉取那一通来电。旧版手机会丢弃这类消息，所以只对声明支持 wire 2 的手机发送。每个响应都带 `kyubey-wire: 1,2`。
- **`TTL` / `Urgency`（可选）：** 转成 FCM 的 TTL 和优先级（`high` 为 HIGH，其余为 NORMAL）；不带时默认 60 秒、HIGH。
- **返回码：** `201` 已发送 · `410` 设备已失效，节点应删除该链接 · `404` 不是本中继的链接 · `429` 限流 · `502` 中继自己的 FCM 密钥被拒 · `503` FCM 暂时不可用，稍后重试 · `504` TTL 在中继内耗尽。

## 🔧 运维注意

- **自定义域名：** 对该域名关闭 Bot Fight Mode，并让 WAF / Security Level 质询跳过中继主机名，否则节点和手机会收到带 `cf-mitigated: challenge` 的 `403`。直接用 `workers.dev` 域名可避开此问题。
- **保持 `SEAL_KEY` 固定：** 更换会让已签发的唤醒链接全部失效，手机会在一天内自动重新注册。
- **限流：** 使用 `wrangler.toml` 里的 Cloudflare rate-limiting binding；账号不支持时删掉那一段即可。
- **本地开发：** 把两个 secret 写入 `.dev.vars` 后运行 `npx wrangler dev`；`npm test` 运行单元测试（无额外依赖）。

## 📄 许可证

[MIT](LICENSE)
