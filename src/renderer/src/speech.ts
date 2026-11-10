// The phrase segmenter, WAV encoder and speech session live in core/speech.ts, so main (call audio) and the
// renderer (the mic) share one copy. Re-exported here so the store, its tests and the E2E pages keep their imports.
export * from "../../core/speech";
