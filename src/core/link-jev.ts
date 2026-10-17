import { experimental_evaluate, type Experimental_EvaluationModel, type Experimental_EvaluationQuestion } from "ai";
import type { LinkCandidate, LinkDecision } from "./link-rank";

// Standard tier, not flex: this runs inside a 2 s budget. Asks Jev (Gateway evaluation API, as in jev.ts) whether a link helps and which URL fits. Throws on failure; link-rank fails open.
//
// state: { transcript } — the current turn's text.
// questions: "suggest" (is a link to the site useful now?) and "u0", "u1", … (does this exact page fit?), each scored 0–3.

export const LINK_LEVELS = [
  "No: a link would distract.",
  "Unlikely: the site is only mentioned in passing.",
  "Yes: a link would help.",
  "Definitely: the speaker wants this page or site now.",
];
export const PAGE_LEVELS = [
  "Wrong page: unrelated to what was said.",
  "Same site, but not the page being discussed.",
  "Likely the page being discussed.",
  "Exactly the page being discussed.",
];

export function buildLinkRequest(turn: string, candidate: LinkCandidate) {
  const questions: Record<string, Experimental_EvaluationQuestion> = {
    suggest: {
      type: "score",
      instructions: { task: `Rate whether showing a link to ${candidate.domain} would help right now.`, site: candidate.domain },
      criteria: LINK_LEVELS,
    },
  };
  candidate.urls.forEach((item, index) => {
    questions[`u${index}`] = {
      type: "score",
      instructions: { task: "Rate how well this exact page matches what is being discussed.", pageUrl: item.url, pageTitle: item.title },
      criteria: PAGE_LEVELS,
    };
  });
  return { state: { transcript: turn }, questions };
}

export function parseLinkDecision(candidate: LinkCandidate, answers: Readonly<Record<string, { type: string; score?: number }>>): LinkDecision {
  const score = (key: string): number | null => {
    const answer = answers[key];
    return answer?.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : null;
  };
  return { suggest: score("suggest"), urls: candidate.urls.map((_item, index) => score(`u${index}`)) };
}

export async function decideWithJev(args: {
  model: Experimental_EvaluationModel;
  turn: string;
  candidate: LinkCandidate;
  signal?: AbortSignal;
}): Promise<LinkDecision> {
  const request = buildLinkRequest(args.turn, args.candidate);
  const result = await experimental_evaluate({
    model: args.model,
    state: request.state,
    questions: request.questions,
    maxRetries: 0,
    abortSignal: args.signal,
  });
  return parseLinkDecision(args.candidate, result.answers as Record<string, { type: string; score?: number }>);
}
