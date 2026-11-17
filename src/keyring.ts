/**
 * The adapter of the system keyring.
 *
 * Linux only for now: the store is the Secret Service (`gnome-keyring`,
 * `kwallet`, ...). The kernel keyring is not used — it does not survive a
 * reboot and it cannot enumerate its entries, and the store needs both.
 */

/** The operations of the keyring that the secrets store needs. */
export interface KeyringBackend {
  /** The names of the entries of our service (never their values). */
  list(): Promise<string[]>;
  /** The value of an entry, or `undefined` when it is not stored. */
  get(name: string): Promise<string | undefined>;
  /** Store an entry, replacing an existing one with the same name. */
  set(name: string, value: string): Promise<void>;
  /** Delete an entry. Returns `false` when it was not stored. */
  remove(name: string): Promise<boolean>;
}

/** The service our entries live in. */
export const KEYRING_SERVICE = '10x-chat-secrets';

/**
 * Create the backend of the Secret Service.
 *
 * Throws when the Secret Service is not reachable: the entries are pinned to
 * `secret-service`, so the native module does not fall back to the kernel
 * keyring — it fails instead. The constructor of an entry is the probe.
 *
 * @param service the service the entries live in (the tests use their own)
 */
export async function createSecretServiceBackend(
  service: string = KEYRING_SERVICE,
): Promise<KeyringBackend> {
  const { AsyncEntry, findCredentialsAsync } = await import('@napi-rs/keyring');
  const options = { linux: { store: 'secret-service' } } as const;

  // The probe: it throws when the Secret Service is not reachable.
  new AsyncEntry(service, 'probe', options);

  const entry = (name: string) => new AsyncEntry(service, name, options);

  return {
    async list() {
      const found = await findCredentialsAsync(service);
      return found.map((credential) => credential.account);
    },
    async get(name) {
      return (await entry(name).getPassword()) ?? undefined;
    },
    async set(name, value) {
      await entry(name).setPassword(value);
    },
    async remove(name) {
      return entry(name).deletePassword();
    },
  };
}
