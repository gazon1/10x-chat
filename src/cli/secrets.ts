import type { Readable } from 'node:stream';
import { password } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getSecretStore } from '../secrets.js';

/** The input of the prompt: a pipe (no TTY) or a terminal. */
export type SecretInput = Readable & { isTTY?: boolean };

/**
 * Read the value of a secret.
 *
 * A value must never be an argument of the command: the shell history and the
 * process table would keep it. A piped stdin is read as is, an interactive
 * terminal asks with the echo switched off.
 */
export async function readValue(input: SecretInput = process.stdin): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks)
      .toString('utf-8')
      .replace(/\r?\n$/, '');
  }

  // The prompt of the library: the terminal is switched into the raw mode,
  // the echo is off and the value is never written to the output.
  return password({ message: 'Value (input hidden):' });
}

export function createSecretsCommand(): Command {
  const cmd = new Command('secrets')
    .description('Store credentials (API keys, proxy URLs) outside of the config file')
    .addHelpText(
      'after',
      '\nThe value of a secret is read from stdin or asked for with the echo switched off:\n' +
        '  10x-chat secrets set openai-key\n' +
        '  printf %s "$KEY" | 10x-chat secrets set openai-key\n' +
        '\nThe credentials of the proxy are two secrets of the store:\n' +
        '  10x-chat secrets set proxy.username\n' +
        '  10x-chat secrets set proxy.password\n',
    );

  cmd
    .command('list')
    .description('List the names of the stored secrets (never their values)')
    .action(async () => {
      const store = getSecretStore();
      const names = await store.list();
      console.log(chalk.dim(await store.location()));
      console.log();
      if (names.length === 0) {
        console.log(chalk.dim('No secrets stored.'));
        return;
      }
      for (const name of names) console.log(`  ${name}`);
    });

  cmd
    .command('set')
    .description('Store a secret, replacing an existing one with the same name')
    .argument('<name>', 'Name of the secret')
    .action(async (name: string) => {
      const store = getSecretStore();
      const existed = (await store.list()).includes(name);
      const value = await readValue();
      await store.set(name, value);
      console.log(chalk.green(`✓ ${existed ? 'Replaced' : 'Stored'} secret "${name}"`));
    });

  cmd
    .command('remove')
    .description('Delete a stored secret')
    .argument('<name>', 'Name of the secret')
    .action(async (name: string) => {
      const store = getSecretStore();
      if (!(await store.remove(name))) {
        console.error(chalk.red(`No secret named "${name}"`));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Removed secret "${name}"`));
    });

  return cmd;
}
