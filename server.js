"use strict";
var serverContactTimeLimit = 5 * 60;

var welcomeText = "<h1>Hi there.</h1>" +
    "<p>This is a master server for ElDewrito (a Halo Online fan mod), to use this master server you'll need to use a server browser.</p>" +
    "<h3>Useful links</h3>" +
    "<ul><li><a href=\"https://www.reddit.com/r/HaloOnline\">/r/HaloOnline, the Halo Online subreddit</a> - Information about HaloOnline and ElDewrito can be found here.</li>" +
    "<li><a href=\"https://discord.me/halo\">ElDewrito Discord</a> - The official discord for ElDewrito.</li><ul>" +
    "<p>The source code for this master server can be downloaded from <a href=\"https://github.com/theTwist84/edms\">GitHub</a><p>";

var isRunningBehindProxy = true;

var redisHostName = "pub-redis-10440.us-east-1-4.6.ec2.redislabs.com";
var redisPortNumber = "10440";

var appPortNumber = process.env.PORT || 8081;

var isRunningStatsServer = false;

var express = require('express'),
    http = require('http'),
    request = require('request'),
    redis = require('redis'),
    async = require('async'),
    bodyParser = require('body-parser'),
    crypto = require('crypto');

var app = express();
var client = redis.createClient(redisPortNumber, redisHostName);

function jsonGet(options, callback) {
    return request(options, function(error, response, body) {
        if (error || response.statusCode !== 200) {
            return callback({
                error: "true"
            });
        }
        var data;
        try {
            data = JSON.parse(body);
        } catch (ex) {
            console.log("error contacting", options.uri, ":", ex);
            data = {
                error: "true"
            };
        }
        return callback(data);
    });
}

app.get('/announce', function(req, res) {
    var shutdown = req.query.shutdown === "true" || req.query.shutdown == 1;

    if (!req.query.port) {
        return res.send({
            result: {
                code: 1,
                msg: "Invalid parameters, valid parameters are 'port' (int) and 'shutdown' (bool)"
            }
        });
    }
    var serverPort = +req.query.port;
    if (isNaN(serverPort) || serverPort < 1024 || serverPort > 65535) {
        return res.send({
            result: {
                code: 4,
                msg: "Invalid port. A valid port is in the range 1024-65535."
            }
        }); //could allow 1-65535
    }

    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (!isRunningBehindProxy) {
        ip = req.connection.remoteAddress;
    }
    ip = ip.trim();

    if (!/^((25[0-5]|2[0-4]\d|([0-1]?\d)?\d)\.){3}(25[0-5]|2[0-4]\d|([0-1]?\d)?\d)$/.test(ip)) {
        return res.send({
            result: {
                code: 5,
                msg: "Invalid IP address."
            }
        }); //unlikely
    }

    var uri = ip + ":" + serverPort;

    if (shutdown) { // server shutting down so delete its entries from redis
        client.srem("servers", uri);
        client.del(uri + ":info");
        console.log("Removed server", uri); //you wanted to actually log this, right?
        return res.send({
            result: {
                code: 0,
                msg: "Removed server from list"
            }
        });
    }

    jsonGet({
        uri: "http://" + uri + "/",
        timeout: 10 * 1000
    }, function(json) {
        var isError = json.error !== undefined ? json.error === "true" : false;
        if (isError) {
            return res.send({
                result: {
                    code: 2,
                    msg: "Failed to retrieve server info JSON from " + uri
                }
            });
        }

        var serverGamePort = +json.port;

        if (isNaN(serverGamePort) || serverGamePort < 1024 || serverGamePort > 66535) {
            return res.send({
                result: {
                    code: 4,
                    msg: "Server returned invalid port. A valid port is in the range 1024-65535."
                }
            }); //maybe should have unique code, idk
        }

        var gamePortIsOpen = true; // todo: check if game port is accessible
        if (!gamePortIsOpen) {
            return res.send({
                result: {
                    code: 3,
                    msg: "Failed to contact game server, are the ports open and forwarded correctly?"
                }
            });
        }

        // add ip to our servers set, if it already exists then it'll silently fail
        client.sadd("servers", uri);

        // add/set the ip/port and current time to the db
        client.hmset(uri + ":info", {
            lastUpdate: Math.floor(Date.now() / 1000)
        });

        res.send({
            result: {
                code: 0,
                msg: "Added server to list"
            }
        });
        console.log("Added server", uri);
    });
});

app.get("/list", function(req, res) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Credentials", true);
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");

    var returnData = {
        listVersion: 1,
        result: {
            code: 0,
            msg: "OK",
            servers: []
        }
    };

    client.smembers("servers", function(err, result) {
        if (!result) {
            returnData.result.code = 1;
            returnData.result.msg = "Unable to query database";
            return res.send(returnData);
        }

        function isServerAvailable(uri, callback) {
            client.hgetall(uri + ":info", function(err, obj) {
                // can this be simplified? things i've read from ~2010 say this is the best way
                if (err || typeof obj === undefined || !obj || typeof obj.lastUpdate === undefined || !obj.lastUpdate || obj.lastUpdate === 0) {
                    return callback(false);
                }

                var currentTime = Math.floor(Date.now() / 1000);
                var lastUpdate = parseInt(obj.lastUpdate);
                if (currentTime - lastUpdate > serverContactTimeLimit) {
                    return callback(false);
                }

                callback(true);
            });
        }

        async.filter(result, isServerAvailable, function(results) {
            returnData.result.servers = results;
            return res.send(returnData);
        });
    });
});

app.all("/", function(req, res) {
    res.send(welcomeText);
});

var jsonParser = bodyParser.json();

app.post("/stats", jsonParser, function(req, res) {
    function ReformatKey(isPrivateKey, key) {
        var pos = 0;
        var returnKey = "";
        while (pos < key.length) {
            var toCopy = key.length - pos;
            if (toCopy > 64)
                toCopy = 64;
            returnKey += key.substr(pos, toCopy);
            returnKey += "\n";
            pos += toCopy;
        }
        var keyType = (isPrivateKey ? "RSA PRIVATE KEY" : "PUBLIC KEY"); // public keys don't have RSA in the name some reason
        return "-----BEGIN " + keyType + "-----\n" + returnKey + "-----END " + keyType + "-----\n";
    }
    if (!isRunningStatsServer)
        return res.send({
            result: {
                code: 1,
                msg: "Stats are unsupported on this master server"
            }
        });

    if (!req.body || !req.body.publicKey || !req.body.signature || !req.body.stats)
        return res.send({
            result: {
                code: 2,
                msg: "Invalid stats data"
            }
        });

    var pubKey = ReformatKey(false, req.body.publicKey);

    var verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(req.body.stats);
    var isValidSig = verifier.verify(pubKey, req.body.signature, "base64");

    if (!isValidSig) {
        return res.send({
            result: {
                code: 3,
                msg: "Stats signature invalid"
            }
        });
    }

    res.send({
        result: {
            code: 0,
            msg: "OK"
        }
    });
});

http.createServer(app).listen(appPortNumber, "0.0.0.0", function() {
    console.log('Listening on port ' + appPortNumber);
});
