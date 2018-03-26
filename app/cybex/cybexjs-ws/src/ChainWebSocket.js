
import { cloneDeep } from "lodash";
import {NetworkStore} from "stores/NetworkStore";

let WebSocketClient = WebSocket;

let pendingCalls = {};
let subscriptions = {};

var SOCKET_DEBUG = false;

function getWebSocketClient() {
    return WebSocketClient;
}

let keep_alive_interval = 3000;
let max_send_life = 2;
// let max_recv_life = 2;
let max_recv_life = max_send_life * 4;

class ChainWebSocket {
    constructor(ws_server, statusCb, connectTimeout = 5000, autoReconnect = true, keepAliveCb = null) {
        this.initParams = [ws_server, statusCb, connectTimeout, autoReconnect, keepAliveCb];
        // console.debug("[ChainWebSocket]", "New", ws_server, statusCb, connectTimeout = 5000, autoReconnect = true, keepAliveCb = null)
        this.statusCb = statusCb;
        this.connectionTimeout = setTimeout(() => {
            if (this.current_reject) this.current_reject(new Error("Connection attempt timed out: " + ws_server));
        }, connectTimeout);
        let WsClient = getWebSocketClient(autoReconnect);
        try {
            this.ws = new WsClient(ws_server);
        } catch (error) {
            console.error("invalid websocket URL:", error, ws_server);
            this.ws = new WsClient("wss://127.0.0.1:8090");
        }
        // Reset Set
        this.cbId = 0;
        this.responseCbId = 0;
        this.cbs = {};
        this.subs = {};
        this.unsub = {};
        NetworkStore.updateApiStatus("connecting");
        
        // For Dev
        window.closeWs = () => this.close();

        this.ws.timeoutInterval = 60000;
        this.current_reject = null;
        this.on_reconnect = null;
        this.send_life = max_send_life;
        this.recv_life = max_recv_life;
        this.keepAliveCb = keepAliveCb;
        this.connect_promise = new Promise((resolve, reject) => {
            this.current_reject = reject;
            this.ws.onopen = () => {
                NetworkStore.updateApiStatus("online");
                clearTimeout(this.connectionTimeout);
                if (this.statusCb) this.statusCb("open");
                if (this.on_reconnect) this.on_reconnect();
                this.keepalive_timer = setInterval(() => {
                    this.recv_life--;
                    // console.debug("RecvLife: ", this.recv_life);
                    if (this.recv_life === max_recv_life - 1) {
                        NetworkStore.updateApiStatus("online");
                    }
                    if (this.recv_life < max_recv_life - 2) {
                        NetworkStore.updateApiStatus("blocked");
                    }
                    if (this.recv_life == 0) {
                        console.error("keep alive timeout.");
                        NetworkStore.updateApiStatus("offline");
                        if (this.ws.terminate) {
                            this.ws.terminate();
                        }
                        else {
                            this.ws.close();
                        }
                        clearInterval(this.keepalive_timer);
                        this.keepalive_timer = undefined;
                        // Try Reconnect
                        // console.debug("Try Reconnect");
                        // setTimeout(() => this.init(this.initParams), 5000);
                        return;
                    }
                    this.send_life--;
                    if (this.send_life == 0) {
                        this.call([2,"get_objects",[["2.1.0"]]]);
                        // console.debug("SendLife: ", this.send_life);
                        if (this.keepAliveCb) {
                            // console.debug("SendList 0, Keepalive", this.keepAliveCb);
                            this.keepAliveCb();
                        }
                        this.send_life = max_send_life;
                    }
                }, keep_alive_interval);
                resolve();
            };
            this.ws.onerror = (error) => {
                if (this.keepalive_timer) {
                    clearInterval(this.keepalive_timer);
                    this.keepalive_timer = undefined;
                }
                clearTimeout(this.connectionTimeout);
                if (this.statusCb) this.statusCb("error");
                NetworkStore.updateApiStatus("error");                
                
                if (this.current_reject) {
                    this.current_reject(error);
                }
            };
            this.ws.onmessage = (message) => {
                this.recv_life = max_recv_life;
                this.listener(JSON.parse(message.data));
            };
            this.ws.onclose = () => {
                // console.debug("[CybexWebSocket]", "[WsOnClose]", this.subs, this);
                if (this.keepalive_timer) {
                    clearInterval(this.keepalive_timer);
                    this.keepalive_timer = undefined;
                }
                var err = new Error("connection closed");
                for (var cbId = this.responseCbId + 1; cbId <= this.cbId; cbId += 1) {
                    this.cbs[cbId].reject(err);
                }
                // console.debug("[CybexWebSocket]", "[WsOnClose]", "[SatusCB]", this.statusCb);
                NetworkStore.updateApiStatus("offline");                
                if (this.statusCb) this.statusCb("closed");
                if (this.closeCb) this.closeCb();
            };
        });
    }

