import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the built bundle works when Electron loads
  // dist/index.html over file:// — absolute "/assets/..." paths would resolve
  // against the filesystem root and 404 in a packaged app.
  base: "./",
  server: {
    // Pinned, not incidental: backend/main.py's CORS allowlist only admits
    // localhost:5173, so a reassigned port fails every API call with a CORS
    // error that surfaces in the UI as "Failed to fetch".
    port: 5173,
    strictPort: true,
  },
});
