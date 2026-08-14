import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const referencePath = path.join(repoRoot, "i18n", "en-US.json");
const scriptArgs = process.argv.slice(2);
const localeName = scriptArgs.find((arg) => !arg.startsWith("--")) || "vi-VN";
const thresholdArg = scriptArgs.find((arg) => arg.startsWith("--threshold="));
const threshold = thresholdArg ? Number(thresholdArg.split("=", 2)[1]) : 0.9;
const localePath = path.join(repoRoot, "i18n", `${localeName}.json`);

const reference = JSON.parse(await fs.readFile(referencePath, "utf8"));
const locale = JSON.parse(await fs.readFile(localePath, "utf8"));

function flatten(value, prefix = "", output = new Map()) {
  if (typeof value === "string") {
    output.set(prefix, value);
    return output;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return output;
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

const referenceValues = flatten(reference);
const localeValues = flatten(locale);
const untranslated = [];
let translated = 0;

for (const [key, referenceValue] of referenceValues) {
  const value = localeValues.get(key);
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value === referenceValue
  ) {
    untranslated.push(key);
  } else {
    translated += 1;
  }
}

const total = referenceValues.size;
const ratio = total === 0 ? 0 : translated / total;
const result = {
  locale: localeName,
  total,
  translated,
  untranslated: untranslated.length,
  coverage: Number(ratio.toFixed(4)),
  threshold,
  pass: ratio >= threshold,
  untranslated_sample: untranslated.slice(0, 20),
};

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
