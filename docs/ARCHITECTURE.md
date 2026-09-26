# AI Lobang — Architecture

## 1. Shape

```
                        ┌──────────────────────────────────────────┐
   browser ──────────▶  │  Worker: app  (ailobang.com / app.*)     │
                        │  • HTML/JS shell, auth pages             │
                        │  • /api/*  JSON API                      │
                        └───────────────┬──────────────────────────┘
                                        │
                        ┌───────────────▼──────────────────────────┐
                        │  D1 (SQL)                                │
                        │  users · sessions · connectors           │
                        │  connected_accounts · numbers · calls    │
                        └──────────────────────────────────────────┘

   PSTN caller ──▶ Telnyx number ──▶ Worker: voice bridge ──▶ GPT-Live 1
                                     (WebSocket media)              │
                                                                    │ tool calls
                        ┌───────────────────────────────────────────▼──┐
                        │  Worker: agent tools                          │
                        │  → Composio (per-user connected account)      │
                        │  → Gmail / Calendar / Drive / …               │
                        └───────────────────────────────────────────────┘
```

Three Workers, one D1. All state server-side; the browser holds a session cookie
and nothing else.

## 2. Data model (D1)

```sql
users               id, email UNIQUE, password_hash, salt, created_at, status
sessions            token_hash, user_id, created_at, expires_at, user_agent, ip
connectors          id, slug, name, toolkit            -- catalogue: 'gmail', …
connected_accounts  id, user_id, connector_id, provider_account_id,
                    display_label, status, created_at
                    -- one row per user × connector
numbers             id, user_id, ean, provider='telnyx', status, label
calls               id, user_id, number_id, direction, from_ean, started_at,
                    ended_at, duration_s, transcript_r2_key, outcome
call_actions        id, call_id, seq, tool, args_json, result_json, ok, error
```

Volatile transcripts live in R2; D1 keeps pointers + a structured action log so
"what did my agent do on Tuesday" is a SQL query.

## 3. Auth

- Email + password. `PBKDF2-SHA256`, ≥100k iterations, per-user salt (WebCrypto
  in the Worker — no native deps).
- Session = random 32-byte token; only its SHA-256 hash is stored. HttpOnly,
  Secure, SameSite=Lax cookie.
- Rate-limit login attempts per email + per IP in KV.
- No passwords in logs, ever. No magic links needed for v1.

## 4. Connectors (Composio)

Composio is the whole point: it holds the OAuth apps so AI Lobang never touches
a client secret or a refresh token.

Per toolkit (Gmail first):

1. One **auth config** in the AI Lobang Composio project (`auth_config_id`).
2. User clicks *Connect* → we create a **connected account** for that user and
   redirect them to Composio's hosted OAuth page.
3. Composio redirects back with `connected_account_id` → we store it against
   `connected_accounts.user_id`.
4. At call time, tool calls are executed with that `connected_account_id`, so
   the agent only ever acts as the person who is on the phone.

Endpoint envs (dev/prod) stay separate. Nothing is stored that we can't revoke.

## 5. Telephony + voice

- **Telnyx** inbound number per user (or per workspace, sharing a number pool
  first). Inbound leg → Telnyx Call Control → media stream over WebSocket to the
  voice bridge Worker.
- **GPT-Live 1** does speech-to-speech: no STT→LLM→TTS chain, so interruptions
  and backchannel work like a real call. We open a session per call, pass the
  user's context (who they are, which connectors are live) in `instructions`,
  and expose our tools through the delegation/tool-call surface.
- Tool calls come back to the Worker, which:
  1. checks the caller's identity (which number was dialled → which user),
  2. whitelists the tool,
  3. executes it against Composio,
  4. writes a `call_actions` row,
  5. hands the result back to the live session.
- Every call gets a transcript in R2 and a row in `calls`.

Existing pattern to reuse: this box already runs a Telnyx ↔ GPT-Live bridge for
inbound voice (`~/openai-realtime-sip`, `/texml/inbound`), so the media plumbing
is proven — AI Lobang just needs per-user routing on top.

## 6. Tool surface (v1, Gmail)

| Tool | Intent |
|---|---|
| `gmail.search` | "find the invoice from Zomato" |
| `gmail.list_unread` | "what's unread" |
| `gmail.read_thread` | "read me that thread" |
| `gmail.create_draft` | "draft a reply saying I'll be late" |
| `gmail.send` | "send it" (confirm-first) |
| `gmail.archive` / `gmail.label` | "clear out the newsletters" |

Rules baked into the agent prompt:

- **Destructive = confirm out loud first.** Sending, deleting, archiving a
  thread: the agent says what it's about to do and waits for a yes.
- **Never read a different account than the caller's.**
- **Say when it can't.** No inventing mail it didn't fetch.

## 7. Open questions

- One number per user, or one shared number with caller-ID → account mapping?
  (Shared is cheap, per-user is cleaner.)
- Do we do outbound too ("call me when X arrives")? Presumably yes later.
- Voice-only, or does the number also do SMS/WhatsApp?
- Billing: per number, per call minute, or per connected account?
