/**
 * Turning the name a caller says into the people it might mean, and into the
 * identity a message goes to.
 *
 * A person is addressed one of two ways: by their @username when the account has
 * one, or by their user id when it does not. The id is only usable together with
 * the access hash that came back with it from the same response, and an access
 * hash goes stale — one read back out of storage addresses whoever it points at
 * now. So the hash lives for exactly one request: the lookup that produced it.
 * Nothing here stores anything, and a send re-resolves the id instead of
 * remembering a hash.
 *
 * Kept out of the Durable Object for the reason the login state machine is: the
 * ordering decides who is offered first, and the decisions below decide whether
 * anything is sent at all. Both are worth testing without a socket.
 */

/** Where the object found a candidate, in the order it looks. */
export type ContactSource = "chat" | "contacts" | "search";

/**
 * A person as a lookup described them, with the identity that can reach them.
 *
 * `userId` and `accessHash` come from the same response that named the person —
 * `contacts.getContacts`, `contacts.search`, or a stored chat. The hash is the
 * one thing here that must never be written down: it is passed straight through
 * to the send that needs it and re-fetched by that send anyway, because it is
 * what would go stale.
 */
export interface SendTarget {
  title: string;
  /** The @handle, or null when the account has none and the id is used. */
  username: string | null;
  /** The Telegram user id, which is what a username-less send needs. */
  userId: string | null;
  /** The hash that makes the id addressable, from the lookup that found them. */
  accessHash: string | null;
}

/** A person as one of the three lookup sources knows them, before any matching. */
export type NamedPerson = SendTarget;

/** One person a spoken name might mean. */
export interface ContactCandidate extends SendTarget {
  source: ContactSource;
}

/** Past this the question stops being answerable out loud. */
export const MAX_CANDIDATES = 5;

/** Whether a name can be sent to, and who it settles on when it can. */
export type Resolution =
  | { kind: "send"; target: SendTarget }
  | { kind: "refuse"; reason: string };

/** The comparable form of a name or handle: no @, no case, no edges. */
function fold(value: string): string {
  return value.replace(/^@/, "").trim().toLowerCase();
}

/**
 * How well one person answers the spoken name, or null when they do not.
 * Lower is better.
 *
 * An exact name or handle beats one that starts with the words, which beats one
 * that merely contains them: "chacha" has to find "Rahul Chacha", and a contact
 * actually called Chacha should be offered ahead of him.
 */
function rank(person: NamedPerson, spoken: string): number | null {
  const title = person.title.trim().toLowerCase();
  const handle = person.username ? fold(person.username) : null;
  if (title === spoken || handle === spoken) return 0;
  if (title.startsWith(spoken) || (handle !== null && handle.startsWith(spoken))) return 1;
  if (title.includes(spoken) || (handle !== null && handle.includes(spoken))) return 2;
  return null;
}

/**
 * Who a person is for the purpose of being offered once.
 *
 * A handle is the strongest identity available — it is what a stranger can
 * verify — and an id is next; the display name is the fallback, and two
 * different accounts can share one. That is why two people who share a name but
 * not an account stay two candidates: the caller is asked rather than guessed at.
 */
function identity(person: NamedPerson): string {
  if (person.username) return `u:${fold(person.username)}`;
  if (person.userId) return `id:${person.userId}`;
  return `name:${person.title.trim().toLowerCase()}`;
}

/**
 * The people whose name matches, best first, at most `MAX_CANDIDATES`.
 *
 * The source's own order breaks ties — for stored chats that is most recent
 * first, which is the one the caller most likely means — and nobody is offered
 * twice: the same contact can be known by a stored chat and by the address
 * book, and a repeated line in a question that has to be read aloud is noise.
 */
export function rankMatches(
  people: NamedPerson[],
  spoken: string,
  source: ContactSource,
): ContactCandidate[] {
  const query = fold(spoken);
  if (!query) return [];

  const scored: { person: NamedPerson; score: number; at: number }[] = [];
  people.forEach((person, at) => {
    if (!person.title.trim()) return;
    const score = rank(person, query);
    if (score === null) return;
    scored.push({ person, score, at });
  });
  scored.sort((a, b) => a.score - b.score || a.at - b.at);

  const found: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const { person } of scored) {
    const key = identity(person);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      title: person.title,
      username: person.username,
      userId: person.userId,
      accessHash: person.accessHash,
      source,
    });
    if (found.length === MAX_CANDIDATES) break;
  }
  return found;
}

/**
 * One line naming a candidate.
 *
 * A person with no @username is never dropped from a list, and is never called
 * unmessagable either: they are a real answer to the name asked about and a
 * message reaches their account without a handle, so the only thing missing is a
 * handle to read out.
 */
export function describeCandidate(person: ContactCandidate): string {
  return person.username ? `${person.title} (${person.username})` : `${person.title} — no @username`;
}

