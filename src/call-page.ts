/**
 * The call page: microphone in, the assistant's voice out.
 *
 * Audio is mono PCM16 at 24 kHz in both directions, matching the audio format
 * the voice agent negotiates with GPT-Live. The browser only relays frames — all
 * reasoning, tool calls and account access happen server-side in the agent.
 */

export interface CallPageOptions {
  email: string;
  /** The caller's own id; it is also the Durable Object name the socket routes to. */
  userId: string;
}

const FRAME_SAMPLES = 480; // 20 ms at 24 kHz

export function renderCallPage({ email, userId }: CallPageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Call · Ailobang</title>
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
        --ok: #1a9b52;
        --wait: #c9861a;
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
      .shell { max-width: 720px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .stage {
        margin-top: 36px;
        padding: 36px 20px 28px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: var(--shadow);
        text-align: center;
      }
      .mic {
        width: 108px;
        height: 108px;
        border-radius: 50%;
        border: 1px solid var(--border);
        background: var(--accent);
        color: var(--accent-fg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 0.12s ease, box-shadow 0.2s ease;
        padding: 0;
      }
      .mic:hover { transform: scale(1.03); }
      .mic:active { transform: scale(0.99); }
      .mic[data-state="live"] { box-shadow: 0 0 0 8px rgba(26, 155, 82, 0.16); }
      .mic[data-state="connecting"] { opacity: 0.7; }
      .mic[disabled] { cursor: default; }
      .mic svg { width: 40px; height: 40px; }
      .status { margin: 18px 0 0; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 550; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
      .dot.ok { background: var(--ok); }
      .dot.wait { background: var(--wait); }
      .dot.bad { background: var(--bad); }
      .hint { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
      .timer { margin: 6px 0 0; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
      .note {
        margin: 20px 0 0;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 13.5px;
        background: rgba(201, 134, 26, 0.10);
        border: 1px solid rgba(201, 134, 26, 0.26);
      }
      .error {
        margin: 20px 0 0;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 13.5px;
        background: rgba(192, 57, 43, 0.10);
        border: 1px solid rgba(192, 57, 43, 0.26);
      }
      .card {
        margin-top: 24px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); }
      .card h2 { margin: 0; padding: 14px 18px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
      .actions { display: flex; gap: 6px; padding-right: 12px; }
      .action {
        appearance: none;
        font: inherit;
        font-size: 12px;
        font-weight: 550;
        padding: 5px 10px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        transition: color 0.12s ease, border-color 0.12s ease;
      }
      .action:hover { color: var(--fg); border-color: var(--fg); }
      .action[data-done="1"] { color: var(--ok); border-color: var(--ok); }
      .mute { margin-top: 16px; font-size: 13px; padding: 6px 16px; }
      .mute[aria-pressed="true"] { color: var(--bad); border-color: var(--bad); }
      .log { padding: 14px 18px 18px; max-height: 320px; overflow-y: auto; }
      .log p { margin: 0 0 10px; font-size: 14.5px; }
      .log p:last-child { margin-bottom: 0; }
      .log .label { display: block; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
      .log .you .label { color: var(--muted); }
      .empty { color: var(--muted); font-size: 14px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>Talk to your accounts</h1>
          <p class="sub">Start a call, then just ask. Everything runs on the accounts you connected.</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/app">Your accounts</a></div>
      </div>

      <div class="stage">
        <button class="mic" id="mic" data-state="idle" aria-label="Start the call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
            <path d="M19 11a7 7 0 0 1-14 0" />
            <path d="M12 18v3" />
          </svg>
        </button>
        <div><button class="action mute" id="mute" type="button" aria-pressed="false" hidden>Mute</button></div>
        <p class="status"><span class="dot" id="dot"></span><span id="status">Ready when you are</span></p>
        <p class="hint" id="hint">Press the microphone to start the call.</p>
        <p class="timer" id="timer" hidden>0:00</p>
        <p class="note" id="note" hidden></p>
        <p class="error" id="error" hidden></p>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Transcript</h2>
          <div class="actions">
            <button class="action" id="copy" type="button" hidden>Copy</button>
            <button class="action" id="download" type="button" hidden>Download</button>
          </div>
        </div>
        <div class="log" id="log"><p class="empty">Nothing yet. The conversation shows up here as you talk.</p></div>
      </div>
    </div>

    <script>
      (function () {
        var USER_ID = ${JSON.stringify(userId)};
        var SAMPLE_RATE = 24000;
        var FRAME_SAMPLES = ${FRAME_SAMPLES};
        var SPEECH_RMS = 0.02;
        var SPEECH_FRAMES_TO_INTERRUPT = 10;

        var mic = document.getElementById("mic");
        var dot = document.getElementById("dot");
        var status = document.getElementById("status");
        var hint = document.getElementById("hint");
        var timerEl = document.getElementById("timer");
        var noteEl = document.getElementById("note");
        var errorEl = document.getElementById("error");
        var logEl = document.getElementById("log");
        var copyBtn = document.getElementById("copy");
        var downloadBtn = document.getElementById("download");
        var muteBtn = document.getElementById("mute");

        var socket = null;
        var muted = false;
        var context = null;
        var stream = null;
        var source = null;
        var workletUrl = null;
        var playback = new Set();
        var playHead = 0;
        var state = "idle";
        var speechFrames = 0;
        var reconnects = 0;
        var startedAt = 0;
        var timerId = 0;
        var resampleCarry = 0;

        function setStatus(text, tone) {
          status.textContent = text;
          dot.className = "dot" + (tone ? " " + tone : "");
        }

        function setNote(text) {
          noteEl.hidden = !text;
          noteEl.textContent = text || "";
        }

        function setError(text) {
          errorEl.hidden = !text;
          errorEl.textContent = text || "";
        }

        function appendLine(role, text) {
          var empty = logEl.querySelector(".empty");
          if (empty) empty.remove();

          var last = logEl.lastElementChild;
          if (last && last.getAttribute("data-role") === role) {
            last.querySelector(".text").textContent += text;
          } else {
            var p = document.createElement("p");
            p.className = role;
            p.setAttribute("data-role", role);
            var label = document.createElement("span");
            label.className = "label";
            label.textContent = role === "user" ? "You" : "Assistant";
            var body = document.createElement("span");
            body.className = "text";
            body.textContent = text;
            p.appendChild(label);
            p.appendChild(body);
            logEl.appendChild(p);
          }
          copyBtn.hidden = false;
          downloadBtn.hidden = false;
          logEl.scrollTop = logEl.scrollHeight;
        }

        /* -------------------------------------------------------- transcript */

        function transcriptText() {
          var lines = [];
          var nodes = logEl.querySelectorAll("p[data-role]");
          for (var i = 0; i < nodes.length; i++) {
            var label = nodes[i].getAttribute("data-role") === "user" ? "You" : "Assistant";
            lines.push(label + ": " + nodes[i].querySelector(".text").textContent.trim());
          }
          return lines.join("\\n\\n");
        }

        /** The clipboard API needs a secure context and a granted permission. */
        function legacyCopy(text) {
          var area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.top = "-1000px";
          document.body.appendChild(area);
          area.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
          area.remove();
          return ok;
        }

        var flashTimers = new WeakMap();

        function flash(button, label, tone) {
          var restore = button.textContent;
          button.textContent = label;
          button.dataset.done = tone || "";
          clearTimeout(flashTimers.get(button));
          flashTimers.set(button, setTimeout(function () {
            button.textContent = restore;
            button.dataset.done = "";
          }, 1600));
        }

        async function copyTranscript() {
          var text = transcriptText();
          if (!text) return;
          var ok = false;
          try { await navigator.clipboard.writeText(text); ok = true; }
          catch (e) { ok = legacyCopy(text); }
          flash(copyBtn, ok ? "Copied" : "Copy failed", ok ? "1" : "");
        }

        function downloadTranscript() {
          var text = transcriptText();
          if (!text) return;
          var stamp = new Date().toISOString().slice(0, 10);
          var blob = new Blob([text + "\\n"], { type: "text/plain;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = "ailobang-transcript-" + stamp + ".txt";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        }

        function startTimer() {
          startedAt = Date.now();
          timerEl.hidden = false;
          timerId = setInterval(function () {
            var seconds = Math.floor((Date.now() - startedAt) / 1000);
            timerEl.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
          }, 1000);
        }

        function stopTimer() {
          clearInterval(timerId);
          timerId = 0;
        }

        /* ------------------------------------------------------------ capture */

        var WORKLET = [
          "class Capture extends AudioWorkletProcessor {",
          "  constructor() {",
          "    super();",
          "    this.frame = new Float32Array(" + FRAME_SAMPLES + ");",
          "    this.count = 0;",
          "  }",
          "  process(inputs) {",
          "    var channel = inputs[0] && inputs[0][0];",
          "    if (!channel) return true;",
          "    for (var i = 0; i < channel.length; i++) {",
          "      this.frame[this.count++] = channel[i];",
          "      if (this.count === this.frame.length) {",
          "        this.port.postMessage(this.frame);",
          "        this.frame = new Float32Array(" + FRAME_SAMPLES + ");",
          "        this.count = 0;",
          "      }",
          "    }",
          "    return true;",
          "  }",
          "}",
          "registerProcessor('capture', Capture);",
        ].join("\\n");

        /** The worklet normally runs at the format's own rate; this covers the rest. */
        function to24k(frame) {
          if (context.sampleRate === SAMPLE_RATE) return frame;

          var ratio = context.sampleRate / SAMPLE_RATE;
          var count = Math.floor((frame.length - resampleCarry) / ratio);
          var out = new Float32Array(count);
          for (var i = 0; i < count; i++) {
            out[i] = frame[Math.min(frame.length - 1, Math.round(i * ratio + resampleCarry))];
          }
          resampleCarry = Math.max(0, resampleCarry + count * ratio - frame.length);
          return out;
        }

        function sendFrame(frame) {
          if (state !== "live" || !socket || socket.readyState !== 1) return;

          var samples = to24k(frame);
          var buffer = new ArrayBuffer(samples.length * 2);
          var view = new DataView(buffer);
          var sum = 0;
          // Muted frames still go out as silence so the line stays open and the
          // assistant keeps talking instead of waiting on a gap.
          for (var i = 0; i < samples.length; i++) {
            var sample = muted ? 0 : Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            sum += sample * sample;
          }
          socket.send(buffer);

          // The assistant stops generating on its own when it hears the caller;
          // this drops whatever is already queued locally so it stops here too.
          var rms = Math.sqrt(sum / samples.length);
          if (rms > SPEECH_RMS && playback.size) {
            if (++speechFrames >= SPEECH_FRAMES_TO_INTERRUPT) {
              speechFrames = 0;
              flushPlayback();
            }
          } else {
            speechFrames = 0;
          }
        }

        /* ----------------------------------------------------------- playback */

        function play(buffer) {
          if (!context) return;

          var view = new DataView(buffer);
          var samples = new Float32Array(buffer.byteLength >> 1);
          for (var i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;

          var audio = context.createBuffer(1, samples.length, SAMPLE_RATE);
          audio.copyToChannel(samples, 0);

          var node = context.createBufferSource();
          node.buffer = audio;
          node.connect(context.destination);

          var at = Math.max(playHead, context.currentTime + 0.05);
          node.start(at);
          playHead = at + audio.duration;
          playback.add(node);
          node.onended = function () { playback.delete(node); };
        }

        function flushPlayback() {
          playback.forEach(function (node) { try { node.stop(); } catch (e) {} });
          playback.clear();
          playHead = 0;
        }

        /* ------------------------------------------------------------ session */

        function onMessage(event) {
          if (typeof event.data !== "string") {
            play(event.data);
            return;
          }

          var message;
          try { message = JSON.parse(event.data); } catch (e) { return; }

          if (message.type === "call") {
            if (message.state === "live") {
              state = "live";
              reconnects = 0;
              // The button is disabled while starting; give it back so the same
              // press can end the call.
              mic.disabled = false;
              mic.dataset.state = "live";
              mic.setAttribute("aria-label", "End the call");
              setStatus(muted ? "Live · muted" : "Live", "ok");
              hint.textContent = "Just talk. Press the microphone again to end the call.";
              muteBtn.hidden = false;
              if (!timerId) startTimer();
            } else if (message.state === "ended") {
              // The agent says why it ended, which is worth showing rather than
              // swallowing behind a generic message.
              finish(message.reason ? "Call ended: " + message.reason : "Call ended", message.seconds);
            } else {
              mic.dataset.state = "connecting";
              setStatus("Connecting", "wait");
            }
          } else if (message.type === "transcript") {
            appendLine(message.role, message.delta);
          } else if (message.type === "working") {
            setNote(message.note);
          } else if (message.type === "error") {
            setError(message.message);
            // A call that fails before it goes live would otherwise leave the
            // button disabled and the page stuck with no way to retry.
            if (state !== "live") finish("Call failed");
          }
        }

        function finish(label, seconds) {
          if (state === "ended") return;
          state = "ended";
          stopTimer();
          flushPlayback();
          teardown();
          mic.disabled = false;
          mic.dataset.state = "idle";
          mic.setAttribute("aria-label", "Start the call");
          setStatus(label, seconds ? "ok" : undefined);
          hint.textContent = "Press the microphone to start another call.";
          setNote(null);
          setMuted(false);
          muteBtn.hidden = true;
        }

        function setMuted(value) {
          muted = value;
          speechFrames = 0;
          muteBtn.textContent = muted ? "Unmute" : "Mute";
          muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
          if (state === "live") setStatus(muted ? "Live · muted" : "Live", "ok");
        }

        function teardown() {
          if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = null; }
          if (source) { try { source.disconnect(); } catch (e) {} source = null; }
          if (stream) { stream.getTracks().forEach(function (track) { track.stop(); }); stream = null; }
          if (context) { try { context.close(); } catch (e) {} context = null; }
          if (socket && socket.readyState === 1) socket.close();
          socket = null;
        }

        async function start() {
          setError(null);
          setNote(null);
          state = "starting";
          mic.disabled = true;
          setStatus("Connecting", "wait");
          hint.textContent = "Allow microphone access if your browser asks.";

          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            });
          } catch (e) {
            state = "idle";
            mic.disabled = false;
            setStatus("Microphone blocked", "bad");
            setError("This call needs microphone access. Allow it in your browser, then try again.");
            return;
          }

          context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
          if (context.state === "suspended") await context.resume();

          workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
          await context.audioWorklet.addModule(workletUrl);

          var capture = new AudioWorkletNode(context, "capture");
          capture.port.onmessage = function (event) { sendFrame(event.data); };
          source = context.createMediaStreamSource(stream);
          source.connect(capture);

          connectSocket();
        }

        /** The agent keeps a call alive for a minute, so a dropped socket resumes it. */
        function connectSocket() {
          var protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(protocol + "//" + location.host + "/agents/voice-agent/" + encodeURIComponent(USER_ID));
          socket.binaryType = "arraybuffer";
          socket.onmessage = onMessage;
          socket.onerror = function () { setError("The call connection dropped."); };
          socket.onclose = function () {
            if (state === "ended" || state === "idle") return;
            if (reconnects < 3) {
              reconnects += 1;
              setStatus("Reconnecting", "wait");
              setTimeout(connectSocket, 1500);
              return;
            }
            finish("Call ended");
          };
        }

        function hangUp() {
          if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "hangup" }));
          finish("Call ended");
        }

        mic.addEventListener("click", function () {
          if (state === "live") hangUp();
          else if (state === "idle" || state === "ended") start();
        });

        muteBtn.addEventListener("click", function () { setMuted(!muted); });
        copyBtn.addEventListener("click", copyTranscript);
        downloadBtn.addEventListener("click", downloadTranscript);

        // A hidden tab must not end the call. Ending it on pagehide made a tab
        // switch or a backgrounded browser look like a dropped call, and the
        // browser suspends audio for background pages, so resume the context
        // rather than losing the microphone.
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden && context && context.state === "suspended") context.resume();
        });

        // Keeps the socket busy so nothing can mistake a quiet line for a dead one.
        setInterval(function () {
          if (state !== "live") return;
          if (context && context.state === "suspended") context.resume();
          if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
        }, 10000);
      })();
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
