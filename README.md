# Bot-Client.js
JavaScript client for commanding and monitoring the Bot-Controller via WebSockets.

## Install

```
npm install TucoFlyer/Bot-Client.js
```

## Usage

```js
var BotClient = require('Bot-Client.js');

var client = new BotClient("./connection.txt"); // Create a BotClient instance with the path of connection.txt.

// Add an event listener for authentication ready
client.events.addListener("auth", function() {
    this.context.botConnection.send({ Command: { SetMode: "ManualFlyer" }}); // Set manual control mode
    this.context.botConnection.send({ Command: { ManualControlValue: [ "RelativeX", 0.5 ] }}); // Start moving in X direction
    setTimeout(function() { // 1s later
        this.context.botConnection.send({ Command: { ManualControlValue: [ "RelativeX", 0 ] }}); // Stop moving in X direction
    }, 1000);
});
```

## Documentation

### new BotClient(path)

Creates a new BotClient, and attempts to connect.

Parameters:
 * path - Path of connection.txt.

### new BotClient(url, key)

Creates a new BotClient, and attempts to connect.

Parameters:
 * url - WebSocket URL to connect to. (should have `ws://` prefix)
 * key - Authentication key to use.

#### client.events

Event emitter.

Events:
 * log: Event for logging purposes.
    * Argument 1: Log message/data
 * config: Event for config updates.
    * Argument 1: WS message.
 * gimbal: Event for gimbal packets.
    * Argument 1: WS message.
 * messages: Event for access to a raw message burst.
    * Argument 1: Message list.
 * auth: Event for successful authentication.

#### client.model

BotModel of the client. See [BotModel](#botmodel) for more info.

#### client.authenticated

Boolean, whether the client is authenticated or not.

#### client.connected

Boolean, whether the client is connected or not.

### BotModel

Bot data model. Used in `client.model`.

For more info about values, see [message.rs](https://github.com/TucoFlyer/Bot-Controller/blob/master/src/message.rs).

#### model.flyer

Flyer Sensor data. (FlyerSensors)

#### model.winches

Array of winch data. (WinchStatus)

#### model.gimbal_values

Array of gimbal values. (GimbalValue)

#### model.gimbal_status

Gimbal status. (GimbalControlStatus)

#### model.camera

Camera data. (Command)

##### model.camera.object_detection

Object detection data. (CameraObjectDetection)

##### model.camera.region_tracking

Region tracking data. (CameraRegionTracking)

##### model.camera.outputs

Camera output status. (CameraOutputStatus)
