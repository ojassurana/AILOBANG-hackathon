/**
 * The memory page: two lists the signed-in user can watch fill in.
 *
 * Personal memory is the personal branch. Personal workflows is the workflow
 * branch. The page polls /memory.json, so a call on another tab shows up here
 * a few seconds after it is saved.
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
        --ok: #1a9b52; --bad: #c0392b; --accent: #4f46e5;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #0d0d10; --fg: #f4f4f6; --muted: #9a9aa5; --card: #141418; --border: rgba(255,255,255,.12); --shadow: none; --accent: #8b83ff; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .shell { max-width: 1100px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; max-width: 46em; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .status { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 12.5px; color: var(--muted); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
      .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; }
      @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } .who { white-space: normal; } }
      .card { padding: 20px 22px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); min-height: 240px; }
      h2 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .count { font-size: 12px; font-weight: 600; color: var(--muted); }
      .lede { margin: 0 0 16px; color: var(--muted); font-size: 13.5px; }
      .group { margin: 0 0 16px; }
      .place { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
      .item { padding: 12px 0; border-top: 1px solid var(--border); }
      .place + .item { border-top: 0; padding-top: 0; }
      .title { font-weight: 650; }
      .body { margin-top: 3px; white-space: pre-wrap; }
      .meta { margin-top: 6px; color: var(--muted); font-size: 12.5px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .chip { padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; color: var(--muted); }
      details { margin-top: 8px; }
      summary { cursor: pointer; color: var(--accent); font-size: 13px; }
      .code { margin: 8px 0 0; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; max-height: 220px; overflow: auto; }
      .empty { color: var(--muted); font-size: 14px; padding: 8px 0 4px; }
      .note { margin: 18px 0 0; padding: 11px 13px; border-radius: 11px; font-size: 13.5px; background: rgba(192,57,43,.10); border: 1px solid rgba(192,57,43,.26); }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>Memory</h1>
          <p class="sub">What Ailobang keeps from your calls. It uses this on the next thing you ask, and this page updates on its own.</p>
          <div class="status"><span class="dot ${connected ? "ok" : "bad"}"></span>${connected ? "Live" : "Not connected"}</div>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/app">Your accounts</a> · <a href="/call">Call</a></div>
      </div>
      ${error ? `<p class="note">${escapeHtml(error)}</p>` : ""}
      <div class="grid">
        <section class="card">
          <h2>Personal memory <span class="count" id="personal-count"></span></h2>
          <p class="lede">People, places, and the way you like things done.</p>
          <div id="personal"><div class="empty">Loading…</div></div>
        </section>
        <section class="card">
          <h2>Personal workflows <span class="count" id="workflow-count"></span></h2>
          <p class="lede">Jobs it has already figured out, so the next time is shorter.</p>
          <div id="workflow"><div class="empty">Loading…</div></div>
        </section>
      </div>
    </div>
    <script>
      const personalEl = document.getElementById("personal");
      const workflowEl = document.getElementById("workflow");
      const personalCount = document.getElementById("personal-count");
      const workflowCount = document.getElementById("workflow-count");
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      function label(slug) {
        return slug.replace(/-/g, " ").replace(/\\b\\w/g, (c) => c.toUpperCase());
      }

      function placeOf(path) {
        return path.split("/").slice(1, -1).map(label).join(" · ");
      }

      function skillHtml(n) {
        let html = '<div class="item"><div class="title">' + esc(n.title) + "</div>";
        if (n.content) html += '<div class="body">' + esc(n.content) + "</div>";
        else if (n.summary) html += '<div class="body">' + esc(n.summary) + "</div>";
        const bits = [];
        if (n.uses) bits.push("Used " + n.uses + (n.uses === 1 ? " time" : " times"));
        if (n.inputs && n.inputs.length) bits.push("Fills in " + n.inputs.join(", "));
        if (bits.length) html += '<div class="meta">' + esc(bits.join(" · ")) + "</div>";
        if (n.tools && n.tools.length) {
          html += '<div class="chips">' + n.tools.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + "</div>";
        }
        if (n.code) html += '<details><summary>Saved steps</summary><pre class="code">' + esc(n.code) + "</pre></details>";
        return html + "</div>";
      }

      function renderBranch(el, countEl, nodes, branch, emptyText) {
        const skills = nodes.filter((n) => n.branch === branch && n.kind === "skill").sort((a, b) => a.path.localeCompare(b.path));
        countEl.textContent = skills.length ? skills.length + " saved" : "";
        if (!skills.length) {
          el.innerHTML = '<div class="empty">' + emptyText + "</div>";
          return;
        }
        const groups = new Map();
        for (const n of skills) {
          const place = placeOf(n.path);
          if (!groups.has(place)) groups.set(place, []);
          groups.get(place).push(n);
        }
        let html = "";
        for (const [place, items] of groups) {
          html += '<div class="group">';
          if (place) html += '<div class="place">' + esc(place) + "</div>";
          html += items.map(skillHtml).join("");
          html += "</div>";
        }
        el.innerHTML = html;
      }

      async function refresh() {
        try {
          const res = await fetch("/memory.json", { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.json();
          const nodes = data.nodes || [];
          renderBranch(personalEl, personalCount, nodes, "personal", "Nothing yet. Talk about a person, a place, or how you like something done.");
          renderBranch(workflowEl, workflowCount, nodes, "workflow", "Nothing yet. Ask it to do a job that takes a few steps, and it will keep the way it did it.");
        } catch (err) {
          personalEl.innerHTML = '<div class="empty">Could not load (' + esc(err.message || err) + ").</div>";
          workflowEl.innerHTML = "";
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
