const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const rawNodeEnv = process.env.NODE_ENV || "development";
const nodeEnv = rawNodeEnv.trim().toLowerCase() || "development";
process.env.NODE_ENV = nodeEnv;

const projectRoot = path.resolve(__dirname, "..", "..");

// Allow explicit override, otherwise load the environment-specific file first.
const fileCandidates = process.env.DOTENV_CONFIG_PATH
  ? [process.env.DOTENV_CONFIG_PATH]
  : [
      `.env.${nodeEnv}`,
      nodeEnv === "production" ? ".ev.production" : null,
      ".env",
    ].filter(Boolean);

let loadedFile = null;
for (const filePath of fileCandidates) {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  if (!fs.existsSync(resolvedPath)) {
    continue;
  }

  const result = dotenv.config({ path: resolvedPath, override: false });
  if (!result.error) {
    loadedFile = resolvedPath;
    break;
  }
}

if (loadedFile) {
  console.log(`Loaded env file: ${loadedFile}`);
} else {
  console.warn(
    `No env file found for NODE_ENV=${nodeEnv}. Checked: ${fileCandidates.join(", ")}`,
  );
}
