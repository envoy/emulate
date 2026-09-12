import { withEmulate } from "@envoy/emulators-adapter-nuxt";

// `withEmulate` wraps the config so Nitro traces `@envoy/emulators-core` assets
// (the emulator UI fonts) into production builds.
export default defineNuxtConfig(
  withEmulate({
    compatibilityDate: "2025-07-01",
    devtools: { enabled: false },
    modules: ["@nuxt/eslint"],
  }),
);
