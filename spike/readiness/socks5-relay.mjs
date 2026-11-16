/**
 * EXPERIMENT ONLY — minimal local SOCKS5 adapter (issue #13, §2).
 *
 * The browser speaks plain SOCKS5 (no credentials) to this relay; the relay
 * authenticates against the upstream SOCKS5 proxy with RFC 1929 user/pass and
 * forwards the tunnel. This is NOT a supported Camoufox path and NOT a
 * production candidate — it exists to measure the operational cost of the
 * only workaround we could find for the missing SOCKS5-auth support.
 */
import net from 'node:net';

function readExactly(socket, count) {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      if (socket.readableLength < count) return;
      socket.off('readable', onReadable);
      socket.off('error', onError);
      resolve(socket.read(count));
    };
    const onError = (err) => {
      socket.off('readable', onReadable);
      reject(err);
    };
    socket.on('readable', onReadable);
    socket.on('error', onError);
    onReadable();
  });
}

async function upstreamHandshake(socket, { host, port, username, password }) {
  // greeting: offer "username/password" only
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const method = await readExactly(socket, 2);
  if (method[0] !== 0x05 || method[1] !== 0x02) {
    throw new Error(`upstream refused user/pass auth (method=${method[1]})`);
  }
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
  const authReply = await readExactly(socket, 2);
  if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
    throw new Error('upstream auth failed');
  }
}

async function upstreamConnect(socket, target) {
  const { host, port } = target;
  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  let request;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x01]),
      Buffer.from(host.split('.').map(Number)),
      portBytes,
    ]);
  } else {
    const name = Buffer.from(host, 'utf8');
    request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      portBytes,
    ]);
  }
  socket.write(request);
  const head = await readExactly(socket, 4);
  if (head[1] !== 0x00) throw new Error(`upstream connect failed (code=${head[1]})`);
  // drain the bound address
  const atyp = head[3];
  if (atyp === 0x01) await readExactly(socket, 4);
  else if (atyp === 0x03) await readExactly(socket, 1).then((b) => readExactly(socket, b[0]));
  else if (atyp === 0x04) await readExactly(socket, 16);
  await readExactly(socket, 2);
}

/**
 * @param {object} upstream { host, port, username, password }
 */
export function createSocks5Relay(upstream) {
  const log = [];
  const server = net.createServer((client) => {
    client.on('error', () => {});
    readExactly(client, 2).then(async (head) => {
      const nmethods = head[1];
      const methods = await readExactly(client, nmethods);
      client.write(Buffer.from([0x05, 0x00])); // no auth towards the browser
      const req = await readExactly(client, 4);
      const atyp = req[3];
      let host;
      if (atyp === 0x01) {
        host = (await readExactly(client, 4)).join('.');
      } else if (atyp === 0x03) {
        const len = (await readExactly(client, 1))[0];
        host = (await readExactly(client, len)).toString();
      } else {
        host = await readExactly(client, 16).then((b) => b.join(':'));
      }
      const port = (await readExactly(client, 2)).readUInt16BE(0);
      const target = { host, port };

      const up = net.connect(upstream.port, upstream.host);
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      await new Promise((resolve, reject) => {
        up.once('connect', resolve);
        up.once('error', reject);
      });
      await upstreamHandshake(up, upstream);
      await upstreamConnect(up, target);
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      log.push({ target: `${host}:${port}`, status: 'relayed' });
      up.pipe(client);
      client.pipe(up);
    })
      .catch((err) => {
        log.push({ target: null, status: 'error', detail: String(err && err.message) });
        client.destroy();
      });
  });
  return { server, log };
}
