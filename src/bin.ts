#!/usr/bin/env node
// The `bin` entry. Everything testable is in cli.ts; this only wires it to the
// real process. The version is read from package.json at run time so the CLI
// cannot report a different version from the one npm installed.

import { readFileSync } from "node:fs";

import { main } from "./cli.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const color =
  Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";

main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color,
  version,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Internal error: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 3;
  },
);
