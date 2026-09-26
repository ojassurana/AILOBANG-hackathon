/**
 * The connector shelf shown on "Connect your accounts".
 *
 * Each entry needs an auth config in the Composio project the API key belongs to
 * (project "AiLobang"). All are Composio-managed OAuth2, so the project needs no
 * OAuth apps of its own.
 *
 * Toolkit slugs are irregular: googledrive/googlesheets/googledocs take no
 * underscore, while google_maps does.
 */
export interface Connector {
  slug: string;
  name: string;
  blurb: string;
  authConfigId: string;
}

export const CONNECTORS: Connector[] = [
  {
    slug: "googledrive",
    name: "Google Drive",
    blurb: "Files and folders",
    authConfigId: "ac_paD5fAd7gETs",
  },
  {
    slug: "gmail",
    name: "Gmail",
    blurb: "Read and send email",
    authConfigId: "ac_ADECsKVGjtg2",
  },
  {
    slug: "reddit",
    name: "Reddit",
    blurb: "Posts and comments",
    authConfigId: "ac_dCcCEfnWbU3a",
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    blurb: "Profile and posts",
    authConfigId: "ac_OFlrAc-Ecqto",
  },
  {
    slug: "slack",
    name: "Slack",
    blurb: "Channels and messages",
    authConfigId: "ac_uylus0AdUUfb",
  },
  {
    slug: "notion",
    name: "Notion",
    blurb: "Pages and databases",
    authConfigId: "ac_aElmL4jYQf2b",
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    blurb: "Spreadsheets",
    authConfigId: "ac_OKP9X49e05SD",
  },
  {
    slug: "googledocs",
    name: "Google Docs",
    blurb: "Documents",
    authConfigId: "ac_pvDX0ItS_pqw",
  },
  {
    slug: "discord",
    name: "Discord",
    blurb: "Servers and messages",
    authConfigId: "ac_6gCV39d-bsrV",
  },
  {
    slug: "google_maps",
    name: "Google Maps",
    blurb: "Places and directions",
    authConfigId: "ac_rMGoQhWXFi0X",
  },
];

export function connectorBySlug(slug: string): Connector | undefined {
  return CONNECTORS.find((c) => c.slug === slug);
}

export function logoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}
