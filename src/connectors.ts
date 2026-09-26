/**
 * The connector shelf shown on "Connect your accounts".
 *
 * Each entry needs an auth config in the Composio project the API key belongs to
 * (project "AiLobang"), and all are Composio-managed OAuth2, so the project needs
 * no OAuth apps of its own.
 *
 * `slug` names the row and appears in its URL. `toolkit` names the Composio
 * toolkit the connection actually lives under — the difference matters for the
 * Google rows, which share one `googlesuper` connection so a single Google
 * consent covers Drive, Gmail, Sheets and Docs instead of four separate ones.
 *
 * Toolkit slugs are irregular: googledrive/googlesheets/googledocs take no
 * underscore, while google_maps does.
 */
export interface Connector {
  /** Row identity and URL segment. */
  slug: string;
  name: string;
  blurb: string;
  /** Composio toolkit the connected account is stored against. */
  toolkit: string;
  authConfigId: string;
}

/** Google Super: one consent for Drive, Gmail, Sheets, Docs, Calendar and more. */
const GOOGLESUPER_AUTH_CONFIG = "ac_NJgQSgfqbj_V";

export const CONNECTORS: Connector[] = [
  {
    slug: "googledrive",
    name: "Google Drive",
    blurb: "Files and folders",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "gmail",
    name: "Gmail",
    blurb: "Read and send email",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlecalendar",
    name: "Google Calendar",
    blurb: "Events and scheduling",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    blurb: "Spreadsheets",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googledocs",
    name: "Google Docs",
    blurb: "Documents",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googleslides",
    name: "Google Slides",
    blurb: "Presentations",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlephotos",
    name: "Google Photos",
    blurb: "Photos it creates for you",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlecontacts",
    name: "Google Contacts",
    blurb: "People you know",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googletasks",
    name: "Google Tasks",
    blurb: "To-do lists",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "google_analytics",
    name: "Google Analytics",
    blurb: "Traffic reports",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googleads",
    name: "Google Ads",
    blurb: "Campaigns and spend",
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "reddit",
    name: "Reddit",
    blurb: "Posts and comments",
    toolkit: "reddit",
    authConfigId: "ac_dCcCEfnWbU3a",
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    blurb: "Profile and posts",
    toolkit: "linkedin",
    authConfigId: "ac_OFlrAc-Ecqto",
  },
  {
    slug: "slack",
    name: "Slack",
    blurb: "Channels and messages",
    toolkit: "slack",
    authConfigId: "ac_uylus0AdUUfb",
  },
  {
    slug: "notion",
    name: "Notion",
    blurb: "Pages and databases",
    toolkit: "notion",
    authConfigId: "ac_aElmL4jYQf2b",
  },
  {
    slug: "discord",
    name: "Discord",
    blurb: "Servers and messages",
    toolkit: "discord",
    authConfigId: "ac_6gCV39d-bsrV",
  },
  {
    slug: "google_maps",
    name: "Google Maps",
    blurb: "Places and directions",
    toolkit: "google_maps",
    authConfigId: "ac_rMGoQhWXFi0X",
  },
];

export function connectorBySlug(slug: string): Connector | undefined {
  return CONNECTORS.find((c) => c.slug === slug);
}

/** Every row backed by the same connection, e.g. the four Google ones. */
export function connectorsForToolkit(toolkit: string): Connector[] {
  return CONNECTORS.filter((c) => c.toolkit === toolkit);
}

export function logoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}
