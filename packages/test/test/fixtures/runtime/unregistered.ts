// Convex never registers a TypeScript file without a line that starts with
// an import or an export, so nothing loads this one.
throw new Error("the kernel loaded a file Convex never registers");
