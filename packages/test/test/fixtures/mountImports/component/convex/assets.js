// Imports Vite turns into a string, a URL or a loader.
import logo from "../logo.png";
import wasm from "../empty.wasm?init";
import text from "../text.txt?raw";
import url from "../text.txt?url";

export const values = { logo, text, url, wasm };
