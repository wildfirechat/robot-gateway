import WebSocket from 'ws';
import { RequestMessage } from './protocol/RequestMessage.js';
import { ConnectMessage } from './protocol/ConnectMessage.js';
import { ResponseMessage } from './protocol/ResponseMessage.js';
import { PushMessage } from './protocol/PushMessage.js';
import { ResponseHandler } from './handler/ResponseHandler.js';

/**
 * WebSocket 客户端
 * 处理底层的 WebSocket 连接和消息收发
 */
export class RobotGatewayClient {
    constructor(gatewayUrl, messageHandler = null, options = {}) {
        this.gatewayUrl = gatewayUrl;
        this.messageHandler = messageHandler;
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
        this.responseHandler = new ResponseHandler(options.timeout || 30);
        
        // 重连配置
        this.reconnectInterval = options.reconnectInterval || 5000;
        this.heartbeatInterval = options.heartbeatInterval || 270000; // 4.5分钟
        this.heartbeatTimer = null;
        this.shouldReconnect = false;
        // 重连去重：同一时刻最多一个重连任务、一个重连定时器，
        // 避免 handleDisconnect 被多次触发时开出多个并发 WebSocket
        // （并发 socket 互相抢鉴权，会触发 "Already authenticated" 并
        // 让 shouldReconnect 被置 false，导致客户端永久假死）。
        this._reconnecting = false;
        this._reconnectTimer = null;

        // 是否有一个 connect 请求正在等待响应。只有 true 时收到的 connect 失败
        // 才是「本次鉴权失败」；否则是迟到的/错标的帧（例如网关把普通请求的
        // 错误响应标成 type=connect），不能据此把整条连接判死。
        this._authPending = false;
        // 是否已向 messageHandler 通知过「已连接」，用于保证断开时一定补一次
        // onConnectionChanged(false)（旧实现只在 wasAuthenticated 时通知，
        // 鉴权失败后连接再断开就不会通知，插件永远以为还连着）。
        this._notifiedConnected = false;
        
        // 鉴权信息
        this.robotId = null;
        this.robotSecret = null;
        
        // 事件回调
        this.onConnected = null;
        this.onDisconnected = null;
        this.onAuthenticated = null;
        this.onAuthFailed = null;
        this.onError = null;
    }

