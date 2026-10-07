import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import config from './config.js';

/**
 * Absichtlich minimaler SMTP-Client - reicht fuer kurze Textbenachrichtigungen
 * und erspart eine Abhaengigkeit. Unterstuetzte Modi:
 *
 *   implicit TLS (Port 465)  -> SMTP_SECURE=ssl
 *   STARTTLS      (Port 587) -> SMTP_SECURE=starttls   (Standard)
 *   kein TLS                 -> SMTP_SECURE=plain      (nur im eigenen LAN)
 */

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.onLine = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._fail(new Error('Verbindung wurde geschlossen')));
  }

  _feed(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (this.onLine) this.onLine(line);
    }
  }

  _fail(err) {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
    if (this.onLine) {
      const cb = this.onLine;
      this.onLine = null;
      cb(null, err);
    }
  }

  /** Liest eine komplette SMTP-Antwort inkl. mehrzeiliger Fortsetzungen. */
  readReply() {
    return new Promise((resolve, reject) => {
      const lines = [];
      this.waiters.push({ resolve, reject });
      const settle = (value) => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(value);
      };
      const fail = (err) => {
        const i = this.waiters.findIndex((w) => w.reject === reject);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(err);
      };

      this.onLine = (line, err) => {
        if (err) {
          this.onLine = null;
          fail(err);
          return;
        }
        lines.push(line);
        // "250-text" = weitere Zeilen folgen, "250 text" = Ende
        if (line.length >= 4 && line[3] === '-') return;
        this.onLine = null;
        settle(lines);
      };
    });
  }

  send(command) {
    return new Promise((resolve, reject) => {
      this.socket.write(`${command}\r\n`, (err) => (err ? reject(err) : resolve()));
    });
  }
}

async function connect() {
  const { host, port, mode } = config.smtp;
  const secure = mode === 'ssl' || mode === 'tls' || mode === 'implicit';
  if (secure) {
    return await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host, port, servername: host, rejectUnauthorized: true },
        () => resolve(socket)
      );
      socket.once('error', reject);
      socket.setTimeout(20000, () => socket.destroy(new Error('SMTP-Timeout')));
    });
  }
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(20000, () => socket.destroy(new Error('SMTP-Timeout')));
  });
}

async function upgradeToTls(session) {
  const { host } = config.smtp;
  const socket = await new Promise((resolve, reject) => {
    const tlsSocket = tls.connect(
      { socket: session.socket, servername: host, rejectUnauthorized: true },
      () => resolve(tlsSocket)
    );
    tlsSocket.once('error', reject);
  });
  socket.setTimeout(20000, () => socket.destroy(new Error('SMTP-Timeout')));
  return new SmtpSession(socket);
}

function encodeHeaderValue(value) {
  // eslint-disable-next-line no-control-regex
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@sharedrive>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
  ];
  const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function expectedCode(lines, code) {
  const line = lines[lines.length - 1] || '';
  const actual = Number.parseInt(line.slice(0, 3), 10);
  if (actual !== code) {
    throw new Error(`SMTP: erwartet ${code}, erhalten: ${line.trim()}`);
  }
}

export async function sendMail({ to, subject, text }) {
  const { from, user, pass, mode, host } = config.smtp;
  if (!host) throw new Error('SMTP_HOST ist nicht gesetzt');

  const useStartTls = mode === 'starttls' || mode === 'tls-starttls';
  let session = await connect();

  try {
    const greeting = await session.readReply();
    expectedCode(greeting, 220);

    const ehloName = 'sharedrive.local';
    let ehlo = await session.send(`EHLO ${ehloName}`).then(() => session.readReply());
    if (Number.parseInt((ehlo[ehlo.length - 1] || '').slice(0, 3), 10) !== 250) {
      await session.send('HELO sharedrive.local');
      await session.readReply();
    }

    if (useStartTls) {
      await session.send('STARTTLS');
      const ready = await session.readReply();
      expectedCode(ready, 220);
      session.socket.removeAllListeners('data');
      session.onLine = null;
      session = await upgradeToTls(session);
      const afterTls = await session.readReply();
      if (afterTls.length === 0) {
        // TLS-Handshake liefert kein SMTP-Greeting - erneut EHLO senden
      }
      await session.send(`EHLO ${ehloName}`);
      await session.readReply();
    }

    if (user) {
      // AUTH PLAIN mit einem Kommando ist am robustesten
      const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
      await session.send(`AUTH PLAIN ${token}`);
      let reply = await session.readReply();
      if (Number.parseInt((reply[reply.length - 1] || '').slice(0, 3), 10) !== 235) {
        // Fallback: AUTH LOGIN
        await session.send('AUTH LOGIN');
        reply = await session.readReply();
        expectedCode(reply, 334);
        await session.send(Buffer.from(user, 'utf8').toString('base64'));
        reply = await session.readReply();
        expectedCode(reply, 334);
        await session.send(Buffer.from(pass, 'utf8').toString('base64'));
        reply = await session.readReply();
        expectedCode(reply, 235);
      }
    }

    await session.send(`MAIL FROM:<${from || user}>`);
    expectedCode(await session.readReply(), 250);
    await session.send(`RCPT TO:<${to}>`);
    const rcpt = await session.readReply();
    expectedCode(rcpt, 250);
    await session.send('DATA');
    expectedCode(await session.readReply(), 354);
    await session.send(buildMessage({ from: from || user, to, subject, text }));
    await session.send('.');
    expectedCode(await session.readReply(), 250);
    await session.send('QUIT').catch(() => {});
    return { sent: true };
  } finally {
    session.socket.destroy();
  }
}
