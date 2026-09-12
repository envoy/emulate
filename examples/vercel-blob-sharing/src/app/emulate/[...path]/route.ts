import { createEmulateHandler } from "@envoy/emulators-adapter-next";
import * as vercel from "@envoy/emulators-vercel";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    vercel: {
      emulator: vercel,
    },
  },
});
