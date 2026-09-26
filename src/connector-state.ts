/**
 * What a connector row shows, derived from whatever reports its status.
 *
 * The /app table has one row shape but more than one source of truth behind it:
 * Composio reports the OAuth connectors, and a connector that signs in some
 * other way has to report itself. Keeping the derivation here — free of Worker
 * and Composio imports — means every state is unit-testable without a browser,
 * and the renderer never has to know which source it is looking at.
 */

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
   * through and would be picked up rather than started again.
   */
  actionKind: "connect" | "reconnect" | "resume";
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
