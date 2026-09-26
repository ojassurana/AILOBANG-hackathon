/**
 * The connector shelf shown on "Connect your accounts".
 *
 * Each entry needs an auth config in the Composio project the API key belongs to
 * (project "AiLobang"), and all are Composio-managed OAuth2, so the project needs
 * no OAuth apps of its own.
 *
 * `slug` names the row and appears in its URL. `toolkit` names the Composio
 * toolkit the connection actually lives under — the difference matters for the
 * Google services, which share one `googlesuper` connection so a single Google
 * consent covers all of them instead of one consent each.
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

/** How many service logos the collapsed group shows before switching to "+N". */
export const GOOGLESUPER_VISIBLE_SERVICES = 6;

/**
 * The collapsed "Google Services" box. It stands for the single shared connection
 * and carries the connect / disconnect actions for every Google service, so the
 * rows inside it show status only.
 */
export const GOOGLE_GROUP: Connector = {
  slug: "google",
  name: "Google Services",
  blurb: "One Google login covers all of these",
  toolkit: "googlesuper",
  authConfigId: GOOGLESUPER_AUTH_CONFIG,
};

/** Every Google service the one consent grants. */
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
  return slug === GOOGLE_GROUP.slug ? GOOGLE_GROUP : CONNECTORS.find((c) => c.slug === slug);
}

/** The Google services shown inside the group, in shelf order. */
export function googleConnectors(): Connector[] {
  return CONNECTORS.filter((c) => c.toolkit === GOOGLE_GROUP.toolkit);
}

/** Everything outside the group — the rows that stand on their own. */
export function standaloneConnectors(): Connector[] {
  return CONNECTORS.filter((c) => c.toolkit !== GOOGLE_GROUP.toolkit);
}

/** Every row backed by the same connection, e.g. all the Google services. */
export function connectorsForToolkit(toolkit: string): Connector[] {
  return CONNECTORS.filter((c) => c.toolkit === toolkit);
}

export function logoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}
