// Ladle's own Vite config: Tailwind generates the utilities the atoms use (.ladle/ladle.css is the entry).
import tailwindcss from "@tailwindcss/vite";

export default { plugins: [tailwindcss()] };
