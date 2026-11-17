/**
 * The tests must not touch the secrets of the user.
 *
 * The file store is forced for every test — the keyring of the machine would
 * otherwise be the store of the tests. The keyring itself is exercised with a
 * fake backend (and with the real one in a single test that skips itself when
 * the machine has no secret service).
 */
process.env.TEN_X_CHAT_CREDENTIAL_STORAGE = 'file';
