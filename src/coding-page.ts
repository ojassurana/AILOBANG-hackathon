/**
 * Text coding chat page. Talks to CodingAgent over the Agents SDK chat wire,
 * not the voice control channel.
 */

export interface CodingPageOptions {
  email: string;
  userId: string;
}

export function renderCodingPage({ email, userId }: CodingPageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Coding chat · Ailobang</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #fbfbfd;
        --fg: #16161a;
        --muted: #6b6b76;
        --card: #ffffff;
        --accent: #16161a;
        --accent-fg: #ffffff;
        --border: rgba(0, 0, 0, 0.10);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.05);
        --bad: #c0392b;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d0d10;
          --fg: #f4f4f6;
          --muted: #9a9aa5;
          --card: #141418;
          --accent: #f4f4f6;
          --accent-fg: #16161a;
          --border: rgba(255, 255, 255, 0.12);
          --shadow: none;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .shell { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .log {
        margin-top: 28px;
        min-height: 280px;
        padding: 16px 18px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
      }
      .line { margin: 0 0 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .line .role { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
      .line.assistant .body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13.5px; }
      .empty { color: var(--muted); }
      form {
        display: flex; gap: 8px; margin-top: 14px;
      }
      textarea {
        flex: 1 1 auto; min-height: 72px; resize: vertical;
        padding: 10px 12px; border-radius: 12px;
        border: 1px solid var(--border); background: var(--card); color: var(--fg);
        font: inherit;
      }
      button {
        flex: none; align-self: flex-end;
        padding: 10px 16px; border: 0; border-radius: 10px;
        background: var(--accent); color: var(--accent-fg);
        font: inherit; font-weight: 600; cursor: pointer;
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .row { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
      .ghost {
        background: transparent; color: var(--fg); border: 1px solid var(--border);
        padding: 6px 10px; font-size: 13px; font-weight: 550;
      }
      .err { color: var(--bad); font-size: 13px; min-height: 1.2em; }
      .status { color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>Coding chat</h1>
          <p class="sub">Text chat for code, on the same connected accounts as the call.</p>
        </div>
        <div class="who">${escapeHtml(email)}<br />
          <a href="/call">Voice call</a> · <a href="/app">Accounts</a>
        </div>
      </div>
      <div class="log" id="log"><p class="empty">Ask for a snippet, a review, or a fix.</p></div>
      <form id="form">
        <textarea id="input" rows="3" placeholder="Paste code or ask…" required></textarea>
        <button type="submit" id="send">Send</button>
      </form>
      <div class="row">
        <span class="status" id="status">Connecting…</span>
        <button class="ghost" type="button" id="clear">Clear chat</button>
      </div>
      <p class="err" id="error"></p>
    </div>
    <script>
      (function () {
        var USER_ID = ${JSON.stringify(userId)};
        var logEl = document.getElementById("log");
        var form = document.getElementById("form");
        var input = document.getElementById("input");
        var sendBtn = document.getElementById("send");
        var statusEl = document.getElementById("status");
        var errorEl = document.getElementById("error");
        var messages = [];
        var socket = null;
        var busy = false;
        var draft = "";

        function setStatus(text) { statusEl.textContent = text; }
        function setError(text) { errorEl.textContent = text || ""; }
        function setBusy(value) {
          busy = value;
          sendBtn.disabled = value || !socket || socket.readyState !== 1;
        }

        function textOf(msg) {
          var parts = msg.parts || [];
          var out = [];
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].type === "text" && parts[i].text) out.push(parts[i].text);
          }
          return out.join("");
        }

        function render() {
          if (!messages.length && !draft) {
            logEl.innerHTML = '<p class="empty">Ask for a snippet, a review, or a fix.</p>';
            return;
          }
          var html = "";
          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            var body = textOf(msg);
            if (!body) continue;
            html += '<div class="line ' + msg.role + '"><span class="role">' +
              (msg.role === "user" ? "You" : "Coding chat") +
              '</span><div class="body"></div></div>';
          }
          logEl.innerHTML = html;
          var bodies = logEl.querySelectorAll(".line .body");
          var n = 0;
          for (var j = 0; j < messages.length; j++) {
            var t = textOf(messages[j]);
            if (!t) continue;
            bodies[n].textContent = t;
            n++;
          }
          if (draft) {
            var extra = document.createElement("div");
            extra.className = "line assistant";
            extra.innerHTML = '<span class="role">Coding chat</span><div class="body"></div>';
            extra.querySelector(".body").textContent = draft;
            logEl.appendChild(extra);
          }
          logEl.scrollTop = logEl.scrollHeight;
        }

        function applyChunk(chunk) {
          if (!chunk || typeof chunk !== "object") return;
          var t = chunk.type;
          if (t === "text-delta" || t === "text") {
            draft += chunk.delta || chunk.text || "";
            render();
          } else if (t === "error") {
            setError(chunk.errorText || chunk.error || "The model failed.");
          }
        }

        function connect() {
          var protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(
            protocol + "//" + location.host + "/agents/coding-agent/" + encodeURIComponent(USER_ID)
          );
          socket.onopen = function () {
            setStatus("Connected");
            setError("");
            setBusy(false);
            fetch("/agents/coding-agent/" + encodeURIComponent(USER_ID) + "/get-messages", {
              credentials: "same-origin"
            }).then(function (res) { return res.ok ? res.json() : []; })
              .then(function (list) {
                if (Array.isArray(list)) { messages = list; render(); }
              }).catch(function () {});
          };
          socket.onclose = function () {
            setStatus("Disconnected — retrying");
            setBusy(true);
            setTimeout(connect, 1200);
          };
          socket.onerror = function () { setError("Socket error"); };
          socket.onmessage = function (event) {
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (msg.type === "cf_agent_chat_messages" && Array.isArray(msg.messages)) {
              messages = msg.messages;
              draft = "";
              setBusy(false);
              render();
            } else if (msg.type === "cf_agent_use_chat_response") {
              if (msg.error) setError(msg.body || "Request failed");
              if (msg.body) {
                try { applyChunk(JSON.parse(msg.body)); } catch (e) {}
              }
              if (msg.done) {
                draft = "";
                setBusy(false);
              }
            } else if (msg.type === "cf_agent_chat_clear") {
              messages = [];
              draft = "";
              render();
            }
          };
        }

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var text = input.value.trim();
          if (!text || !socket || socket.readyState !== 1 || busy) return;
          var userMsg = {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: text }]
          };
          messages = messages.concat([userMsg]);
          input.value = "";
          draft = "";
          setBusy(true);
          setError("");
          render();
          socket.send(JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: crypto.randomUUID().slice(0, 8),
            init: {
              method: "POST",
              body: JSON.stringify({ messages: messages })
            }
          }));
        });

        document.getElementById("clear").addEventListener("click", function () {
          if (!socket || socket.readyState !== 1) return;
          socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
          messages = [];
          draft = "";
          render();
        });

        connect();
      })();
    </script>
  </body>
