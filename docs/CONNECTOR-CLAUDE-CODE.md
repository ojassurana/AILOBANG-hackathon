# Claude Code connector — transport findings

Status: **transport proven end to end, connector not built.** Everything below was
run and observed, not inferred. Read the two blocking findings in section 4 before
planning build order.

## 1. The chain, verified

```
Claude Code (user machine)
   │  claude mcp serve            (stdio, MCP 2024-11-05)
   ▼
bridge: mcp-proxy                 (stdio  ->  Streamable HTTP, loopback only)
   │  http://127.0.0.1:<port>/mcp (MCP 2025-06-18, X-API-Key required)
   ▼
cloudflared tunnel                (outbound only, no inbound port)
   │  https://<name>.trycloudflare.com/mcp
   ▼
AI Lobang backend / voice agent
```

Each hop was proven separately and then together:

| Hop | Evidence |
| --- | --- |
| Claude Code as an MCP server | `initialize` returned `claude/tengu 2.1.252`, `tools/list` returned **25 tools** |
| stdio to HTTP bridge | same 25 tools served over Streamable HTTP at `/mcp`; request without `X-API-Key` returned **401** |
| public tunnel | from the public URL, `tools/call` ran and returned `echo:through the tunnel` and `host=<vps> user=root cwd=/tmp` |

The tunnel test used a deliberately inert two-tool MCP server rather than
`claude mcp serve`, so no Bash was ever reachable from a public URL. The tunnel
forwards the local port transparently, so the last hop is proven to carry MCP
traffic without exposing anything dangerous while testing.

## 2. The bridge we use

`mcp-proxy` (npm, v6.7.18). Chosen over `supergateway` for three specific reasons.

```sh
mcp-proxy --host 127.0.0.1 --port <port> --apiKey <secret> --stateless --server stream \
  -- claude mcp serve
```

- `--host 127.0.0.1` — **required**. `supergateway` has no host option at all: it
  binds `0.0.0.0`, which on a public box briefly exposed the port to the internet
  during testing. Do not use it for this.
- `--apiKey` — enforces `X-API-Key`. Verified 401 without it. This is the daemon's
  only access control, so it must be a real secret, not a placeholder.
- `--server stream` — Streamable HTTP only, SSE leg disabled, matching the
  "stdio to HTTP and nothing else" constraint.
- `--stateless` — simpler for a request/response voice agent. Drop it if sessions
  are needed.

`cloudflared` 2026.9.1, quick tunnel for testing:
`cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`

Quick tunnels are ephemeral and public. Production must use a **named** tunnel
with a stable hostname and its own credentials.

## 3. What `claude mcp serve` actually exposes

25 tools. The full set, because the safe subset matters:

```
Agent  TaskOutput  Bash  Read  Edit  Write  NotebookEdit  WebFetch
ReportFindings  WebSearch  TaskStop  Skill  DesignSync  EnterWorktree
ExitWorktree  SendMessage  ListAgents  CronCreate  CronDelete  CronList
ScheduleWakeup  RemoteTrigger  Monitor  PushNotification  ToolSearch
```

`claude mcp serve` accepts only `--debug` and `--verbose`. **There is no flag to
filter the tool set.** Any allowlist has to be enforced in the bridge or at the
Claude Code permission layer, not by the server.

## 4. Two blocking findings

**4a. "No bash" and the product goal are in direct conflict.**

`Bash`, `Write`, `Edit` and `NotebookEdit` are all exposed. Strip them and what
remains is `Read`, `WebSearch`, `WebFetch` plus agent-control tools. But the whole
point of the connector is "call it and say make me a website", which is writing
files. A read-only Claude Code cannot do the one thing the connector is named for.

This is a product decision, not an implementation detail. Options: accept write
tools and their blast radius; or accept that the connector is a demo; or define a
narrow allowlist and change what the voice agent promises.

**4b. The API key is the entire security boundary.**

The tunnel URL is public, and the only thing in front of a machine's Claude Code
is `X-API-Key`. A leaked key is remote code execution on that user's laptop, with
no second factor. Before this ships we need per-user keys that are revocable, and
a decision on whether a key alone is acceptable.

## 5. Blocked

The `/how-to-connect-to-claude` page and the Worker deploy need a Cloudflare
token for the account that owns `ailobang.com`. The token connected to this
environment can see only `blueghost.me`; a Cloudflare token is account-scoped, so
it cannot reach across. Nothing else in this document depends on that.

## 6. Next

1. Decide 4a and 4b.
2. Build the daemon: install, write config, start `mcp-proxy` + named tunnel,
   register the tunnel URL back to us against the user's API key.
3. Write the paste prompt and the instructions page.
4. Wire the Agents SDK harness to call the user's tunnel as an MCP client.
