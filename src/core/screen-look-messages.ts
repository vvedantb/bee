// The text the screen-look tool returns to the model. Kept in a leaf module so both
// screen-look.ts and computer-tools.ts can read them without importing each other.

export const LOOK_UNAVAILABLE = "Bee cannot look at the screen on this computer. Answer from the window's text, or say Bee cannot see it.";
export const LOOK_PERMISSION =
  "Bee needs Screen Recording to look at the screen. Tell the user in one line to turn on Bee in System Settings > Privacy & Security > Screen Recording (Bee's Settings has a button for it), then ask again.";
export const LOOK_OFF_LIMITS = "Bee will not take a picture of that window: it never captures Bee itself, password managers, terminals or system settings. Say so in one line.";
export const LOOK_NO_WINDOW = "Bee cannot tell which window is at the front, so it took no picture.";
export const LOOK_FAILED = "Bee could not take a picture of the screen just now.";
