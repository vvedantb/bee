// A stable key for "the same meeting" across days, built only from what Outlook or the window title already shows.

const REPLY_PREFIX = /^(?:(?:re|fw|fwd|updated|canceled|cancelled)\s*:\s*)+/i;

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** "Re: Weekly Sync – Platform" → "weekly sync platform". Case, accents, punctuation and reply prefixes do not matter. */
export function normaliseSubject(subject: string): string {
  return fold(subject.replace(/\s*[|–—-]\s*Microsoft Teams\b.*$/i, "").trim().replace(REPLY_PREFIX, ""))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Smith, Alice <alice@x.com>" → "smith alice". Used for organiser and attendee matching. */
export function normaliseName(name: string): string {
  return fold(name.replace(/<[^>]*>|\([^)]*\)/g, " "))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * subject@organiser, plus "#r" for a recurring series. The subject part alone is `normaliseSubject`, which past records also
 * match on, so a one-off title-only reading still finds the series. No Microsoft meeting id is used.
 */
export function meetingKey(args: { subject: string; organizer?: string; recurring?: boolean }): string {
  const subject = normaliseSubject(args.subject);
  const organizer = normaliseName(args.organizer ?? "");
  return `${subject}@${organizer || "-"}${args.recurring ? "#r" : ""}`;
}
