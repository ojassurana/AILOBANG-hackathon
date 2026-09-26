# Telegram connector — MTProto on Workers feasibility

Status: **feasibility proven.** Serverless MTProto works with no VPS. Nothing is
built yet; this records what was verified so the next step starts from evidence.

## 1. The result

A Worker was run under `wrangler dev` (real `workerd`, not an emulator) and asked
to do two things.

```
--- test 1: raw TCP to a Telegram DC ---
raw TCP: CONNECTED and wrote 1 byte to 149.154.167.51:443

--- test 2: gramjs in workerd ---
import telegram: OK
constructor: OK
connect(): returned. connected=true
getMe() threw -> AUTH_KEY_UNREGISTERED
```

The `workerd` log for the same run:

```
[INFO] - [Running gramJS version 2.26.21]
[INFO] - [Connecting to 149.154.167.91:80/TCPFull...]
[INFO] - [Connection to 149.154.167.91:80/TCPFull complete!]
[INFO] - [Using LAYER 198 for initial connect]
```

**Why `AUTH_KEY_UNREGISTERED` is the good outcome.** It is an MTProto-level error
returned by Telegram, which means the auth-key handshake completed. The only thing
missing is a real `api_id` / `api_hash` and a phone login. A transport failure
would have looked completely different.

So: **gramjs speaks MTProto over raw TCP from inside a Worker.** No VPS, no
long-running host, no tunnel required for the Telegram leg itself.

## 2. What this rides on

- `telegram` npm package (gramjs) v2.26.22, `ConnectionTCPFull` over
  `connect()` from `cloudflare:sockets`.
- `compatibility_flags: ["nodejs_compat"]` for Buffer.
- One Durable Object holding the Telegram client **and** the MCP server. The
  client cannot cross the DO boundary, so both must live together.
- Session as a `StringSession` inside the Durable Object's own SQLite, via Drizzle.

Reference implementation: `mtourne/cf-worker-telegram-mcp`. It already contains the
complete auth flow, phone code plus optional 2FA via `InputCheckPasswordSRP`, and
100+ tools across 7 categories. It is a starting point, not a product: it uses a
single global DO and authenticates with a shared secret in the URL path.

## 3. Three changes it needs

1. **One Durable Object per user**, addressed by WorkOS user id, instead of one
   global instance. Without this there is no per-user isolation.
2. **Real auth.** Drop the `AUTH_SECRET_PATH` shared secret. The MCP endpoint
   should be reachable only by our own Worker over a service binding, so it needs
   no public URL at all.
3. **Idle disconnect.** See the cost note below, this one is not optional.

## 4. Cost, and why idle disconnect is mandatory

A Durable Object holding an outbound connection **cannot hibernate**, and
Cloudflare bills duration while a DO is active. At 128 MB with $12.50 per million
GB-s:

| Behaviour | Per user per month |
| --- | --- |
| Connected 24/7 | **~$4.15** |
| Connect on demand, ~2 min per call, 5 calls/day | **~$0.03** |

Always-on is unaffordable for a student product. The client must disconnect when
idle and reconnect on the next tool call, accepting roughly a one second connect
on the first call of a conversation.

## 5. Known caveat

**gramjs is archived.** Development continues in `teleproto`, a near drop-in fork.
The reference runs gramjs 2.26.22 and it demonstrably works, so start there and
evaluate teleproto before scaling rather than migrating speculatively.

## 6. Still true, and not fixed by any of this

A Telegram user session **is** the account. There is no read-only scope. Telegram's
own docs say accounts signing in through unofficial clients are placed under
observation, and that flooding or spam means permanent bans. Send caps and the
repeat-send guard are therefore product requirements, not polish. A send goes out
on the first request, with no spoken confirmation; a name that fits more than one
person sends nothing.

## 7. Unblocking the next step

Phase 0 needs only:

- `api_id` and `api_hash` under AI Lobang from my.telegram.org
- one test phone number to log in with

Cloudflare deployment for the real connector needs the `ailobang.com` token, still
outstanding and unrelated to the above.
