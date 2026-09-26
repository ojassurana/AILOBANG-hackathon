/**
 * The connector shelf shown on "Connect your accounts".
 *
 * Each entry needs an auth config in the Composio project the API key belongs to
 * (project "AiLobang"). Almost all are Composio-managed OAuth2, so the project
 * needs no OAuth apps of its own; the exception is Cursor, which Composio does
 * not manage — see its entry below.
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
  /**
   * What the agent can do through this account once it is connected, shown
   * behind the row's Capabilities disclosure. Written from the caller's point of
   * view rather than as Composio tool slugs. A row without any simply has no
   * disclosure.
   */
  capabilities?: string[];
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
    capabilities: [
      "Find files and folders",
      "Read what's inside a file",
      "Upload, organise and share files",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "gmail",
    name: "Gmail",
    blurb: "Read and send email",
    capabilities: [
      "Find and read your email",
      "Draft and send replies",
      "Label, archive or delete threads",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlecalendar",
    name: "Google Calendar",
    blurb: "Events and scheduling",
    capabilities: ["Read your schedule", "Add, move or cancel events", "Find free time"],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    blurb: "Spreadsheets",
    capabilities: [
      "Read and write cells and rows",
      "Add a sheet to a spreadsheet",
      "Create a new spreadsheet",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googledocs",
    name: "Google Docs",
    blurb: "Documents",
    capabilities: ["Read and write documents", "Create a new doc", "Export a doc as PDF"],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googleslides",
    name: "Google Slides",
    blurb: "Presentations",
    capabilities: ["Read a deck and its slides", "Create a presentation"],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlephotos",
    name: "Google Photos",
    blurb: "Photos it creates for you",
    // The granted scope is photoslibrary.*.appcreateddata, so this reaches only
    // what the app itself created — worth saying, since it is narrower than the
    // name suggests.
    capabilities: [
      "Look through albums this app created for you",
      "Add those photos to an album or download them",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googlecontacts",
    name: "Google Contacts",
    blurb: "People you know",
    capabilities: ["Look up someone's details", "Read and add contacts"],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googletasks",
    name: "Google Tasks",
    blurb: "To-do lists",
    capabilities: ["Read your task lists", "Add a to-do, tick one off or clear the done ones"],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "google_analytics",
    name: "Google Analytics",
    blurb: "Traffic reports",
    capabilities: [
      "Pull traffic and audience reports",
      "Break a report down by page, source or date",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "googleads",
    name: "Google Ads",
    blurb: "Campaigns and spend",
    capabilities: [
      "Look up campaigns and how they're doing",
      "Read spend, budgets and customer lists",
    ],
    toolkit: "googlesuper",
    authConfigId: GOOGLESUPER_AUTH_CONFIG,
  },
  {
    slug: "reddit",
    name: "Reddit",
    blurb: "Posts and comments",
    capabilities: [
      "Read posts, comments and subreddit rules",
      "Search across subreddits",
      "Post, comment, edit or delete your own content",
    ],
    toolkit: "reddit",
    authConfigId: "ac_dCcCEfnWbU3a",
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    blurb: "Profile and posts",
    capabilities: [
      "Read your profile and company pages",
      "Publish a post or leave a comment",
      "Check how a post is doing",
    ],
    toolkit: "linkedin",
    authConfigId: "ac_OFlrAc-Ecqto",
  },
  {
    slug: "slack",
    name: "Slack",
    blurb: "Channels and messages",
    capabilities: [
      "Read channels and message history",
      "Search your workspace",
      "Send, schedule or reply to messages",
    ],
    toolkit: "slack",
    authConfigId: "ac_uylus0AdUUfb",
  },
  {
    slug: "notion",
    name: "Notion",
    blurb: "Pages and databases",
    capabilities: [
      "Search pages and databases",
      "Read a page's content",
      "Create or update pages and database rows",
    ],
    toolkit: "notion",
    authConfigId: "ac_aElmL4jYQf2b",
  },
  {
    // Composio's Discord toolkit is the user-OAuth one, which reads the
    // authorizing user's own account: guilds, profile, role connections. It has
    // no tool for reading or sending channel messages — those live in the
    // separate Discord Bot toolkit, which needs a bot token — so the blurb says
    // servers and profile rather than messages.
    slug: "discord",
    name: "Discord",
    blurb: "Servers and your profile",
    capabilities: [
      "See the servers you're in and your role in each",
      "Look up your Discord profile and linked accounts",
    ],
    toolkit: "discord",
    authConfigId: "ac_6gCV39d-bsrV",
  },
  {
    slug: "google_maps",
    name: "Google Maps",
    blurb: "Places and directions",
    capabilities: [
      "Look up addresses, places and opening hours",
      "Get directions and travel times",
    ],
    toolkit: "google_maps",
    authConfigId: "ac_rMGoQhWXFi0X",
  },
  {
    // The one row Composio does not manage: Cursor has no managed auth scheme,
    // so this auth config is `use_custom_auth` with scheme API_KEY, and the
    // Connect Link asks the user to paste their own Cursor API key instead of
    // running an OAuth consent.
    slug: "cursor",
    name: "Cursor",
    // No usage or billing tool for a Cursor API key in this toolkit, so the
    // blurb promises only what the five tools deliver.
    blurb: "Cloud agents and repos",
    capabilities: [
      "List your cloud agents and read a conversation",
      "See the models available to your key",
      "List the GitHub repos your key can reach",
    ],
    toolkit: "cursor",
    authConfigId: "ac_KvRPE8I581Gi",
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

/** The toolkit each connection lives under, paired with the auth config to use for it. */
export function toolkitAuthConfigs(): Record<string, string> {
  const configs: Record<string, string> = {};
  for (const connector of CONNECTORS) configs[connector.toolkit] = connector.authConfigId;
  return configs;
}

export function logoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}
