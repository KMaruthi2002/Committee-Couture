import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vonage needs https for camera access on anything other than localhost.
    // If you demo from a phone or another machine by IP, run `vite --https`
    // or tunnel it. localhost is exempt, so two laptops on the same machine
    // are fine without this.
  },
});
