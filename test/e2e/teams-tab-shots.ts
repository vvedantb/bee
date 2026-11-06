// Static shots of the Teams tab (TeamSection), styled by the real styles.css. harness-main.ts loads this page once per ?shot=…
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamSection } from "../../src/renderer/src/Teams";
import type { BeeState } from "../../src/renderer/src/store";
import type { TeamsView } from "../../src/shared/ipc";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const me = { userId: "u1", displayName: "Vedant" };
const base: TeamsView = {
  relayConfigured: true,
  relayError: null,
  notice: null,
  me,
  team: null,
  pendingInvite: null,
  detection: { inMeeting: false, raw: false, epoch: 0, source: "none" },
  prompt: null,
  room: null,
  roster: [],
  merge: null,
  shareMuted: false,
};
const joined: TeamsView = {
  ...base,
  team: { id: "t1", name: "Evalucom", inviteCode: "BEE-7Q4K", inviteLink: "bee://team/BEE-7Q4K", members: [me, { userId: "u2", displayName: "Priya Shah" }, { userId: "u3", displayName: "Sam Lee" }] },
};
const section = (teams: TeamsView) => renderToStaticMarkup(createElement(TeamSection, { state: { teams, teamsBusy: false, teamsError: null } as unknown as BeeState }));

const shot = new URLSearchParams(location.search).get("shot") ?? "settings-teams-tab";
const states: Record<string, string> = {
  "settings-teams-tab": panelPage("teams", section(joined)),
  "settings-teams-tab-join": panelPage("teams", section(base)),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
