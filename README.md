<p align="center">
  <img src="icon.png" width="112" alt="Kyubey">
</p>
<h1 align="center">Kyubey</h1>
<p align="center"><b>无状态、零存储的 FCM 推送唤醒中继——让服务端不碰 Firebase 密钥也能叫醒 Madoka。</b></p>
<p align="center">
  <a href="#-部署自己的-kyubey">快速部署</a> ·
  <a href="#-工作原理与特性">工作原理</a> ·
  <a href="#-域名注意事项与本地开发">本地开发</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Push-FCM%20Wire%202-FFCA28?style=flat-square&logo=firebase&logoColor=black" alt="FCM">
  <img src="https://img.shields.io/badge/Storage-Stateless-success?style=flat-square" alt="Stateless">
  <img src="https://img.shields.io/badge/Version-1.0.1-ff69b4?style=flat-square" alt="Version">
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

部署完成后会输出中继地址（例如 `https://kyubey.<account>.workers.dev`）。编译 Madoka 时将其设为 `PUSH_RELAY_URL`（或环境变量 `MAHOGSM_PUSH_RELAY_URL`）即可，服务端无需额外配置。

<details id="-域名注意事项与本地开发">
<summary>🔧 域名注意事项与本地开发</summary>

- **自定义域名注意：** 若绑定自定义域名，请对该域名关闭 Cloudflare Bot Fight Mode 与 WAF 质询，否则服务端和手机的 API 请求会被拦截为 `403`。直接使用默认的 `workers.dev` 域名可避开此问题。
- **保持 SEAL_KEY 固定：** 更换 `SEAL_KEY` 会使已签发的唤醒链接失效，手机将在一天内自动重新注册。
- **本地测试：** 将两个 secret 写入 `.dev.vars` 后运行 `npx wrangler dev`，或运行 `npm test` 执行单元测试。

</details>
