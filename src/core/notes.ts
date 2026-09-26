export type NoteFile = { name: string; content: string };

export type Snippet = { id: string; title: string; text: string };

const MAX_SNIPPET_CHARS = 600;

function truncate(text: string): string {
  return text.length <= MAX_SNIPPET_CHARS ? text : `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

/**
 * Split a markdown note into retrievable snippets: one per `## ` section,
 * or the whole body when the note has no sections.
 */
export function chunkNote(file: NoteFile): Snippet[] {
  const lines = file.content.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.find((line) => line.startsWith("# "));
  const title = heading ? heading.slice(2).trim() : file.name.replace(/\.md$/i, "");

  const sections: { name: string | null; body: string[] }[] = [{ name: null, body: [] }];
  for (const line of lines) {
    if (line === heading) continue;
    if (line.startsWith("## ")) {
      sections.push({ name: line.slice(3).trim(), body: [] });
      continue;
    }
    sections[sections.length - 1]?.body.push(line);
  }

  return sections
    .map((section, index) => ({
      id: `${file.name}#${index}`,
      title: section.name ? `${title} › ${section.name}` : title,
      text: truncate(section.body.join("\n").trim()),
    }))
    .filter((snippet) => snippet.text.length > 0);
}

export function chunkNotes(files: NoteFile[]): Snippet[] {
  return files.flatMap(chunkNote);
}

// Written to userData/notes on first launch. Fictional examples only.
export const SEED_NOTES: NoteFile[] = [
  {
    name: "acme-renewal.md",
    content: `# Acme renewal

## Pricing
Acme is on the Growth plan at £18,000 per year. In Q2 we agreed a 10% loyalty discount if they renew before 31 October.
Do not offer more than a 15% total discount without finance sign-off.

## Risks
Their operations lead flagged slow support response times in August. We have since added a named support contact.

## Next steps
Send the renewal quote and the support SLA summary after the call.
`,
  },
  {
    name: "hiring-backend.md",
    content: `# Backend engineer hiring

## Role
Senior backend engineer, TypeScript and Postgres. Hybrid, two days in the office.

## Interview loop
Screen, take-home (max 3 hours), system design, values chat. Aim to give feedback within 48 hours.

## Salary band
Band is £85,000 to £100,000. Do not share the top of the band in the first call.
`,
  },
  {
    name: "q4-roadmap.md",
    content: `# Q4 product roadmap

## Themes
Offline mode for the mobile app, SSO for enterprise customers, and faster search.

## Dates
SSO beta ships 18 November. Offline mode slips to January because of the sync rewrite.

## Open questions
Whether to charge extra for SSO or include it in the Enterprise plan.
`,
  },
  {
    name: "meeting-habits.md",
    content: `# My meeting habits

Summarise decisions and owners in the last five minutes.
If a topic runs over ten minutes without a decision, suggest a follow-up call.
Ask quiet participants for their view before closing a topic.
`,
  },
];
