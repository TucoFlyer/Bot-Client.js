var EventEmitter = require('events').EventEmitter;
var hmacSHA512 = require('crypto-js/hmac-sha512');
var Base64 = require('crypto-js/enc-base64');
var ReconnectingWebSocket = require('reconnecting-websocket');

class BotModel {
    constructor() {
        this.flyer = {};
        this.winches = [];
        this.gimbal_values = [];
        this.gimbal_status = {};
        this.camera = {};
        this.camera.outputs = {};
    }

    update(msg) {
        if (msg.message.WinchStatus) {
            this.winches[msg.message.WinchStatus[0]] = msg;
        }
        if (msg.message.FlyerSensors) {
            this.flyer = msg;
        }
        if (msg.message.ConfigIsCurrent) {
            this.config = msg;
        }
        if (msg.message.GimbalValue) {
            let addr = msg.message.GimbalValue[0].addr;
            let index_list = this.gimbal_values[addr.index] || (this.gimbal_values[addr.index] = []);
            index_list[addr.target] = msg;
        }
        if (msg.message.GimbalControlStatus) {
            this.gimbal_status = msg;
        }
        if (msg.message.Command) {
            let cmd = msg.message.Command;
            if (cmd.CameraObjectDetection) {
                this.camera.object_detection = msg;
            }
            if (cmd.CameraRegionTracking) {
                this.camera.region_tracking = msg;
            }
            if (cmd.CameraOutputStatus) {
                this.camera.outputs = msg;
            }
        }
    }
}

class BotClient {
    constructor(url, key) {
        this.message_subscription = [
            "ConfigIsCurrent", "Command", "FlyerSensors", "WinchStatus",
            "GimbalControlStatus", "GimbalValue", "UnhandledGimbalPacket",
        ];

        this.events = new EventEmitter();
        this.events.setMaxListeners(100);
        this.socket = null;
        this.frame_request = null;
        this.model = new BotModel();
        this.auth_challenge = null;
        this.key = key;
        this.authenticated = false;
        this.connected = false;

        // Binds, so functions can access `this`
        this.handleSocketMessage = this.handleSocketMessage.bind(this);
        this.handleSocketOpen = this.handleSocketOpen.bind(this);
        this.handleSocketClose = this.handleSocketClose.bind(this);
        this.send = this.send.bind(this);
        this.authenticate = this.authenticate.bind(this);

        // Connect
        this.socket = new ReconnectingWebSocket(url, undefined, { WebSocket: require('ws') });
        this.socket.addEventListener('message', this.handleSocketMessage);
        this.socket.addEventListener('open', this.handleSocketOpen);
        this.socket.addEventListener('close', this.handleSocketClose);
    }

    handleSocketMessage(evt) {
        const json = JSON.parse(evt.data);
        let time_offset = null;
        let last_timestamp = null;

        if (json.Stream) {
            const msglist = json.Stream;
            const last_msg = msglist[msglist.length - 1];

            // Update time offset from last message, restart if timestamps go backward.
            if (last_msg.timestamp < last_timestamp) {
                time_offset = null;
            }
            last_timestamp = last_msg.timestamp;
            if (time_offset === null) {
                time_offset = new Date().getTime() - last_msg.timestamp;
            }

            // Annotate all messages with local timestamp, and update the model
            for (let msg of msglist) {
                msg.local_timestamp = time_offset + msg.timestamp;
                this.model.update(msg);
                if (msg.message.ConfigIsCurrent) {
                    this.events.emit('config', msg);
                }
                if (msg.message.UnhandledGimbalPacket) {
                    this.events.emit('gimbal', msg);
                }
            }

            // Event for access to a raw message burst
            this.events.emit('messages', msglist);

            // Batch messages into UI frames
            if (!this.frame_request) {
                if (window) {
                    this.frame_request = window.requestAnimationFrame(() => {
                        this.frame_request = null;
                        this.events.emit('frame', this.model);
                    });
                }
            }

        } else if (json.Error !== undefined) {
            // The server can generate errors which we'll pass on as exceptions
            this.events.emit('log', json);
            throw json.Error;

        } else if (json.Auth !== undefined) {
            // Authentication challenge
            this.events.emit('log', json);
            this.auth_challenge = json.Auth.challenge;
            this.authenticate(json.Auth);

        } else if (json.AuthStatus !== undefined) {
            // True or false, set logged-in state
            this.events.emit('log', json);
            this.authenticated = json.AuthStatus === true;

        } else {
            this.events.emit('log', json);
            console.log("[Bot-Client.js] Unrecognized message ", json);
        }
    }

    handleSocketOpen() {
        this.send({Subscription: this.message_subscription});
        this.authenticated = false;
        this.connected = true;
    }

    handleSocketClose() {
        this.authenticated = false;
        this.connected = false;
    }

    send(json) {
        this.socket.send(JSON.stringify(json));
    }

    authenticate() {
        const challenge = this.auth_challenge;
        const key = this.key;
        if (key && challenge && this.socket) {
            const digest = Base64.stringify(hmacSHA512(this.auth_challenge, key))
            this.send({ Auth: { digest }});
        }
    }

    destroy() {
        if (this.socket) {
            this.socket.removeEventListener('message', this.handleSocketMessage);
            this.socket.removeEventListener('open', this.handleSocketOpen);
            this.socket.removeEventListener('close', this.handleSocketClose);
            this.socket.close();
        }

        if (window && this.frame_request) {
            window.cancelAnimationFrame(this.frame_request);
        }
    }
}

module.exports = {
    BotModel,
    BotClient
};