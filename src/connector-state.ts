/**
 * What a connector row shows, derived from whatever reports its status.
 *
 * The /app table has one row shape but more than one source of truth behind it:
 * Composio reports the OAuth connectors, and a connector that signs in some
 * other way has to report itself. Keeping the derivation here — free of Worker
 * and Composio imports — means every state is unit-testable without a browser,
 * and the renderer never has to know which source it is looking at.
 */

import type { TelegramPhase } from "./telegram-session";

export type RowTone = "ok" | "wait" | "bad";

export interface ConnectorRowState {
  /** null when nothing is connected and nothing is in flight. */
  tone: RowTone | null;
  /** The pill, or muted text, shown in the row's status cell. */
  label: string;
  /** Identifier shown beside the pill: an email address, or an @handle. */
  accountLabel?: string | null;
  /**
   * Which control the row offers. "resume" is for a connection that is partway
   * through and would be picked up rather than started again; "none" is for a
   * connection that is finished, where the only useful control is Disconnect.
   */
  actionKind: "connect" | "reconnect" | "resume" | "none";
  actionLabel: string;
  /** Whether the row also offers Disconnect. */
  canDisconnect: boolean;
}

/** The statuses Composio reports, already normalised by the API client. */
export type ComposioStatus = "ACTIVE" | "PENDING" | "FAILED";

/**
 * Takes a plain string rather than `ComposioStatus`: the API client normalises
 * what it recognises but passes anything else through, and an unrecognised
 * status has to fall back to "not connected" rather than be a compile error.
 */
export function composioRowState(
  status: string | null | undefined,
  accountLabel?: string | null,
): ConnectorRowState {
  switch (status) {
    case "ACTIVE":
      return {
        tone: "ok",
        label: "Connected",
        accountLabel,
        actionKind: "reconnect",
        actionLabel: "Reconnect",
        canDisconnect: true,
      };
    case "PENDING":
      // Not an error and not finished: the user left the consent screen open.
      return {
        tone: "wait",
        label: "Finishing sign-in",
        actionKind: "connect",
        actionLabel: "Connect",
        canDisconnect: false,
      };
    case "FAILED":
      return {
        tone: "bad",
        label: "Failed",
        actionKind: "connect",
        actionLabel: "Connect",
        canDisconnect: false,
      };
    default:
      return {
        tone: null,
        label: "Not connected",
        actionKind: "connect",
        actionLabel: "Connect",
        canDisconnect: false,
      };
  }
}

/**
 * Just the parts of a login the row reads.
 *
 * Structural rather than `TelegramLoginState`, because the row is rendered from
 * a `TelegramStatus` — which deliberately carries neither the code hash nor the
 * attempt count, since neither is anything the shelf has an opinion about.
 */
export interface TelegramRowInput {
  phase: TelegramPhase;
  phone: string | null;
  error: string | null;
  /** The account's own @handle, which it may not have. */
  username?: string | null;
}

/**
 * The same row, for the connector that signs in with a phone number instead of
 * through Composio.
 *
 * A Telegram login has states Composio's has no equivalent for — a code the user
 * has not typed yet, a two-step password, a flood wait — and all of them are
 * "partway through" rather than "connected", which is why they share the amber
 * tone. Only "connected" offers Disconnect, because until the login finishes
 * there is no session to end.
 */
export function telegramRowState(state: TelegramRowInput): ConnectorRowState {
  switch (state.phase) {
    case "connected":
      return {
        tone: "ok",
        label: "Connected",
        // Whichever of the two we have. The number is what the user typed and
        // will recognise, so it wins; the @handle is the fallback for a session
        // connected before the number was kept. A row with neither says only
        // "Connected", which is why the connected screen carries the identity.
        accountLabel: state.phone ?? (state.username ? `@${state.username}` : null),
        actionKind: "none",
        actionLabel: "",
        canDisconnect: true,
      };
    case "code":
      return {
        tone: "wait",
        label: "Enter your code",
        accountLabel: state.phone,
        actionKind: "resume",
        actionLabel: "Finish",
        canDisconnect: false,
      };
    case "password":
      return {
        tone: "wait",
        label: "Password needed",
        accountLabel: state.phone,
        actionKind: "resume",
        actionLabel: "Finish",
        canDisconnect: false,
      };
    case "error":
      return {
        tone: "bad",
        // The full message is a sentence and belongs on the step screen; the row
        // carries the verdict and where to go next.
        label: "Needs attention",
        accountLabel: state.phone,
        actionKind: "resume",
        actionLabel: "Try again",
        canDisconnect: false,
      };
    default:
      return {
        tone: null,
        label: "Not connected",
        actionKind: "connect",
        actionLabel: "Connect",
        canDisconnect: false,
      };
  }
}

/**
 * How many rows read as connected.
 *
 * The denominator is the shelf itself, so the header cannot advertise more rows
 * than exist. `otherConnected` counts the rows whose status does not come from
 * Composio — passing a number rather than a map keeps this independent of how
 * that source stores its state.
 */
export function connectedRowCount(
  rows: readonly { toolkit: string }[],
  composioStatus: (toolkit: string) => string | undefined,
  otherConnected = 0,
): number {
  const viaComposio = rows.filter((row) => composioStatus(row.toolkit) === "ACTIVE").length;
  return viaComposio + otherConnected;
}
