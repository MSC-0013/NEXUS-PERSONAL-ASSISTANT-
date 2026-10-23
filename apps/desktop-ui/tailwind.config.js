import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{js,ts,jsx,tsx}")
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        nexus: {
          bg: "#0B0F17",
          surface: "#121824",
          card: "#161F30",
          border: "#1E2A42",
          accent: "#38BDF8",
          purple: "#8B5CF6",
          violet: "#6366F1",
          text: "#E2E8F0",
          muted: "#94A3B8"
        }
      },
      animation: {
        "gradient-flow": "gradientFlow 8s ease infinite",
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow": "glow 4s ease-in-out infinite alternate"
      },
      keyframes: {
        gradientFlow: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" }
        },
        glow: {
          "0%": { boxShadow: "0 0 15px rgba(56, 189, 248, 0.2)" },
          "100%": { boxShadow: "0 0 25px rgba(139, 92, 246, 0.3)" }
        }
      }
    }
  },
  plugins: []
};
