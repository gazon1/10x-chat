/**
 * Minimal test proxies for the Camoufox spike.
 *
 * - HTTP proxy: CONNECT tunneling only (enough for https:// targets).
 * - SOCKS5 proxy: CONNECT only, with RFC 1929 username/password auth.
 *
 * Both record every tunnelled target so the spike can prove the browser
 * really went through the proxy.
 */
import net from 'node:net';

export function createHttpProxy({ username, password } = {}) {
  const log = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buf.subarray(0, end).toString();
      const [method, target] = head.split('\r\n')[0].split(' ');
      client.removeListener('data', onData);
      if (method !== 'CONNECT') {
        client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
        return;
      }
      // Basic proxy auth (RFC 7235) when credentials are configured.
      if (username) {
        const auth = head
          .split('\r\n')
          .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
          ?.split(':')
          .slice(1)
          .join(':')
          .trim();
        const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        if (auth !== expected) {
          client.end(
            'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n',
          );
          log.push({ target, status: 407 });
          return;
        }
      }
      const [host, port] = target.split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        log.push({ target, status: 200 });
        upstream.write(buf.subarray(end + 4));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return { server, log };
}

export function createSocks5Proxy({ username, password } = {}) {
  const log = [];
  const server = net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let authUser = null;
    client.on('error', () => {});
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        const methods = [...buf.subarray(2, 2 + nmethods)];
        buf = buf.subarray(2 + nmethods);
        if (username && methods.includes(0x02)) {
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          // No-auth: either the client offered no user/pass method, or the
          // proxy was configured without credentials.
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        stage = 'request';
        if (user !== username || pass !== password) {
          client.end(Buffer.from([0x01, 0x01]));
          log.push({ target: null, status: 'auth-failed', user });
          return;
        }
        authUser = user;
        client.write(Buffer.from([0x01, 0x00]));
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host;
        let offset;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = Array.from(buf.subarray(4, 8)).join('.');
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          offset = 5 + len;
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buf.readUInt16BE(offset);
        buf = buf.subarray(offset + 2);
        stage = 'tunnel';
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          log.push({ target: `${host}:${port}`, status: 'tunneled', auth: authUser });
          if (buf.length) upstream.write(buf);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      }
    });
  });
  return { server, log };
}

export function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
