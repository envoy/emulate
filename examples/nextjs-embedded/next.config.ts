import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@envoy/emulators-adapter-next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
};

export default withEmulate(nextConfig);
