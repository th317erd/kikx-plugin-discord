'use strict';

// =============================================================================
// Discord gateway client — outbound websocket, no dependencies
// =============================================================================
// Interactions arrive over HTTP, but ordinary channel messages only arrive over the
// gateway websocket. This is that client.
//
// Two rules shape the design:
//
//   1. It never claims a state it has not reached. There is no `connected = true`
//      until Discord's READY arrives; a socket that opened is not a session.
//   2. Every dependency is injected (WebSocket, fetch, timers, clock) so the protocol
//      can be tested against a fake socket instead of the live network. The real
//      defaults are Node's globals, so production wiring passes nothing.
//
// Protocol reference: https://discord.com/developers/docs/topics/gateway
// =============================================================================

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const GATEWAY_REST_URL = 'https://discord.com/api/v10/gateway';

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// Bit values from the intents table.
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15,
};

// Read messages in guilds and DMs, including their text. MESSAGE_CONTENT is a
// privileged intent: it must also be switched on in the Discord developer portal, or
// Discord delivers every message with an empty `content` and no error. That failure is
// silent, so the dispatcher reports it explicitly rather than looking healthy.
export const DEFAULT_INTENTS =
  INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT;

const MAX_RECONNECT_DELAY_MS = 30_000;

// A tiny indirection over setTimeout so tests advance time instead of sleeping.
function defaultSetTimeout(fn, ms) {
  let handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export class DiscordGateway {
  // options:
  //   token            bot token, required
  //   intents          bitmask, defaults to DEFAULT_INTENTS
  //   onDispatch       async (eventType, data) => void — called for every op 0 that is
  //                    not READY. Errors are caught and logged, never fatal.
  //   onReady          async ({ user, sessionID }) => void
  //   log              (level, message) => void, level is 'info' | 'warn' | 'error'
  //   WebSocketImpl    constructor, defaults to globalThis.WebSocket
  //   fetchImpl        defaults to globalThis.fetch
  //   setTimeoutImpl   defaults to a real timer
  //   clearTimeoutImpl defaults to clearTimeout
  //   random           () => number, injected so backoff jitter is deterministic
  constructor(options = {}) {
    if (!options.token)
      throw new Error('DiscordGateway requires a bot token');
    if (!options.intents)
      options = { ...options, intents: DEFAULT_INTENTS };

    this.token = options.token;
    this.intents = options.intents;
    this.onDispatch = options.onDispatch || (() => {});
    this.onReady = options.onReady || (() => {});
    this.log = options.log || (() => {});

    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.setTimeoutImpl = options.setTimeoutImpl || defaultSetTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    this.random = options.random || Math.random;

    if (typeof this.WebSocketImpl !== 'function')
      throw new Error('DiscordGateway requires a WebSocket implementation (Node 22+ provides globalThis.WebSocket)');
    if (typeof this.fetchImpl !== 'function')
      throw new Error('DiscordGateway requires fetch');

    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.heartbeatIntervalMS = null;
    this.awaitingHeartbeatAck = false;
    this.sequence = null;
    this.sessionID = null;
    this.resumeURL = null;
    this.userId = null;
    this.attempt = 0;
    this.stopped = false;
    this.ready = false;
  }

  // Resolve the gateway endpoint through REST first. Discord hands out a per-session
  // `resume_gateway_url` on READY, and resuming against the wrong shard host is a
  // silent failure, so the REST URL is the only starting point.
  async resolveGatewayURL() {
    let res = await this.fetchImpl(GATEWAY_REST_URL, {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!res.ok) {
      // 401 here means the token itself is wrong, which is worth naming precisely:
      // a token problem reported as "gateway offline" sends the operator hunting in
      // the wrong place.
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_e) { detail = ''; }
      throw new Error(`gateway url request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    let body = await res.json();
    if (!body || typeof body.url !== 'string')
      throw new Error('gateway url request returned no url');
    return `${body.url}/?v=10&encoding=json`;
  }

  async start() {
    this.stopped = false;
    let url;
    try {
      url = this.resumeURL && this.sessionID
        ? `${this.resumeURL}/?v=10&encoding=json`
        : await this.resolveGatewayURL();
    } catch (error) {
      // A bad token will not fix itself by reconnecting faster, but a transient REST
      // failure will, so this still schedules a retry — with backoff.
      this.log('error', `gateway start refused: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.connect(url);
  }

  connect(url) {
    let socket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (error) {
      this.log('error', `gateway socket construction failed: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      this.handleMessage(event?.data).catch((error) => {
        this.log('error', `gateway message handling failed: ${error.message}`);
      });
    });
    socket.addEventListener('close', (event) => {
      this.ready = false;
      this.clearHeartbeat();
      this.socket = null;
      if (this.stopped) return;
      this.log('warn', `gateway socket closed (code ${event?.code ?? 'unknown'})`);
      this.scheduleReconnect();
    });
    // A socket error is always followed by a close, so reconnect is handled there. The
    // listener exists because an unhandled 'error' event would take the process down.
    socket.addEventListener('error', () => {});
  }

  async handleMessage(raw) {
    let payload = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
    if (!payload || typeof payload !== 'object') return;

    // Sequence must be recorded for every payload that carries one, not only for
    // dispatch: resume sends the last value and Discord rejects a stale one.
    if (typeof payload.s === 'number') this.sequence = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        let interval = payload?.d?.heartbeat_interval;
        if (typeof interval !== 'number' || !(interval > 0)) {
          this.log('error', 'gateway HELLO carried no heartbeat_interval');
          this.closeAndReconnect();
          return;
        }
        this.heartbeatIntervalMS = interval;
        // Jitter the first heartbeat, as the protocol asks, so many shards do not
        // beat in lockstep.
        this.startHeartbeat();
        this.identifyOrResume();
        return;
      }
      case OP.HEARTBEAT: {
        // Discord can ask for an immediate heartbeat at any time.
        this.sendHeartbeat();
        return;
      }
      case OP.HEARTBEAT_ACK: {
        this.awaitingHeartbeatAck = false;
        return;
      }
      case OP.RECONNECT: {
        this.log('info', 'gateway asked for a reconnect');
        this.closeAndReconnect();
        return;
      }
      case OP.INVALID_SESSION: {
        // d === true means the session is still resumable; false means throw it away.
        if (payload.d !== true) {
          this.sessionID = null;
          this.sequence = null;
          this.resumeURL = null;
        }
        this.log('warn', `gateway session invalidated (resumable: ${payload.d === true})`);
        this.closeAndReconnect();
        return;
      }
      case OP.DISPATCH: {
        await this.handleDispatch(payload.t, payload.d);
        return;
      }
      default:
        return;
    }
  }

  async handleDispatch(eventType, data) {
    if (eventType === 'READY') {
      this.ready = true;
      this.attempt = 0;
      this.sessionID = data?.session_id ?? null;
      this.resumeURL = data?.resume_gateway_url ?? null;
      this.userId = data?.user?.id ?? null;
      this.log('info', `gateway ready as ${data?.user?.username ?? 'unknown'}`);
      try {
        await this.onReady({ user: data?.user ?? null, sessionID: this.sessionID });
      } catch (error) {
        this.log('error', `gateway onReady handler failed: ${error.message}`);
      }
      return;
    }

    try {
      await this.onDispatch(eventType, data);
    } catch (error) {
      // A broken handler must not tear down the transport: the socket is still good
      // and the next event may be fine.
      this.log('error', `gateway dispatch handler failed for ${eventType}: ${error.message}`);
    }
  }

  identifyOrResume() {
    if (this.sessionID && this.sequence !== null) {
      this.send(OP.RESUME, {
        token: this.token,
        session_id: this.sessionID,
        seq: this.sequence,
      });
      return;
    }
    this.send(OP.IDENTIFY, {
      token: this.token,
      intents: this.intents,
      properties: { os: 'linux', browser: 'kikx', device: 'kikx' },
    });
  }

  sendHeartbeat() {
    this.send(OP.HEARTBEAT, this.sequence);
  }

  startHeartbeat() {
    this.clearHeartbeat();
    this.awaitingHeartbeatAck = false;
    let beat = () => {
      if (this.stopped) return;
      // A previous heartbeat with no ACK means the connection is a zombie: TCP is up,
      // Discord is not answering. Reconnecting is the only honest response.
      if (this.awaitingHeartbeatAck) {
        this.log('warn', 'gateway heartbeat was not acknowledged; reconnecting');
        this.closeAndReconnect();
        return;
      }
      this.awaitingHeartbeatAck = true;
      this.sendHeartbeat();
      this.heartbeatTimer = this.setTimeoutImpl(beat, this.heartbeatIntervalMS);
    };
    // First beat after jitter, not immediately.
    let jitter = Math.floor(this.heartbeatIntervalMS * this.random());
    this.heartbeatTimer = this.setTimeoutImpl(beat, jitter);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      this.clearTimeoutImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatAck = false;
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    // Exponential backoff with jitter, capped. Without a cap a long outage turns into
    // hour-long gaps; without jitter, every reconnect lands on the same millisecond.
    let base = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, this.attempt));
    let delay = Math.floor(base * (0.5 + this.random() * 0.5));
    this.attempt += 1;
    this.log('info', `gateway reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.start();
    }, delay);
  }

  closeAndReconnect() {
    let socket = this.socket;
    this.clearHeartbeat();
    this.socket = null;
    this.ready = false;
    try { socket?.close(4000, 'reconnect'); } catch (_e) { /* already gone */ }
    // The close listener schedules the reconnect, but a fake or already-closed socket
    // may never fire it, so this is scheduled directly too. scheduleReconnect clears
    // any pending timer first, so a double schedule collapses into one.
    this.scheduleReconnect();
  }

  send(op, data) {
    let socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.log('warn', `gateway dropped op ${op}: socket not open`);
      return false;
    }
    try {
      socket.send(JSON.stringify({ op, d: data }));
      return true;
    } catch (error) {
      this.log('error', `gateway send failed for op ${op}: ${error.message}`);
      return false;
    }
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    this.clearHeartbeat();
    this.clearReconnect();
    let socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, 'shutdown'); } catch (_e) { /* already gone */ }
  }

  // The state an operator or a status route should read: what this client knows, not
  // what it hopes.
  status() {
    return {
      ready: this.ready,
      sessionID: this.sessionID,
      sequence: this.sequence,
      attempt: this.attempt,
      heartbeatIntervalMS: this.heartbeatIntervalMS,
      userId: this.userId,
    };
  }
}
