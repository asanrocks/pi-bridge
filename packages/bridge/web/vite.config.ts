import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), react()],
	server: {
		host: "127.0.0.1",
		port: 5173,
	},
	build: {
		outDir: "../dist/web",
		emptyOutDir: true,
		sourcemap: false,
		minify: false,
	},
});