    restore() {
        for (let sub in subscriptions) {
            let params = subscriptions[sub];
            delete subscriptions[sub];
            this.call(params);
        }
    }

    updateId(cbId = 0) {
        let id = Number(cbId) + 1;
        while (pendingCalls[id] || subscriptions[id]) {
            id++;
        }
        return id;
    }

    call(params, cbId) {
        if (this.ws.readyState !== 1) {
            return Promise.reject(new Error('websocket state error:' + this.ws.readyState));
        }

        // this.cbId += 1;
        this.cbId = cbId || this.updateId(this.cbId);
        let method = params[1];
        // if (SOCKET_DEBUG)
        console.log("[ChainWebSocket] >---- call ----->  \"id\":" + (this.cbId), JSON.stringify(params));
        // this.cbId += 1;
        pendingCalls[this.cbId] = params; // 暂存未完成请求
        if (method === "set_subscribe_callback" || method === "subscribe_to_market" ||
            method === "broadcast_transaction_with_callback" || method === "set_pending_transaction_callback"
        ) {
            // Store callback in subs map
            this.subs[this.cbId] = {
                callback: params[2][0]
            };
            subscriptions[this.cbId] = cloneDeep(params); // 
            // Replace callback with the callback id
            params[2][0] = this.cbId;
        }

        if (method === "unsubscribe_from_market" || method === "unsubscribe_from_accounts") {
            if (typeof params[2][0] !== "function") {
                throw new Error("First parameter of unsub must be the original callback");
            }

            let unSubCb = params[2].splice(0, 1)[0];

            // Find the corresponding subscription
            for (let id in this.subs) {
                if (this.subs[id].callback === unSubCb) {
                    this.unsub[this.cbId] = id;
                    break;
                }
            }
        }

        var request = {
            method: "call",
            params: params
        };
        request.id = this.cbId;
        this.send_life = max_send_life;

        return new Promise((resolve, reject) => {
            this.cbs[this.cbId] = {
                time: new Date(),
                resolve: resolve,
                reject: reject
            };
            this.ws.send(JSON.stringify(request));
        });

    }

    listener(response) {
        if (SOCKET_DEBUG)
            console.log("[ChainWebSocket] <---- reply ----<", JSON.stringify(response));

        let sub = false,
            callback = null;

        if (response.method === "notice") {
            sub = true;
            response.id = response.params[0];
        }

        if (!sub) {
            callback = this.cbs[response.id];
            this.responseCbId = response.id;
        } else {
            callback = this.subs[response.id].callback;
        }

        if (callback && !sub) {
            if (response.error) {
                callback.reject(response.error);
            } else {
                callback.resolve(response.result);
            }
            delete this.cbs[response.id];
            delete pendingCalls[response.id];

            if (this.unsub[response.id]) {
                delete this.subs[this.unsub[response.id]];
                delete this.unsub[response.id];
            }

        } else if (callback && sub) {
            callback(response.params[1]);
        } else {
            console.log("Warning: unknown websocket response: ", response);
        }
    }

    login(user, password) {
        return this.connect_promise.then(() => {
            return this.call([1, "login", [user, password]]);
        });
    }

    close() {
        return new Promise((res) => {
            // console.debug("[CybexWebSocket]", "[OnClose]", this.subs);
            this.closeCb = () => {
                res();
                this.closeCb = null;
            };
            this.ws.close();
            if (this.ws.readyState !== 1) res();
        });
    }
}

export default ChainWebSocket;
