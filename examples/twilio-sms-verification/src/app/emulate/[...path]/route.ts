import { createEmulateHandler } from "@envoy/emulators-adapter-next";
import * as twilio from "@envoy/emulators-twilio";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    twilio: {
      emulator: twilio,
    },
  },
});
