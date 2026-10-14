import { readFileSync } from "node:fs";

const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("name" in manifest) ||
  !("version" in manifest) ||
  typeof manifest.name !== "string" ||
  typeof manifest.version !== "string"
) {
  throw new Error("Package metadata is invalid.");
}

export const SERVER_NAME = manifest.name;
export const SERVER_VERSION = manifest.version;
