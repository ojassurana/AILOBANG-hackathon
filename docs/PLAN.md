# AI Lobang — build plan

## Phase 0 — shape (done)
- [x] Concept, name, vibe
- [x] Repo
- [x] `plan.ailobang.com` explainer page

## Phase 1 — the shell (accounts)
- [ ] Worker `ailobang-app` + D1 `ai-lobang`
- [ ] `users` / `sessions` tables + PBKDF2 signup + login
- [ ] Session cookie, logout, "who am I" endpoint
- [ ] Post-login screen: connector shelf (Gmail card, greyed others)

## Phase 2 — Gmail via Composio
- [ ] Composio project for AI Lobang + Gmail auth config
- [ ] `POST /api/connect/gmail` → hosted OAuth → callback stores
      `connected_account_id`
- [ ] Connector card flips to *Connected* with the email address shown
- [ ] Server-side smoke test: list unread through the connected account

## Phase 3 — the number
- [ ] Assign Telnyx number to the user row
- [ ] Show it in the dashboard: "Your line" + add-to-contacts
- [ ] Inbound call → identify user by dialled number → open GPT-Live session
- [ ] Bridge the Gmail tools to the live session with the caller's account

## Phase 4 — make it feel real
- [ ] Call log + transcript in the dashboard
- [ ] Confirm-before-send for anything destructive
- [ ] Voice/persona per user (name, how it greets you)
- [ ] Second connector (Calendar) to prove the shelf generalises

## Not doing (yet)
- Outbound calls, SMS, WhatsApp
- Teams/orgs, sharing, roles
- Payments
