/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */
function getOrCreateRoom(callback) {
    if (room) {
        callback();
        return;
    }
    console.log("create room ");
    soup.createRoom(roomOptions).then(function(r) {
        console.log("create room success.");
        room = r;
        callback();
    }).catch(function(error) {
        console.log("create room error.");
        console.log(error);
    });
}

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

function startPresenter(sessionId, ws, sdpOffer, callback) {
    if (presenter !== null) {
        stop(sessionId);
        return callback("Another user is currently acting as presenter. Try again later ...");
    }
    presenter = {
        id: sessionId,
        peerconnection: null
    };
    getOrCreateRoom(function() {
        var peerconnection = new RTCPeerConnection(room, "presenter");
        var desc = new RTCSessionDescription({
            type: "offer",
            sdp: sdpOffer
        });
        peerconnection.on("negotiationneeded", function() {
            console.log("on negotiation needed.");
        });
        peerconnection.setRemoteDescription(desc).then(function() {
            return peerconnection.createAnswer();
        }).then(function(desc) {
            return peerconnection.setLocalDescription(desc);
        }).then(function() {
            callback(null, peerconnection.localDescription.sdp);
            presenter.peerconnection = peerconnection;
        }).catch(function(error) {
            callback("Error " + error);
        });
    });
}

function startViewer(sessionId, ws, sdpOffer, callback) {
    if (presenter === null) {
        stop(sessionId);
        return callback("Presenter not exists. Try again later ...");
    }
    getOrCreateRoom(function() {
        var peerconnection = new RTCPeerConnection(room, "viewer." + sessionId);
        var desc = new RTCSessionDescription({
            type: "offer",
            sdp: sdpOffer
        });
        peerconnection.setRemoteDescription(desc).then(function() {
            peerconnection.createAnswer().then(function(desc) {
                peerconnection.setLocalDescription(desc);
                callback(null, desc.sdp);
            });
        });
        peerconnection.on("negotiationneeded", function() {
            console.log("on negotiation needed.");
            console.log(new Date);
        });
        viewers[sessionId] = {
            ws: ws,
            peerconnection: peerconnection
        };
    });
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function stop(sessionId) {
    if (presenter !== null && presenter.id == sessionId) {
        for (var i in viewers) {
            var viewer = viewers[i];
            if (viewer.ws) {
                viewer.ws.send(JSON.stringify({
                    id: "stopCommunication"
                }));
            }
            viewer.peerconnection.close();
        }
        presenter.peerconnection.close();
        presenter = null;
        viewers = [];
    } else if (viewers[sessionId]) {
        viewers[sessionId].peerconnection.close();
        delete viewers[sessionId];
    }
    clearCandidatesQueue(sessionId);
}

function onIceCandidate(sessionId, _candidate) {
    console.log("candidates");
}

var path = require("path");

var url = require("url");

var express = require("express");

var minimist = require("minimist");

var ws = require("ws");

var fs = require("fs");

var https = require("https");

var mediasoup = require("mediasoup");

var RTCPeerConnection = mediasoup.webrtc.RTCPeerConnection;

var RTCSessionDescription = mediasoup.webrtc.RTCSessionDescription;

var roomOptions = {
    mediaCodecs: [ {
        kind: "audio",
        name: "audio/opus",
        clockRate: 48e3,
        numChannels: 2
    }, {
        kind: "audio",
        name: "audio/PCMU",
        clockRate: 8e3
    }, {
        kind: "video",
        name: "video/vp8",
        clockRate: 9e4
    }, {
        kind: "video",
        name: "video/h264",
        clockRate: 9e4,
        parameters: {
            packetizationMode: 0
        }
    }, {
        kind: "video",
        name: "video/h264",
        clockRate: 9e4,
        parameters: {
            packetizationMode: 1
        }
    }, {
        kind: "depth",
        name: "video/vp8",
        clockRate: 9e4
    } ]
};

var soup = mediasoup.Server({
    logLevel: "debug",
    logTags: ['ice', 'rtcp', 'dtls'],
    rtcListenIPV4: "127.0.0.1",
    rtcListenIPV6: false,
    dtlsCertificateFile: "keys/server.crt",
    dtlsPrivateKeyFile: "keys/server.key"
});

soup.on("close", function(error) {
    console.log("server closed ");
    console.log(error);
});

var room = null;

var argv = minimist(process.argv.slice(2), {
    "default": {
        as_uri: "https://localhost:8443/"
    }
});

var app = express();

var idCounter = 0;

var candidatesQueue = {};

var presenter = null;

var viewers = [];

var noPresenterMessage = "No active presenter. Try again later...";

var options = {
    key: fs.readFileSync("keys/server.key"),
    cert: fs.readFileSync("keys/server.crt")
};

var asUrl = url.parse(argv.as_uri);

var port = asUrl.port;

var server = https.createServer(options, app).listen(port, function() {
    console.log("mediasoup demo started");
    console.log("Open " + url.format(asUrl) + " with a WebRTC capable browser");
});

var wss = new ws.Server({
    server: server,
    path: "/live"
});

wss.on("connection", function(ws) {
    var sessionId = nextUniqueId();
    console.log("Connection received with sessionId " + sessionId);
    ws.on("error", function(error) {
        console.log("Connection " + sessionId + " error");
        stop(sessionId);
    });
    ws.on("close", function() {
        console.log("Connection " + sessionId + " closed");
        stop(sessionId);
    });
    ws.on("message", function(_message) {
        var message = JSON.parse(_message);
        console.log("Connection " + sessionId + " received message ", message);
        switch (message.id) {
          case "presenter":
            startPresenter(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id: "presenterResponse",
                        response: "rejected",
                        message: error
                    }));
                }
                ws.send(JSON.stringify({
                    id: "presenterResponse",
                    response: "accepted",
                    sdpAnswer: sdpAnswer
                }));
            });
            break;
          case "viewer":
            startViewer(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id: "viewerResponse",
                        response: "rejected",
                        message: error
                    }));
                }
                ws.send(JSON.stringify({
                    id: "viewerResponse",
                    response: "accepted",
                    sdpAnswer: sdpAnswer
                }));
            });
            break;
          case "stop":
            stop(sessionId);
            break;
          case "onIceCandidate":
            onIceCandidate(sessionId, message.candidate);
            break;
          default:
            ws.send(JSON.stringify({
                id: "error",
                message: "Invalid message " + message
            }));
            break;
        }
    });
});

app.use(express.static(path.join(__dirname, "static")));
