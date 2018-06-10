var EventEmitter = require('events').EventEmitter;
var hmacSHA512 = require('crypto-js/hmac-sha512');
var Base64 = require('crypto-js/enc-base64');
var ReconnectingWebSocket = require('reconnecting-websocket');
var fs = require('fs');
var request = require('request');
var deasync = require('deasync');
var URL = require('url').URL;

class BotModel {
    /**
     * Creates a new BotModel instance.
     * @constructor
     */
    constructor() {
        this.flyer = {}; // Flyer sensor data. (updated by FlyerSensors messages)
        this.winches = []; // Winch status. (updated by WinchStatus messages)
        this.gimbal_values = []; // Gimbal data. (updated by GimbalValue messages)
        this.gimbal_status = {}; // Gimbal status. (updated by GimbalControlStatus)
        this.camera = {}; // Camera data. (updated by Command.CameraObjectDetection, and Command.CameraRegionTracking)
        this.camera.outputs = {}; // Camera output status. (updated by Command.CameraOutputStatus)
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

module.exports = class BotClient {
    /**
     * Creates a new BotClient instance.
     * @constructor
     * @param {String} url The WebSocket URL of Bot-Controller, or the path of connection.txt.
     * @param {String} key The authentication key. (Not needed if connection.txt's path was provided.)
     */
    constructor(url, key) {

        // Message types to subscribe to.
        this.message_subscription = [
            "ConfigIsCurrent", "Command", "FlyerSensors", "WinchStatus",
            "GimbalControlStatus", "GimbalValue", "UnhandledGimbalPacket",
        ];

        // Event emitter setup
        this.events = new EventEmitter();
        this.events.setMaxListeners(100);

        this.socket = null; // Variable for ReconnectingWebSocket
        this.frame_request = null; // HTML Frame update request. (only used in Browserify)
        this.model = new BotModel(); // BotModel of client.
        this.auth_challenge = null; // Authentication challange from WS.
        this.url = url;
        this.key = key; // Authentication key.
        this.txtPath = null;
        
        if (key == null || key == undefined) { // If connection.txt path was pssed.
            this.txtPath = url;
            
            var connectionTxt = fs.readFileSync(this.txtPath, "UTF-8");
            
            // Get and parse URL.
            var connectionUrl = connectionTxt.split("\n")[0];
            var parsedUrl = new URL(connectionUrl);
            
            var wsStatusURL = `${parsedUrl.protocol}//${parsedUrl.host}/ws`; // Construct websocket status URL.
            
            var done = false;
            
            request(wsStatusURL, function(err, res, body) { // Get websocket URL
                done = true;
                if (err) throw err;
                this.url = JSON.parse(body).uri;
            }.bind(this));
            
            deasync.loopWhile(() => !done); // Loop until request is finished
        }

        // Status variables
        this.authenticated = false;
        this.connected = false;

        // Binds, so functions can access `this`
        this.handleSocketMessage = this.handleSocketMessage.bind(this);
        this.handleSocketOpen = this.handleSocketOpen.bind(this);
        this.handleSocketClose = this.handleSocketClose.bind(this);
        this.send = this.send.bind(this);
        this.authenticate = this.authenticate.bind(this);

        // Connect to WebSocket server.
        this.socket = new ReconnectingWebSocket(this.url, undefined, { WebSocket: require('ws') });
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
                if (process.browser) {
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
            if (this.authenticated) this.events.emit('auth');

        } else {
            this.events.emit('log', json);
            console.log("[Bot-Client.js] Unrecognized message ", json);
        }
    }

    handleSocketOpen() {
        if (this.txtPath) { // if connection.txt was specified
            var connectionTxt = fs.readFileSync(this.txtPath, "UTF-8"); // read connection.txt
            
            var connectionUrl = connectionTxt.split("\n")[0]; // get URL
            var parsedUrl = new URL(connectionUrl); // parse URL
            
            this.key = parsedUrl.searchParams.get("k"); // get key from query parameter
        }
        
        this.send({Subscription: this.message_subscription}); // Subscribe to specified message types.
        this.authenticated = false;
        this.connected = true;
    }

    handleSocketClose() {
        this.authenticated = false;
        this.connected = false;
    }

    /**
     * Send a message.
     * @param {Object} obj
     * @returns {Promise}
     */
    send(obj) {
        return new Promise((resolve, reject) => {
            this.socket.send(JSON.stringify(obj), {}, function(err) {
                if (err != null && err != undefined && err instanceof Error) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Authenticate.
     * Do not call. The message handler calls this when needed.
     */
    authenticate() {
        const challenge = this.auth_challenge;
        const key = this.key;
        if (key && challenge && this.socket) {
            const digest = Base64.stringify(hmacSHA512(this.auth_challenge, key))
            this.send({ Auth: { digest }});
        }
    }

    /**
     * Closes the connection.
     */
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
