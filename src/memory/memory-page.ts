/**
 * The memory page: what the assistant remembers about you, and how it got there.
 *
 * The tree on the left is the folder structure the agent has built in Atlas;
 * the log on the right is every Jev decision and every write, newest first.
 * It polls /memory.json, so a call on another tab shows up here as it lands.
 */

import type { MemoryEvent, MemoryNode } from "./repo";

export interface MemoryPageOptions {
  email: string;
  connected: boolean;
  error?: string | null;
}

export function renderMemoryPage({ email, connected, error }: MemoryPageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Memory · Ailobang</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #fbfbfd; --fg: #16161a; --muted: #6b6b76; --card: #ffffff;
        --border: rgba(0, 0, 0, 0.10); --shadow: 0 1px 2px rgba(0,0,0,.05), 0 10px 30px rgba(0,0,0,.05);
        --ok: #1a9b52; --wait: #c9861a; --bad: #c0392b; --accent: #4f46e5;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #0d0d10; --fg: #f4f4f6; --muted: #9a9aa5; --card: #141418; --border: rgba(255,255,255,.12); --shadow: none; --accent: #8b83ff; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .shell { max-width: 1100px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; margin-top: 28px; }
      @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
      .card { padding: 20px 22px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); }
      h2 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 10px; }
      .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--muted); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
      .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
      .lede { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
      .tree { font-size: 14px; }
      .root { margin: 14px 0 6px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: 12px; color: var(--muted); }
      .node { padding: 4px 0 4px calc(var(--depth) * 18px); display: flex; gap: 8px; align-items: baseline; }
      .node .name { font-weight: 600; }
      .node.folder .name::before { content: "▸ "; color: var(--muted); }
      .node.skill .name::before { content: "• "; color: var(--accent); }
      .node .summary { color: var(--muted); font-size: 13px; }
      .node .content { display: block; margin: 2px 0 2px 16px; color: var(--fg); font-size: 13.5px; white-space: pre-wrap; }
      .node .meta { color: var(--muted); font-size: 12px; margin-left: 16px; }
      .code { margin: 6px 0 4px 16px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; max-height: 200px; overflow: auto; }
      .empty { color: var(--muted); font-size: 14px; padding: 8px 0; }
      .log { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
      .log li { padding: 9px 0; border-top: 1px solid var(--border); }
      .log li:first-child { border-top: 0; }
      .log .when { color: var(--muted); font-size: 12px; }
      .log .op { font-weight: 700; margin-right: 6px; }
      .op.route { color: var(--accent); } .op.upsert { color: var(--ok); } .op.delete { color: var(--bad); } .op.recall { color: var(--wait); }
      .bar { display: inline-block; height: 6px; width: 90px; background: var(--border); border-radius: 3px; vertical-align: middle; margin: 0 6px; overflow: hidden; }
      .bar i { display: block; height: 100%; background: var(--accent); }
      .path { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .note { margin: 18px 0 0; padding: 11px 13px; border-radius: 11px; font-size: 13.5px; background: rgba(192,57,43,.10); border: 1px solid rgba(192,57,43,.26); }
      .stack { margin-top: 10px; color: var(--muted); font-size: 12.5px; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>Memory</h1>
          <p class="sub">What Ailobang has learned about you, as the folder tree the agent built. Jev routes every read and write; MongoDB Atlas holds it.</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/app">Your accounts</a> · <a href="/call">Call</a></div>
      </div>
      ${error ? `<p class="note">${escapeHtml(error)}</p>` : ""}
      <div class="grid">
        <section class="card">
          <h2>The tree <span class="pill"><span class="dot ${connected ? "ok" : "bad"}"></span>${connected ? "Atlas connected" : "Atlas unreachable"}</span></h2>
          <p class="lede">Two roots are fixed. Every folder and skill under them was created, merged or removed by the agent.</p>
          <div id="tree" class="tree"><div class="empty">Loading…</div></div>
          <p class="stack">Collections: <span class="path">ailobang.memory_nodes</span>, <span class="path">memory_events</span>, <span class="path">calls</span>. Vector index <span class="path">memory_vector</span> auto-embeds with voyage-4-lite.</p>
        </section>
        <section class="card">
          <h2>Decisions <span class="pill" id="count"></span></h2>
          <p class="lede">Newest first. A route is Jev choosing none, personal, workflow or both, with its confidence; a write only follows a route above 50%.</p>
          <ul id="log" class="log"><li class="empty">Loading…</li></ul>
        </section>
      </div>
    </div>
    <script>
      const treeEl = document.getElementById("tree");
      const logEl = document.getElementById("log");
      const countEl = document.getElementById("count");
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      function renderTree(nodes) {
        if (!nodes.length) {
          treeEl.innerHTML = '<div class="empty">Nothing yet. Have a call: memory is built from what you say and what the assistant does.</div>';
          return;
        }
        const byRoot = { personal: [], workflow: [] };
        for (const n of nodes) (byRoot[n.branch] ||= []).push(n);
        let html = "";
        for (const root of ["personal", "workflow"]) {
          html += '<div class="root">' + root + "/</div>";
          const list = byRoot[root].sort((a, b) => a.path.localeCompare(b.path));
          if (!list.length) html += '<div class="empty">empty</div>';
          for (const n of list) {
            const depth = n.path.split("/").length - 2;
            html += '<div class="node ' + n.kind + '" style="--depth:' + depth + '"><div><span class="name">' + esc(n.title) + "</span>";
            if (n.summary) html += ' <span class="summary">' + esc(n.summary) + "</span>";
            if (n.kind === "skill") {
              html += '<span class="content">' + esc(n.content) + "</span>";
              const meta = [];
              if (n.tools && n.tools.length) meta.push("tools: " + n.tools.join(", "));
              if (n.inputs && n.inputs.length) meta.push("inputs: " + n.inputs.join(", "));
              meta.push("v" + n.version + (n.uses ? ", recalled " + n.uses + "×" : ""));
              html += '<span class="meta">' + esc(meta.join(" · ")) + "</span>";
              if (n.code) html += '<pre class="code">' + esc(n.code) + "</pre>";
            }
            html += "</div></div>";
          }
        }
        treeEl.innerHTML = html;
      }

      function describe(e) {
        const d = e.detail || {};
        if (e.op === "route") {
          const c = Math.round((d.confidence || 0) * 100);
          return "Jev routed <b>" + esc(d.route) + "</b> from " + esc(e.source) + '<span class="bar"><i style="width:' + c + '%"></i></span>' + c + "%";
        }
        if (e.op === "recall") {
          return "Jev read for “" + esc(d.request) + "”: " + esc(d.route) + " → " + (d.found && d.found.length ? d.found.map((p) => '<span class="path">' + esc(p) + "</span>").join(", ") : "nothing");
        }
        if (e.op === "upsert") {
          return (d.created ? "Created " : "Updated ") + '<span class="path">' + esc(e.path) + "</span>" + (d.mergedInto ? " (merged from " + esc(d.proposedPath) + ")" : "") + (d.reason ? " — " + esc(d.reason) : "");
        }
        if (e.op === "delete") return "Removed " + (d.removed || [e.path]).map((p) => '<span class="path">' + esc(p) + "</span>").join(", ") + (d.reason ? " — " + esc(d.reason) : "");
        return esc(e.op);
      }

      function renderLog(events) {
        countEl.textContent = events.length + " recent";
        if (!events.length) {
          logEl.innerHTML = '<li class="empty">No decisions yet.</li>';
          return;
        }
        logEl.innerHTML = events
          .map((e) => '<li><span class="op ' + e.op + '">' + e.op + "</span>" + describe(e) + '<div class="when">' + esc(new Date(e.at).toLocaleString()) + "</div></li>")
          .join("");
      }

      async function refresh() {
        try {
          const res = await fetch("/memory.json", { cache: "no-store" });
          if (!res.ok) throw new Error(res.status);
          const data = await res.json();
          renderTree(data.nodes || []);
          renderLog(data.events || []);
        } catch (err) {
          treeEl.innerHTML = '<div class="empty">Could not load memory (' + esc(err.message || err) + ").</div>";
        }
      }
      refresh();
      setInterval(refresh, 4000);
    </script>
  </body>
</html>`;
}

export function memoryJson(snapshot: { nodes: MemoryNode[]; events: MemoryEvent[] }): string {
  return JSON.stringify(snapshot);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}
