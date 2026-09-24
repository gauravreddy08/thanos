// Copy this file to config.js and add your keys. config.js is gitignored.
self.CONFIG = {
  TYPESAFE_API_KEY: "", // required: Jev decides what stays on the page (typesafe.ai)
  OPENAI_API_KEY: "", // only for the OpenAI voice engines below

  // Voice engine: "chrome" (built in, no key), "whisper-1", "gpt-4o-mini-transcribe",
  // or "gpt-4o-transcribe" (most accurate).
  VOICE: "gpt-4o-transcribe",

  // "tree" keeps cards whole and digs into prose; "sentences" scores every sentence alone.
  ENGINE: "tree",
};
