/**
 * The connector shelf shown on "Connect your accounts".
 *
 * Each entry needs an auth config in the Composio project; the ids below are the
 * Composio-managed OAuth2 configs created for org `ojas.surana_workspace`.
 * Toolkit slugs are case-sensitive and not uniform (googledrive, not google_drive).
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
    authConfigId: "ac_oz6WCGpIYFf_",
  },
  {
    slug: "gmail",
    name: "Gmail",
    blurb: "Read and send email",
    authConfigId: "ac_QbyuUMPoSrUp",
  },
  {
    slug: "reddit",
    name: "Reddit",
    blurb: "Posts and comments",
    authConfigId: "ac_VTd0qkDM8Gn8",
  },
  {
    slug: "instagram",
    name: "Instagram",
    blurb: "Business or creator accounts only",
    authConfigId: "ac_Gw4p82He8cdb",
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    blurb: "Profile and posts",
    authConfigId: "ac_pitcIY06F_Aw",
  },
  {
    slug: "slack",
    name: "Slack",
    blurb: "Channels and messages",
    authConfigId: "ac_dI51ojmyBt4w",
  },
  {
    slug: "notion",
    name: "Notion",
    blurb: "Pages and databases",
    authConfigId: "ac_HORxNbyf5jO5",
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    blurb: "Spreadsheets",
    authConfigId: "ac_VfllQsJpW4GE",
  },
  {
    slug: "googledocs",
    name: "Google Docs",
    blurb: "Documents",
    authConfigId: "ac_ce3xJJ7e3d0V",
  },
  {
    slug: "discord",
    name: "Discord",
    blurb: "Servers and messages",
    authConfigId: "ac_w__sswrcMQvZ",
  },
  {
    slug: "google_maps",
    name: "Google Maps",
    blurb: "Places and directions",
    authConfigId: "ac_DyvS4MJjkYaF",
  },
];

export function connectorBySlug(slug: string): Connector | undefined {
  return CONNECTORS.find((c) => c.slug === slug);
}

export function logoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}
