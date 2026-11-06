Bee for Linux: independent test build
=====================================

Ship three files beside the build: this one, linux-independent-test.md (in the
repository: docs/) and chrome-form.html (in the repository: test/fixtures/).
Read linux-independent-test.md before testing. In short:

1. Run from a terminal inside your graphical desktop session. Bee's computer
   use and app opening need the AT-SPI accessibility bus on the session D-Bus.
   Check it first:

     AD_STATE=$(mktemp -d)
     AGENT_DESKTOP_HOME="$AD_STATE" ./resources/agent-desktop/agent-desktop status

   Healthy: "accessibility":{"state":"granted"}. Denied: no bus; only opening
   web pages will work.

2. Always use a new, empty profile folder. Never your everyday profile
   (normally ~/.config/Bee):

     PROFILE=$(mktemp -d /tmp/bee-test-profile.XXXXXX)
     ./bee --user-data-dir="$PROFILE"
   or
     BEE_USER_DATA_DIR="$PROFILE" ./bee

   Do not delete Singleton* files from a profile a running Bee owns. Start
   with a new folder instead.

3. Start Chrome with page accessibility on (quit all Chrome windows first):

     google-chrome --force-renderer-accessibility chrome-form.html

4. In Bee: Live tab -> Manual test -> "Talk to Bee (typed)". Type requests
   that start with "Bee," (for example: Bee, open Chrome). This goes through
   the same wake word and request path as a spoken phrase after
   speech-to-text. It does not test the microphone or speech-to-text.
   "Simulate meeting line" is different: it adds a meeting line and never
   wakes Bee.

5. Logs: $PROFILE/logs/bee-*.jsonl (JSON Lines). They hold your requests and
   screen text: share timing fields only, never raw logs or keys.

Limits: no Teams audio on Linux; focus_window needs X11; Chromium pages need
--force-renderer-accessibility; identical controls in one window cannot be
told apart. Unit tests are not desktop proof: report what you observe.