</html>`;
}

/** Chat box for the connectors page — same CodingAgent socket as /code. */
export function codingChatEmbed(userId: string): string {
  return `
      <div class="cc-box">
        <div class="cc-head">
          <strong>Chat with your accounts</strong>
          <span class="status" id="status">Connecting…</span>
        </div>
        <div class="log" id="log"><p class="empty">Ask anything — mail, docs, code, Telegram. Same connectors as the call.</p></div>
        <form id="form">
          <textarea id="input" rows="3" placeholder="Ask or paste code…" required></textarea>
          <button type="submit" id="send">Send</button>
        </form>
        <div class="row">
          <p class="err" id="error"></p>
          <button class="ghost" type="button" id="clear">Clear</button>
        </div>
      </div>
      <script>
      (function () {
        var USER_ID = ${JSON.stringify(userId)};
        var logEl = document.getElementById("log");
        var form = document.getElementById("form");
        var input = document.getElementById("input");
        var sendBtn = document.getElementById("send");
        var statusEl = document.getElementById("status");
        var errorEl = document.getElementById("error");
        var messages = [];
        var socket = null;
        var busy = false;
        var draft = "";
        function setStatus(text) { statusEl.textContent = text; }
        function setError(text) { errorEl.textContent = text || ""; }
        function setBusy(value) {
          busy = value;
          sendBtn.disabled = value || !socket || socket.readyState !== 1;
        }
        function textOf(msg) {
          var parts = msg.parts || [];
          var out = [];
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].type === "text" && parts[i].text) out.push(parts[i].text);
          }
          return out.join("");
        }
        function render() {
          if (!messages.length && !draft) {
            logEl.innerHTML = '<p class="empty">Ask anything — mail, docs, code, Telegram. Same connectors as the call.</p>';
            return;
          }
          var html = "";
          for (var i = 0; i < messages.length; i++) {
            var body = textOf(messages[i]);
            if (!body) continue;
            html += '<div class="line ' + messages[i].role + '"><span class="role">' +
              (messages[i].role === "user" ? "You" : "Ailobang") +
              '</span><div class="body"></div></div>';
          }
          logEl.innerHTML = html;
          var bodies = logEl.querySelectorAll(".line .body");
          var n = 0;
          for (var j = 0; j < messages.length; j++) {
            var t = textOf(messages[j]);
            if (!t) continue;
            bodies[n].textContent = t;
            n++;
          }
          if (draft) {
            var extra = document.createElement("div");
            extra.className = "line assistant";
            extra.innerHTML = '<span class="role">Ailobang</span><div class="body"></div>';
            extra.querySelector(".body").textContent = draft;
            logEl.appendChild(extra);
          }
          logEl.scrollTop = logEl.scrollHeight;
        }
        function applyChunk(chunk) {
          if (!chunk || typeof chunk !== "object") return;
          var t = chunk.type;
          if (t === "text-delta" || t === "text") {
            draft += chunk.delta || chunk.text || "";
            render();
          } else if (t === "error") {
            setError(chunk.errorText || chunk.error || "The model failed.");
          }
        }
        function connect() {
          var protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(protocol + "//" + location.host + "/agents/coding-agent/" + encodeURIComponent(USER_ID));
          socket.onopen = function () {
            setStatus("Connected");
            setError("");
            setBusy(false);
            fetch("/agents/coding-agent/" + encodeURIComponent(USER_ID) + "/get-messages", { credentials: "same-origin" })
              .then(function (res) { return res.ok ? res.json() : []; })
              .then(function (list) { if (Array.isArray(list)) { messages = list; render(); } })
              .catch(function () {});
          };
          socket.onclose = function () {
            setStatus("Disconnected — retrying");
            setBusy(true);
            setTimeout(connect, 1200);
          };
          socket.onerror = function () { setError("Socket error"); };
          socket.onmessage = function (event) {
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (msg.type === "cf_agent_chat_messages" && Array.isArray(msg.messages)) {
              messages = msg.messages; draft = ""; setBusy(false); render();
            } else if (msg.type === "cf_agent_use_chat_response") {
              if (msg.error) setError(msg.body || "Request failed");
              if (msg.body) {
                try { applyChunk(JSON.parse(msg.body)); } catch (e) {
                  draft += String(msg.body); render();
                }
              }
              if (msg.done) { draft = ""; setBusy(false); }
            } else if (msg.type === "cf_agent_chat_clear") {
              messages = []; draft = ""; render();
            }
          };
        }
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var text = input.value.trim();
          if (!text || !socket || socket.readyState !== 1 || busy) return;
          messages = messages.concat([{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: text }] }]);
          input.value = ""; draft = ""; setBusy(true); setError(""); render();
          socket.send(JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: crypto.randomUUID().slice(0, 8),
            init: { method: "POST", body: JSON.stringify({ messages: messages }) }
          }));
        });
        document.getElementById("clear").addEventListener("click", function () {
          if (!socket || socket.readyState !== 1) return;
          socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
          messages = []; draft = ""; render();
        });
        connect();
      })();
      </script>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
