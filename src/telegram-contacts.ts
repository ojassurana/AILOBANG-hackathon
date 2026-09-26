/**
 * Turning the name a caller says into the people it might mean.
 *
 * Sending still happens by @username and nothing else. A peer rebuilt from a
 * stored user id would carry an access hash that can go stale, and a stale
 * access hash sends to whoever it points at now, so this module only ranks and
 * names candidates — it never produces something to send to.
 *
 * Kept out of the Durable Object for the reason the login state machine is: the
 * ordering decides who is offered first, and the decisions below decide whether
 * anything is sent at all. Both are worth testing without a socket.
 */

/** Where the object found a candidate, in the order it looks. */
export type ContactSource = "chat" | "contacts" | "search";

/** One person a spoken name might mean. */
export interface ContactCandidate {
  /** The @handle, or null when the account has none and cannot be messaged. */
  username: string | null;
  /** What to call them out loud. */
  title: string;
  source: ContactSource;
}

/** A person as one of the three sources knows them, before any matching. */
export interface NamedPerson {
  title: string;
  username: string | null;
}

/** Past this the question stops being answerable out loud. */
export const MAX_CANDIDATES = 5;

/** Whether a name can be sent to, and what to say when it cannot. */
export type Resolution =
  | { kind: "send"; username: string; title: string }
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
    const key = person.username ? fold(person.username) : `name:${person.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ username: person.username, title: person.title, source });
    if (found.length === MAX_CANDIDATES) break;
  }
  return found;
}

/**
 * One line naming a candidate, and saying when they cannot be messaged.
 *
 * A person with no @username is never dropped from a list: silence about them
 * would read as "they were not found" when the truth is that they were found
 * and Telegram has no way to address them.
 */
export function describeCandidate(person: ContactCandidate): string {
  return person.username
    ? `${person.title} (${person.username})`
    : `${person.title} — no @username, so they cannot be messaged`;
}

/**
 * Whether a spoken name settles on someone that can be sent to.
 *
 * The caller's next word is "yes", so anything other than exactly one person
 * with a handle has to stop here. Choosing between two people would send a
 * private message to the wrong one, and accepting a name with no handle would
 * promise a delivery that Telegram cannot make. The handle returned here is the
 * one read back before anything goes out.
 */
export function resolveSpokenName(spoken: string, people: ContactCandidate[]): Resolution {
  const asked = spoken.trim();

  if (!people.length) {
    return {
      kind: "refuse",
      reason: `Nobody in the caller's Telegram is called "${asked}". Ask them to spell the @username instead.`,
    };
  }

  if (people.length > 1) {
    return {
      kind: "refuse",
      reason:
        `${asked} could be ${people.length} people: ${people.map(describeCandidate).join(", ")}. ` +
        `Ask the caller which one they mean, then prepare the message again with that person's @username.`,
    };
  }

  const only = people[0];
  if (!only.username) {
    return {
      kind: "refuse",
      reason:
        `The only match for "${asked}" is ${only.title}, who has no @username. Telegram needs a ` +
        `handle to send a message, so this person cannot be messaged.`,
    };
  }

  return { kind: "send", username: only.username, title: only.title };
}
