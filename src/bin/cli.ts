#!/usr/bin/env node

import chalk from 'chalk';
import { Command } from 'commander';
import { stopDaemon } from '../browser/daemon.js';
import { createChatCommand } from '../cli/chat.js';
import { createConfigCommand } from '../cli/config.js';
import { createDaemonCommand } from '../cli/daemon.js';
import { createDelegateCommand } from '../cli/delegate.js';
import { createHistoryCommand } from '../cli/history.js';
import { createImageCommand } from '../cli/image.js';
import { createKnowledgeCommand } from '../cli/knowledge.js';
import { createLoginCommand } from '../cli/login.js';
import { createMigrateCommand } from '../cli/migrate.js';
import { createResearchCommand } from '../cli/research.js';
import { createReviewCommand } from '../cli/review.js';
import { createSecretsCommand } from '../cli/secrets.js';
import { createSkillCommand } from '../cli/skill.js';
import { createSessionCommand, createStatusCommand } from '../cli/status.js';
import { getPackageVersion } from '../version.js';

// Ensure the browser daemon is stopped on unexpected exit (Ctrl+C, crash, etc.)
// so Chrome for Testing doesn't linger in the dock after the CLI finishes.
const cleanupAndExit = (code: number) => {
  stopDaemon()
    .catch(() => {})
    .finally(() => process.exit(code));
};
process.on('SIGINT', () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(143));
process.on('uncaughtException', (err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  cleanupAndExit(1);
});

// The version of the installed package (works for both src and dist)
const version = getPackageVersion();

const program = new Command();

program
  .name('10x-chat')
  .description(
    'Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, DeepSeek) via browser automation',
  )
  .version(version);

program.addCommand(createLoginCommand());
program.addCommand(createChatCommand());
program.addCommand(createDelegateCommand());
program.addCommand(createHistoryCommand());
program.addCommand(createImageCommand());
program.addCommand(createKnowledgeCommand());
program.addCommand(createResearchCommand());
program.addCommand(createReviewCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSecretsCommand());
program.addCommand(createSkillCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createDaemonCommand());

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
