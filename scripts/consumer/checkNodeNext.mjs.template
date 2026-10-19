import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const entries = new Set();
for (const name of ["alchemy", "cli", "core", "foldkit", "js", "react", "server", "test"]) {
  const specifier = `@confect/${name}`;
  const directory = dirname(fileURLToPath(import.meta.resolve(`${specifier}/package.json`)));
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
    if (!target || typeof target !== "object" || !target.types) continue;
    if (!entry.includes("*")) {
      entries.add(entry === "." ? specifier : `${specifier}/${entry.slice(2)}`);
      continue;
    }
    for (const file of globSync(target.types.replaceAll("*", "**/*"), { cwd: directory })) {
      const subpath = relative(resolve(directory, "dist"), resolve(directory, file)).replaceAll("\\", "/").replace(/\.d\.ts$/, "");
      const candidate = `${specifier}/${subpath}`;
      try {
        import.meta.resolve(candidate);
        entries.add(candidate);
      } catch (error) {
        if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      }
    }
  }
}
mkdirSync(".nodeNext", { recursive: true });
const check = (name, specifiers, strictNullChecks) => {
  const file = `${name}.ts`;
  writeFileSync(`.nodeNext/${file}`, specifiers.map((entry, index) => `export * as entry${index} from ${JSON.stringify(entry)};`).join("\n") + "\n");
  writeFileSync(`.nodeNext/${name}.json`, JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      strictNullChecks,
      exactOptionalPropertyTypes: strictNullChecks,
      skipLibCheck: false,
      noEmit: true,
      types: ["node", "react"],
    },
    files: [file],
  }, null, 2) + "\n");
  console.log(`Checking ${specifiers.length} installed public entries under NodeNext with skipLibCheck: false, strictNullChecks: ${strictNullChecks}`);
  execFileSync("pnpm", ["exec", "tsc", "-p", `.nodeNext/${name}.json`, "--pretty", "false"], { stdio: "inherit" });
};
const all = [...entries].sort();
// Alchemy beta.82 conflicts with exact optional types, while Effect requires them.
check("all", all, false);
check("strict", all.filter((entry) => !entry.startsWith("@confect/alchemy")), true);
