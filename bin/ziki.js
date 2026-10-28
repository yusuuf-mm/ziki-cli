#!/usr/bin/env node
import { main } from '../src/cli.js';
import { sanitizeText } from '../src/sanitize.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ziki: ${sanitizeText(message)}\n`);
  process.exitCode = 1;
}
