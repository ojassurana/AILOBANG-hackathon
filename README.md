**[ailobang.com](https://ailobang.com)**

# AI Lobang

**Every tool you own, one phone call away.**

`plan.ailobang.com`

---

## The name

**lobang** *(noun, Singlish)* — a connection, a hook-up, a good opportunity.
"Got lobang or not?"

AI Lobang is that, for your AI: the connection between a voice agent and every
tool you already use. You don't open a dashboard, you don't write a prompt in a
chat box, you don't wire up an MCP server. You **call a number** and just talk.

## What it is

A cloud-native service where you:

1. **Log in** — email + password.
2. **See a shelf of connectors** — Gmail first, more later.
3. **Connect one** — OAuth handled by Composio, no keys to paste, ever.
4. **Get a phone number** — a real Telnyx inbound number that belongs to you.
5. **Call it** — GPT-Live 1 (speech-to-speech) picks up and talks like a person.
6. **It acts** — the voice agent calls out through Composio and does the thing:
   reads your inbox, drafts a reply, archives a thread, finds that invoice.

The call is the UI. The connectors are the hands. The number is the door.

## The vibe

Not a chatbot. Not a copilot sidebar. Not another dashboard you'll open twice.

It's a **switchboard**: you call it, it patches you through to your own stuff.
The phone number is the killer detail — a phone number is zero-friction. It
lives in your contacts, it works from a lift with bad wifi, you can call it
from a hotel landline, your parents could use it. Nobody has to learn a new app.

Around that sit the boring-but-essential bits: accounts, sessions, connector
states, call logs — all in D1, all on Cloudflare, nothing self-hosted.

## The loop

```
you ──call──▶ +1 (407) 358-0773 ──▶ Telnyx ──▶ voice bridge (Worker)
                                                    │
                                        GPT-Live 1 (speech-to-speech)
                                                    │  tool calls
                                                    ▼
                                          Composio ──▶ Gmail / GCal / …
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Edge / app | Cloudflare Workers | One deploy, global, no servers |
| Database | Cloudflare D1 (SQL) | Users, sessions, connectors, accounts, call log |
| Connectors | Composio | Managed OAuth for every toolkit; one connected account per user |
| Telephony | Telnyx | Inbound numbers + media streaming |
| Voice agent | OpenAI GPT-Live 1 | Speech-to-speech, tool calling, no STT→LLM→TTS relay |
| Auth | Email + password | PBKDF2/WebCrypto hash, HttpOnly session cookie |

## Status

Concept + plan. Repo created, plan page live at **plan.ailobang.com**.
First build target: email/password auth → Gmail connector → one number that
answers and can read/send mail.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model and flows,
and [`docs/PLAN.md`](docs/PLAN.md) for the build order.
