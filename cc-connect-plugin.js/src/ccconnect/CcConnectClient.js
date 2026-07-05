import { WebSocket } from 'ws';

const DEFAULT_CAPABILITIES = [
  'text',
  'image',
  'file',
  'audio',
  'typing',
  'update_message',
  'preview',
  'delete_message',
  'reconstruct_reply',
];

export class CcConnectClient {
  constructor(config, options = {}) {
    const url = new URL(config.url);
    if (config.token) {
      url.searchParams.set('token', config.token);
    }
    this.url = url.toString();
    this.platform = config.platform || 'wildfire';
    this.project = config.project || undefined;
    this.capabilities = config.capabilities || DEFAULT_CAPABILITIES;
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.heartbeatInterval = config.heartbeatInterval || 30000;

    this.onMessageHandler = options.onMessage || null;
    this.onConnectionChanged = options.onConnectionChanged || null;
    this.onError = options.onError || null;
    this.onPreviewStart = options.onPreviewStart || null;

    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  async connect() {
    if (this.ws) {
      throw new Error('[cc-connect] already connecting or connected');
    }

    return new Promise((resolve, reject) => {
      this.shouldReconnect = true;

      try {
        this.ws = new WebSocket(this.url);
      } catch (error) {
        reject(error);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('[cc-connect] connection timeout'));
        this.ws?.terminate();
        this.ws = null;
      }, 30000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        this._notifyConnectionChanged(true);
        this._sendRegister();
      });

      this.ws.once('close', (code, reason) => {
        clearTimeout(timeout);
        this._handleDisconnect(code, reason);
        if (!this.registered) {
          reject(new Error(`[cc-connect] disconnected before registration: ${reason}`));
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this._notifyError(error);
        if (!this.registered) {
          reject(error);
        }
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data.toString());
      });

      this._connectResolve = resolve;
      this._connectReject = reject;
    });
  }

  _sendRegister() {
    const msg = {
      type: 'register',
      platform: this.platform,
      capabilities: this.capabilities,
      metadata: {
        version: '1.0.0',
        protocol_version: 1,
        adapter: 'cc-connect-plugin-js',
      },
    };
    if (this.project) {
      msg.project = this.project;
    }
    this._send(JSON.stringify(msg));
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this._notifyError(new Error('[cc-connect] cannot send, socket not open'));
    }
  }

  sendMessage(bridgeMessage) {
    this._send(JSON.stringify(bridgeMessage));
  }

  sendPreviewAck(refId, previewHandle) {
    this._send(
      JSON.stringify({
        type: 'preview_ack',
        ref_id: refId,
        preview_handle: previewHandle,
      })
    );
  }

  sendPing() {
    this._send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }

  _handleMessage(raw) {
    try {
      const json = JSON.parse(raw);

      if (json.type === 'register_ack') {
        if (json.ok) {
          this.registered = true;
          this._startHeartbeat();
          if (this._connectResolve) {
            this._connectResolve();
            this._connectResolve = null;
            this._connectReject = null;
          }
          console.log('[cc-connect] registered');
        } else {
          this.shouldReconnect = false;
          const err = new Error(`[cc-connect] registration failed: ${json.error}`);
          if (this._connectReject) {
            this._connectReject(err);
            this._connectResolve = null;
            this._connectReject = null;
          }
          this._notifyError(err);
        }
        return;
      }

      if (json.type === 'pong') {
        return;
      }

      if (json.type === 'preview_start') {
        // Let the bridge decide how to create the preview and ack it.
        this.onPreviewStart?.(json);
        return;
      }

      this.onMessageHandler?.(json);
    } catch (error) {
      this._notifyError(new Error(`[cc-connect] failed to handle message: ${error.message}`));
    }
  }

  _handleDisconnect(code, reason) {
    this.connected = false;
    this.registered = false;
    this._stopHeartbeat();
    this._notifyConnectionChanged(false);

    if (this._connectReject) {
      this._connectReject(new Error(`[cc-connect] disconnected: ${reason}`));
      this._connectResolve = null;
      this._connectReject = null;
    }

    if (this.shouldReconnect) {
      console.log(`[cc-connect] reconnecting in ${this.reconnectInterval}ms`);
      this.reconnectTimer = setTimeout(() => this._reconnect(), this.reconnectInterval);
    }
  }

  async _reconnect() {
    if (!this.shouldReconnect) return;
    try {
      this.ws = null;
      await this.connect();
    } catch (error) {
      console.error('[cc-connect] reconnect failed:', error.message);
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.registered) {
        this.sendPing();
      }
    }, this.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _notifyConnectionChanged(connected) {
    this.onConnectionChanged?.(connected);
  }

  _notifyError(error) {
    this.onError?.(error);
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.registered = false;
  }

  isConnected() {
    return this.connected && this.registered;
  }
}
