# Kyubey

Stateless push relay for [mahogsm](https://github.com/KiriKira/gsm2sip-server): server nodes (SoulGem)
wake the main phone (Madoka) through it without holding any Firebase credentials. It runs as a
Cloudflare Worker.

```
Madoka ──FCM token──▶ POST /v1/register ──▶ {"endpoint": "https://<relay>/v1/w/<sealed>"}
Madoka ──endpoint──▶ every paired node (PUT /v1/devices/self/push-endpoint)
node ──{"kind":"sms"|"call"}──▶ POST /v1/w/<sealed> ──FCM──▶ Madoka syncs over HTTPS
```

- **No storage.** The FCM token is sealed into the endpoint URL with AES-GCM under `SEAL_KEY`.
  A node sees only the URL; the relay sees only the token and the node's device ID.
- **No content.** The relay sends a fixed high-priority data message, `type`, `kind` (`sms` or `call`)
  and `device_id`; anything else a node sends is ignored. `kind: "check"` asks FCM to validate the
  token without delivering, which nodes use when an endpoint is registered.
- **Answers a node can act on.** `201` sent; `410` the device is gone (the node forgets the endpoint);
  `404` not an endpoint of this relay; `429` rate-limited; `502` the relay's own key is refused;
  `503` FCM is temporarily unavailable (retry later).

## Deploy

You need the Firebase project that the Madoka build uses (its `google-services.json`) and a
service-account key of that project.

```sh
npm install
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put SEAL_KEY
npx wrangler secret put FCM_SERVICE_ACCOUNT < firebase-service-account.json
npx wrangler deploy
```

The deploy prints the relay URL, for example `https://kyubey.<account>.workers.dev`. Build Madoka
with it: set the Actions variable `PUSH_RELAY_URL` in the client repository (or the environment
variable `MAHOGSM_PUSH_RELAY_URL` for a local build). Server nodes need no configuration.

- Keep `SEAL_KEY` fixed: replacing it retires every endpoint. Phones then register again within a day.
- The rate limit (60 wake-ups a minute per endpoint) uses Cloudflare's rate-limiting binding in
  `wrangler.toml`; remove that block if your account does not have it.
- The free Workers plan is enough for personal use. Each wake-up is one FCM request; the OAuth
  access token is reused for most of an hour.
- `.github/workflows/deploy.yml` deploys `main` on demand with the repository secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Your own build

Someone building their own Madoka uses their own Firebase project and deploys their own relay the same
way. Server nodes accept any `https://` push endpoint, so they work with every relay.

## Develop

```sh
npm test                                  # Node's test runner, no dependencies
npx wrangler dev                          # local workerd; put the two secrets in .dev.vars
```
