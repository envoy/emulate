import { createEmulateHandler } from "@envoy/emulators-adapter-next";
import * as resend from "@envoy/emulators-resend";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    resend: {
      emulator: resend,
      seed: {
        domains: [{ name: "example.com" }],
      },
    },
  },
});
