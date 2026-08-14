import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/openflights-vite-react/",
  plugins: [react()],
});
