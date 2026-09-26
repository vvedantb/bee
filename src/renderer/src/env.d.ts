import type { BeeApi } from "../../preload";
import type { RecognitionConstructor } from "./speech";

declare global {
  interface Window {
    bee: BeeApi;
    // Web Speech API: unprefixed in newer Chromium, webkit-prefixed in older builds. Not in lib.dom.
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}
