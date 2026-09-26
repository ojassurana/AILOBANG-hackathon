/**
 * The live-call widget: a small movable panel with the running transcript.
 *
 * Every signed-in page includes it. It keeps a watch-only socket open to the
 * user's voice agent, which sends it the call so far and then every transcript
 * delta, and it appears only while a call is on. The call page already shows
 * its own call, so there the widget only turns up for a phone call.
 *
 * The panel can be dragged by its header and collapsed; both are remembered in
 * localStorage, so it stays where it was put across pages.
 */

export interface CallWidgetOptions {
  /** On the call page, where a site call's transcript is already on screen. */
  phoneOnly?: boolean;
}

export function callWidget(userId: string, options: CallWidgetOptions = {}): string {
  return `    <style>
      .alb-cw {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        width: min(340px, calc(100vw - 24px));
        display: flex;
        flex-direction: column;
        max-height: min(440px, calc(100dvh - 36px));
        background: var(--card, #ffffff);
        color: var(--fg, #16161a);
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        overflow: hidden;
      }
      .alb-cw[hidden] { display: none; }
      .alb-cw-head {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 10px 10px 10px 13px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        cursor: grab;
        user-select: none;
        touch-action: none;
      }
      .alb-cw.dragging .alb-cw-head { cursor: grabbing; }
      .alb-cw.collapsed .alb-cw-head { border-bottom: 0; }
      .alb-cw-dot { width: 8px; height: 8px; border-radius: 50%; background: #1a9b52; flex: none; }
      .alb-cw-dot.live { animation: alb-cw-pulse 1.6s ease-in-out infinite; }
      .alb-cw-dot.ended { background: var(--muted, #6b6b76); animation: none; }
      @keyframes alb-cw-pulse { 50% { opacity: 0.35; } }
      .alb-cw-title { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 13.5px; }
      .alb-cw-time { color: var(--muted, #6b6b76); font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .alb-cw-btn {
        flex: none;
        width: 26px;
        height: 26px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--muted, #6b6b76);
        font: inherit;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .alb-cw-btn:hover { background: var(--border, rgba(0, 0, 0, 0.08)); color: var(--fg, #16161a); }
      .alb-cw-body { overflow-y: auto; padding: 10px 13px 12px; overscroll-behavior: contain; }
      .alb-cw.collapsed .alb-cw-body, .alb-cw.collapsed .alb-cw-note { display: none; }
      .alb-cw-line { margin: 0 0 8px; }
      .alb-cw-line:last-child { margin-bottom: 0; }
      .alb-cw-who {
        display: block;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--muted, #6b6b76);
      }
      .alb-cw-empty { margin: 0; color: var(--muted, #6b6b76); font-size: 13px; }
      .alb-cw-note {
        padding: 7px 13px;
        border-top: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        color: var(--muted, #6b6b76);
        font-size: 12.5px;
      }
      .alb-cw-note[hidden] { display: none; }
      @media (prefers-color-scheme: dark) {
        .alb-cw { background: var(--card, #141418); color: var(--fg, #f4f4f6); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
      }
    </style>
    <div class="alb-cw" id="alb-cw" role="region" aria-label="Live call transcript" hidden>
      <div class="alb-cw-head" id="alb-cw-head">
        <span class="alb-cw-dot live" id="alb-cw-dot"></span>
        <span class="alb-cw-title" id="alb-cw-title">On a phone call</span>
        <span class="alb-cw-time" id="alb-cw-time"></span>
        <button class="alb-cw-btn" id="alb-cw-toggle" type="button" aria-label="Collapse">&#8211;</button>
      </div>
      <div class="alb-cw-body" id="alb-cw-body" aria-live="polite"></div>
      <div class="alb-cw-note" id="alb-cw-note" hidden></div>
    </div>
    <script data-widget="call">
      (function () {
        var USER_ID = ${JSON.stringify(userId)};
        var PHONE_ONLY = ${options.phoneOnly ? "true" : "false"};
        var POSITION_KEY = "alb_cw_position";
        var COLLAPSED_KEY = "alb_cw_collapsed";

        var panel = document.getElementById("alb-cw");
        var head = document.getElementById("alb-cw-head");
        var body = document.getElementById("alb-cw-body");
        var dot = document.getElementById("alb-cw-dot");
        var title = document.getElementById("alb-cw-title");
        var timeEl = document.getElementById("alb-cw-time");
        var toggle = document.getElementById("alb-cw-toggle");
        var noteEl = document.getElementById("alb-cw-note");

        var channel = null;
        var lastRole = null;
        var startedAt = 0;
        var timerId = null;
        var hideId = null;
        var socket = null;
        var retryMs = 1000;

        /* -------------------------------------------------------- showing */

        function shows(which) { return which === "phone" || (which === "site" && !PHONE_ONLY); }

        function begin(which, lines) {
          if (hideId) { clearTimeout(hideId); hideId = null; }
          channel = which;
          if (!shows(which)) { panel.hidden = true; return; }
          body.textContent = "";
          lastRole = null;
          (lines || []).forEach(function (line) { append(line.role, line.text); });
          if (!body.childNodes.length) empty();
          dot.className = "alb-cw-dot live";
          title.textContent = which === "phone" ? "On a phone call" : "On a call from the site";
          startedAt = Date.now();
          tick();
          if (!timerId) timerId = setInterval(tick, 1000);
          setNote(null);
          panel.hidden = false;
          place();
        }

        function end() {
          var wasShown = !panel.hidden;
          channel = null;
          if (timerId) { clearInterval(timerId); timerId = null; }
          if (!wasShown) return;
          dot.className = "alb-cw-dot ended";
          title.textContent = "Call ended";
          setNote(null);
          hideId = setTimeout(function () { panel.hidden = true; hideId = null; }, 6000);
        }

        function tick() {
          var seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          timeEl.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        }

        function empty() {
          var p = document.createElement("p");
          p.className = "alb-cw-empty";
          p.textContent = "The transcript shows up here as you talk.";
          body.appendChild(p);
        }

        function append(role, text) {
          if (!text) return;
          var placeholder = body.querySelector(".alb-cw-empty");
          if (placeholder) placeholder.remove();
          var stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
          var last = body.lastElementChild;
          if (last && lastRole === role) {
            last.querySelector(".alb-cw-text").textContent += text;
          } else {
            var line = document.createElement("p");
            line.className = "alb-cw-line";
            var who = document.createElement("span");
            who.className = "alb-cw-who";
            who.textContent = role === "user" ? "You" : "Ailobang";
            var said = document.createElement("span");
            said.className = "alb-cw-text";
            said.textContent = text;
            line.appendChild(who);
            line.appendChild(said);
            body.appendChild(line);
            lastRole = role;
          }
          if (stick) body.scrollTop = body.scrollHeight;
        }

        function setNote(text) {
          noteEl.hidden = !text;
          noteEl.textContent = text || "";
        }

        /* --------------------------------------------------------- socket */

        function onMessage(event) {
          if (typeof event.data !== "string") return;
          var message;
          try { message = JSON.parse(event.data); } catch (e) { return; }

          if (message.type === "watch") {
            if (message.channel) begin(message.channel, message.lines);
            else if (channel) end();
          } else if (message.type === "call") {
            if (message.state === "live" && message.channel && message.channel !== channel) begin(message.channel, []);
            else if (message.state === "ended" && channel) end();
          } else if (!channel || !shows(channel)) {
            return;
          } else if (message.type === "transcript") {
            append(message.role, message.delta);
          } else if (message.type === "working") {
            setNote(message.note);
          }
        }

        function connect() {
          var protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(
            protocol + "//" + location.host + "/agents/voice-agent/" + encodeURIComponent(USER_ID) + "?watch=1",
          );
          socket.onopen = function () { retryMs = 1000; };
          socket.onmessage = onMessage;
          socket.onclose = function () {
            socket = null;
            setTimeout(connect, retryMs);
            retryMs = Math.min(retryMs * 2, 30000);
          };
        }

        // Proxies and sleeping laptops drop idle sockets without a word.
        setInterval(function () {
          if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
        }, 25000);

        /* ------------------------------------------------------- dragging */

        function clamp(value, max) { return Math.min(Math.max(8, value), Math.max(8, max)); }

        function place() {
          var saved = null;
          try { saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "null"); } catch (e) {}
          if (!saved) return;
          moveTo(saved.x, saved.y);
        }

        function moveTo(x, y) {
          var rect = panel.getBoundingClientRect();
          panel.style.left = clamp(x, window.innerWidth - rect.width - 8) + "px";
          panel.style.top = clamp(y, window.innerHeight - rect.height - 8) + "px";
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        }

        var drag = null;
        head.addEventListener("pointerdown", function (event) {
          if (event.target.closest("button")) return;
          var rect = panel.getBoundingClientRect();
          drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId };
          try { head.setPointerCapture(event.pointerId); } catch (e) {}
          panel.classList.add("dragging");
        });
        head.addEventListener("pointermove", function (event) {
          if (!drag || event.pointerId !== drag.id) return;
          moveTo(event.clientX - drag.dx, event.clientY - drag.dy);
        });
        function stopDrag(event) {
          if (!drag || event.pointerId !== drag.id) return;
          drag = null;
          panel.classList.remove("dragging");
          var rect = panel.getBoundingClientRect();
          try { localStorage.setItem(POSITION_KEY, JSON.stringify({ x: rect.left, y: rect.top })); } catch (e) {}
        }
        head.addEventListener("pointerup", stopDrag);
        head.addEventListener("pointercancel", stopDrag);
        window.addEventListener("resize", function () { if (!panel.hidden) place(); });

        /* ----------------------------------------------------- collapsing */

        function setCollapsed(value) {
          panel.classList.toggle("collapsed", value);
          toggle.innerHTML = value ? "&#9650;" : "&#8211;";
          toggle.setAttribute("aria-label", value ? "Expand" : "Collapse");
          try { localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); } catch (e) {}
          if (!panel.hidden) place();
        }
        toggle.addEventListener("click", function () { setCollapsed(!panel.classList.contains("collapsed")); });
        try { if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true); } catch (e) {}

        connect();
      })();
    </script>`;
}