/**
 * Whether a person can be sent to: a handle, or an id to look the hash up by.
 *
 * An id alone is enough. The hash that makes it usable is deliberately not part
 * of this decision: the lookup that resolved the name may have been a stored
 * chat, which has no hash at all, and the send fetches its own anyway.
 */
export function sendable(person: SendTarget): boolean {
  return person.username !== null || person.userId !== null;
}

/**
 * The address a prepared send is stored under: the @handle, or the user id when
 * there is none.
 *
 * The hash is absent by construction. This string is the only thing about the
 * recipient that outlives the request, and a stored hash is the one input a send
 * must never use.
 */
export function sendAddress(target: Pick<SendTarget, "username" | "userId">): string {
  return target.username ?? `id:${target.userId}`;
}

/** The user id a stored address carries, or null when it carries a handle. */
export function addressUserId(address: string): string | null {
  const match = /^id:(\d+)$/.exec(address.trim());
  return match ? match[1] : null;
}

/**
 * The address as it can be said out loud: the @handle, or nothing when the
 * message goes to an account with no handle to name.
 */
export function spokenAddress(address: string): string | null {
  return addressUserId(address) === null ? address : null;
}

/**
 * The key the send tables know a person by: their handle, or their id.
 *
 * One person has to be one row in `recipients` whether the caller reached them
 * by name or by handle, which is why this is not the address: "@RahulChacha" and
 * "rahulchacha" are the same column value here.
 */
export function sendKey(address: string): string {
  const id = addressUserId(address);
  return id === null ? fold(address) : `id:${id}`;
}

/**
 * The hash a send may use, taken only from a lookup run for that send.
 *
 * It takes an id and the people a live lookup has just returned — never an
 * address read back from storage — so there is nowhere for a stale hash to
 * enter. Null when this lookup did not produce a usable hash for the id: an
 * unavailable peer is not a reason to reach for anything older.
 */
export function freshIdentity(
  userId: string,
  people: NamedPerson[],
): { userId: string; accessHash: string } | null {
  for (const person of people) {
    if (person.userId === userId && person.accessHash !== null) {
      return { userId, accessHash: person.accessHash };
    }
  }
  return null;
}

/**
 * The people a stored message row knows, from the rows themselves.
 *
 * The chat key is `user:<id>` for a message that arrived and `user:<handle>` for
 * one we sent, so one person can be here twice under a single display name. The
 * rows are merged, keeping an id and a handle from whichever row has one, and
 * `chat_title` is the @username when there is one to show and the display name
 * otherwise. No access hash is ever recovered: this table has none, and a hash
 * read from storage is exactly what a send must not use.
 */
export function storedPeople(rows: { chat: string; title: string }[]): NamedPerson[] {
  const people: NamedPerson[] = [];
  const byTitle = new Map<string, NamedPerson>();

  for (const row of rows) {
    const id = /^user:(\d+)$/.exec(row.chat)?.[1] ?? null;
    const tail = id === null && row.chat.startsWith("user:") ? row.chat.slice("user:".length) : null;
    const person: NamedPerson = {
      title: row.title,
      username: row.title.startsWith("@") ? row.title : tail ? `@${tail}` : null,
      userId: id,
      accessHash: null,
    };

    const key = person.title.trim().toLowerCase();
    const seen = byTitle.get(key);
    if (!seen) {
      byTitle.set(key, person);
      people.push(person);
      continue;
    }
    if (seen.userId === null) seen.userId = person.userId;
    if (seen.username === null) seen.username = person.username;
  }

  return people;
}

/**
 * Whether a spoken name settles on someone that can be sent to.
 *
 * The caller's next word is "yes", so anything other than exactly one person has
 * to stop here: choosing between two would send a private message to the wrong
 * one. A person with no @username is not that case — they are reached by their
 * account, so they settle on the same terms as anyone else.
 */
export function resolveSpokenName(spoken: string, people: ContactCandidate[]): Resolution {
  const asked = spoken.trim();

  if (!people.length) {
    return {
      kind: "refuse",
      reason:
        `Nobody in the caller's Telegram is called "${asked}". Say that plainly, and ask them to ` +
        `check the name they said — a handle is not needed to look someone up.`,
    };
  }

  if (people.length > 1) {
    return {
      kind: "refuse",
      reason:
        `${asked} could be ${people.length} people: ${people.map(describeCandidate).join(", ")}. ` +
        `Ask the caller which one they mean, then prepare the message again naming that person.`,
    };
  }

  const only = people[0];
  if (!sendable(only)) {
    // No lookup source produces this — every one that names a person also gives
    // the id to reach them by — but refusing is the honest answer if one ever does.
    return {
      kind: "refuse",
      reason:
        `The only match for "${asked}" is ${only.title}, and I have neither a handle nor an ` +
        `account id for them, so there is nothing to send to.`,
    };
  }

  return {
    kind: "send",
    target: {
      title: only.title,
      username: only.username,
      userId: only.userId,
      accessHash: only.accessHash,
    },
  };
}