    /**
     * 连接到网关
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                // 新 socket 一律从「未鉴权」开始，避免重连期间沿用上一条连接的
                // authenticated=true，把请求发到还没鉴权的新 socket 上。
                this.authenticated = false;
                this._authPending = false;

                // 先彻底拆除旧 socket（重连竞态保护）：移除监听并关闭，
                // 否则旧 socket 的迟到事件（close/message/auth）会与
                // 新 socket 互相干扰，触发 "Already authenticated" 竞态。
                if (this.ws) {
                    this.ws.removeAllListeners();
                    try {
                        this.ws.terminate();
                    } catch (e) {
                        /* ignore */
                    }
                    this.ws = null;
                }

                this.ws = new WebSocket(this.gatewayUrl);

                this.ws.on('open', () => {
                    this.connected = true;
                    console.log('WebSocket connected');
                    if (this.onConnected) {
                        this.onConnected();
                    }
                    resolve();
                });

                this.ws.on('message', (data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('close', (code, reason) => {
                    // 诊断用：网关关闭连接时的状态码/原因（如 1000 "replaced by new robot connection"）
                    console.log(`WebSocket close code=${code} reason=${reason?.toString?.() ?? reason}`);
                    this.handleDisconnect();
                });

                this.ws.on('error', (error) => {
                    console.error('WebSocket error:', error.message);
                    if (this.onError) {
                        this.onError(error.message);
                    }
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 发送鉴权请求
     * @param {number|null} platform 机器人平台号（ProtoConstants.Platform），
     *   null 时网关按默认平台处理
     */
    sendConnect(robotId, robotSecret, platform = null) {
        this.robotId = robotId;
        this.robotSecret = robotSecret;
        this.platform = platform;

        const connectMsg = ConnectMessage.authRequest(robotId, robotSecret, platform);
        this._authPending = true;
        try {
            this.send(JSON.stringify(connectMsg));
        } catch (error) {
            this._authPending = false;
            throw error;
        }
        this.shouldReconnect = true;
    }

    /**
     * 发送请求并等待响应
     */
    async sendRequest(method, params = []) {
        if (!this.connected) {
            throw new Error('WebSocket not connected');
        }
        if (!this.authenticated && method !== 'connect') {
            throw new Error('Not authenticated');
        }

        const requestId = this.generateRequestId();
        const request = new RequestMessage(requestId, method, params);

        // 注册请求等待响应
        const responsePromise = this.responseHandler.registerRequest(requestId);

        // 发送请求
        this.send(JSON.stringify(request));

        return responsePromise;
    }

    /**
     * 发送原始消息
     */
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        } else {
            throw new Error('WebSocket not open');
        }
    }

    /**
     * 处理收到的消息
     */
    handleMessage(data) {
        try {
            const json = JSON.parse(data);

            // 鉴权响应
            if (json.type === 'connect') {
                this.handleConnectResponse(json);
                return;
            }

            // 心跳响应
            if (json.type === 'heartbeat') {
                console.log('Heartbeat response received');
                return;
            }

            // 推送消息
            if (json.type === 'message') {
                if (this.messageHandler && this.messageHandler.onMessage) {
                    this.messageHandler.onMessage(PushMessage.fromJSON(json));
                }
                return;
            }

            // 请求响应
            if (json.requestId) {
                const response = ResponseMessage.fromJSON(json);
                const handled = this.responseHandler.handleResponse(response);
                if (!handled) {
                    console.warn('Unhandled response:', json.requestId);
                }
                return;
            }

            console.warn('Unknown message type:', json);

        } catch (error) {
            console.error('Failed to handle message:', error.message);
            if (this.onError) {
                this.onError(error.message);
            }
        }
    }

    /**
     * 处理鉴权响应
     */
    handleConnectResponse(json) {
        const authWasPending = this._authPending === true;
        this._authPending = false;

        if (json.code === 0) {
            this.authenticated = true;
            console.log('Authentication successful');
            this.startHeartbeat();
            if (this.onAuthenticated) {
                this.onAuthenticated();
            }
            if (this.messageHandler && this.messageHandler.onConnectionChanged) {
                this._notifiedConnected = true;
                this.messageHandler.onConnectionChanged(true);
            }
            return;
        }

        console.error('Authentication failed:', json.msg);

        // 没有在等鉴权响应，却收到一帧 connect 错误：这不是本次鉴权的结论。
        // 典型场景：网关把某个普通请求的 500 错误响应错标成 type=connect。
        // 此时连接仍然是已鉴权状态，必须忽略，否则整条连接会被永久判死
        //（authenticated=false + 不再重连 + 连接还在，看门狗也不会触发）。
        if (!authWasPending && this.authenticated) {
            console.warn(
                `Ignoring connect error without a pending auth request: code=${json.code}, msg=${json.msg}`
            );
            return;
        }

        this.authenticated = false;

        const code = Number(json.code);
        const msg = String(json.msg || '');
        // 可重试的失败：并发/后端临时故障，不是凭据错误。
        // - "Already authenticated"：并发 socket 竞态；
        // - 5xx：网关/IM 接口临时异常（例如鉴权时 HTTP 调用失败）；
        // - 网络/超时字样：链路抖动。
        const transient =
            msg.includes('Already authenticated') ||
            (Number.isFinite(code) && code >= 500) ||
            /timeout|timed out|internal server error|econn|socket|network|temporar/i.test(msg);

        if (transient) {
            // 拆除当前 socket 并安排重连，等服务端/网络恢复后重新鉴权。
            this.shouldReconnect = true;
            this.connected = false;
            this.notifyDisconnected();
            if (this.ws) {
                this.ws.removeAllListeners();
                try {
                    this.ws.terminate();
                } catch (e) {
                    /* ignore */
                }
                this.ws = null;
            }
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this.reconnect();
            }, this.reconnectInterval);
            return;
        }

        this.shouldReconnect = false; // 真正的鉴权失败（密钥错误等）不重连
        if (this.onAuthFailed) {
            this.onAuthFailed(json.code, json.msg);
        }
    }

    /**
     * 处理断开连接
     */
    handleDisconnect() {
        this.connected = false;
        this.authenticated = false;
        this._authPending = false;
        this.stopHeartbeat();

        // 清理所有待处理的请求
        this.responseHandler.clearAll('Connection closed');

        // 只要曾经通知过「已连接」，断开时就必须补一次 false。
        // 旧实现用 wasAuthenticated 做条件，鉴权失败后再断开就不通知，
        // 插件会永远认为连接还在（看门狗不触发，只能重启进程）。
        this.notifyDisconnected();

        console.log('WebSocket disconnected');
        if (this.onDisconnected) {
            this.onDisconnected();
        }

        // 自动重连（定时器去重：多次 handleDisconnect 只安排一个重连任务）
        if (this.shouldReconnect && this.robotId && this.robotSecret) {
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this.reconnect();
            }, this.reconnectInterval);
        }
    }

    /**
     * 重新连接
     */
    async reconnect() {
        if (this._reconnecting) return; // 重连进行中，忽略并发触发
        this._reconnecting = true;
        console.log('Attempting to reconnect...');
        try {
            await this.connect();
            this.sendConnect(this.robotId, this.robotSecret, this.platform);
        } catch (error) {
            console.error('Reconnect failed:', error.message);
            // 重连失败，继续尝试
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this.reconnect();
            }, this.reconnectInterval);
        } finally {
            this._reconnecting = false;
        }
    }

    /**
     * 通知上层「连接已断开/已失效」（每个连接生命周期只通知一次 false）。
     */
    notifyDisconnected() {
        if (!this._notifiedConnected) {
            return;
        }
        this._notifiedConnected = false;
        if (this.messageHandler && this.messageHandler.onConnectionChanged) {
            try {
                this.messageHandler.onConnectionChanged(false);
            } catch (error) {
                console.error('onConnectionChanged(false) failed:', error.message);
            }
        }
    }

    /**
     * 启动心跳
     */
    startHeartbeat() {
        // 先清掉旧定时器：重连成功会再次调用本方法，否则会叠加多个心跳
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.authenticated) {
                try {
                    // Must swallow the rejection: the request stays pending until
                    // the next response, and on disconnect ResponseHandler.clearAll()
                    // rejects it — an unhandled rejection crashes the host process
                    // (dsh fail-loud exits on unhandledRejection).
                    this.sendRequest('heartbeat').catch((error) => {
                        console.error('Failed to send heartbeat:', error.message);
                    });
                } catch (error) {
                    console.error('Failed to send heartbeat:', error.message);
                }
            }
        }, this.heartbeatInterval);
    }

    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 关闭连接
     */
    close() {
        this.shouldReconnect = false;
        this._authPending = false;
        this.stopHeartbeat();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            try {
                this.ws.close();
            } catch (e) {
                /* ignore */
            }
            this.ws = null;
        }
    }

    /**
     * 生成唯一请求ID
     */
    generateRequestId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 是否已连接
     */
    isConnected() {
        return this.connected;
    }

    /**
     * 是否已鉴权
     */
    isAuthenticated() {
        return this.authenticated;
    }
}
