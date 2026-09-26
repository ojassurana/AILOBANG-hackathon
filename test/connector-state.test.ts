/**
 * Tests for the shared connector-row state.
 *
 * Two things here are load-bearing. The row states are the only description of
 * what a user sees on /app, so a status that renders the wrong tone or offers
 * Disconnect when nothing is connected is a visible bug. And the header count
 * has to agree with the shelf: it is the one number on the page that claims to
 * summarise everything else.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { CONNECTORS, isComposio } from "../src/connectors";
import { composioRowState, connectedRowCount } from "../src/connector-state";

let passed = 0;
let failed = 0;

function check(name: string, run: () => void) {
  try {
    run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* --------------------------------------------------- row state per status */

check("a row with no account reads as not connected", () => {
  assert.equal(composioRowState(null).tone, null);
  assert.equal(composioRowState(null).label, "Not connected");
  assert.equal(composioRowState(null).actionKind, "connect");
  assert.equal(composioRowState(null).actionLabel, "Connect");
  assert.equal(composioRowState(null).canDisconnect, false);
});

check("an unrecognised status reads as not connected", () => {
  // The API client normalises what it knows and passes the rest through, so
  // anything new must land on the safe state rather than throw or guess.
  assert.equal(composioRowState(undefined).tone, null);
  assert.equal(composioRowState("REVOKED_ELSEWHERE").tone, null);
  assert.equal(composioRowState("").label, "Not connected");
});

check("an active row reconnects and can be disconnected", () => {
  const active = composioRowState("ACTIVE", "someone@example.com");
  assert.equal(active.tone, "ok");
  assert.equal(active.label, "Connected");
  assert.equal(active.accountLabel, "someone@example.com");
  assert.equal(active.actionKind, "reconnect");
  assert.equal(active.actionLabel, "Reconnect");
  assert.equal(active.canDisconnect, true);
});

check("an active row with no label still reads as connected", () => {
  // The label is shown beside the pill, so an absent one must not change the
  // state itself.
  const unlabelled = composioRowState("ACTIVE", null);
  assert.equal(unlabelled.tone, "ok");
  assert.equal(unlabelled.label, "Connected");
  assert.equal(unlabelled.accountLabel, null);
  assert.equal(unlabelled.canDisconnect, true);
});

check("a pending row finishes sign-in without offering Disconnect", () => {
  // Pending is the state a user leaves behind by abandoning the consent screen,
  // so it must not read as connected or as a failure, and there is nothing yet
  // to disconnect.
  const pending = composioRowState("PENDING");
  assert.equal(pending.tone, "wait");
  assert.equal(pending.label, "Finishing sign-in");
  assert.equal(pending.actionKind, "connect");
  assert.equal(pending.canDisconnect, false);
});

check("a failed row reads as failed without offering Disconnect", () => {
  const failed = composioRowState("FAILED");
  assert.equal(failed.tone, "bad");
  assert.equal(failed.label, "Failed");
  assert.equal(failed.actionKind, "connect");
  assert.equal(failed.canDisconnect, false);
});

check("every state has its own tone", () => {
  // Two situations that share a tone would be indistinguishable at a glance.
  const tones = new Set([
    composioRowState("ACTIVE").tone,
    composioRowState("PENDING").tone,
    composioRowState("FAILED").tone,
    composioRowState(null).tone,
  ]);
  assert.deepEqual(tones, new Set(["ok", "wait", "bad", null]));
});

check("only connected rows offer Disconnect", () => {
  // Disconnect is a destructive control; offering it on a row with nothing
  // behind it sends the user to a delete that cannot succeed.
  const offered = ["ACTIVE", "PENDING", "FAILED", null]
    .map((status) => composioRowState(status).canDisconnect)
    .filter(Boolean);
  assert.deepEqual(offered, [true]);
});

/* ----------------------------------------------------------- the header count */

const rows = [{ toolkit: "gmail" }, { toolkit: "slack" }, { toolkit: "notion" }];
const statuses: Record<string, string> = { gmail: "ACTIVE", slack: "PENDING" };

check("only ACTIVE rows count toward the header", () => {
  assert.equal(
    connectedRowCount(rows, (toolkit) => statuses[toolkit]),
    1,
  );
  assert.equal(connectedRowCount(rows, () => undefined), 0);
  assert.equal(connectedRowCount([], () => "ACTIVE", 0), 0);
});

check("a connected row outside Composio is added, not merged", () => {
  assert.equal(
    connectedRowCount(rows, (toolkit) => statuses[toolkit], 1),
    2,
  );
});

check("the count can never exceed the shelf it describes", () => {
  assert.equal(
    connectedRowCount(
      CONNECTORS,
      () => "ACTIVE",
      CONNECTORS.filter((connector) => !isComposio(connector)).length,
    ),
    CONNECTORS.length,
  );
});

/* ------------------------------------------------------- the kind discriminator */

check("every Composio row carries an auth config and no other row does", () => {
  // The guards in the Composio client depend on this being exact: a row that
  // claims to be Composio without an auth config sends `undefined` to the API,
  // and a row that hides its auth config silently stops connecting.
  for (const connector of CONNECTORS) {
    if (isComposio(connector)) {
      assert.ok(connector.authConfigId, `${connector.slug} is a Composio row and needs an auth config`);
    } else {
      assert.equal(
        connector.authConfigId,
        undefined,
        `${connector.slug} connects another way and must not carry a Composio auth config`,
      );
    }
  }
});

check("every row carries a non-empty toolkit", () => {
  // The helpers group rows by toolkit, so an empty one would collide with every
  // other row that lacked one.
  for (const connector of CONNECTORS) {
    assert.ok(connector.toolkit, `${connector.slug} needs a non-empty toolkit`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
