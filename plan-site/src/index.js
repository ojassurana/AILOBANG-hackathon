// plan.ailobang.com — static explainer for the AI Lobang plan.
// Worker exists so we can force https, add headers, and keep the door open
// for /api/* later.

const HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Browsers quietly degrade on http (no secure context), so never serve it.
    const proto = request.headers.get("X-Forwarded-Proto") || url.protocol.replace(":", "");
    if (proto === "http") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
    return out;
  },
};
