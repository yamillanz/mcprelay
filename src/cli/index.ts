#!/usr/bin/env node
import { runCli, type CliIO } from './run.js';

const io: CliIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

process.exitCode = await runCli(process.argv.slice(2), io);
