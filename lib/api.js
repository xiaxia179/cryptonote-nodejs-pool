/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool API
 **/

// Load required modules
var fs = require('fs');
var http = require('http');
var https = require('https');
var url = require("url");
var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var authSid = Math.round(Math.random() * 10000000000) + '' + Math.round(Math.random() * 10000000000);

var charts = require('./charts.js');
var notifications = require('./notifications.js');
var utils = require('./utils.js');

// Initialize log system
var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

// Data storage variables used for live statistics
var currentStats = {};
var minerStats = {};
var minersHashrate = {};

var liveConnections = {};
var addressConnections = {};

/**
 * Handle server requests
 **/
function handleServerRequest(request, response) {
    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        // Pool statistics
        case '/stats':
            handleStats(urlParts, request, response);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Connection': 'keep-alive'
            });

            var address = urlParts.query.address ? urlParts.query.address : 'undefined';
            var uid = Math.random().toString();
            var key = address + '+' + uid;

            response.on("finish", function() {
                delete liveConnections[key];
            });
            response.on("close", function() {
                delete liveConnections[key];
            });

            liveConnections[key] = response;
            break;

        // Worker statistics
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;

        // Payments
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;

        // Blocks
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;

        // Top 10 miners
        case '/get_top10miners':
            handleTopMiners(response);
            break;

        // Miner settings
        case '/get_miner_payout_level':
            handleGetMinerPayoutLevel(urlParts, response);
            break;
        case '/set_miner_payout_level':
            handleSetMinerPayoutLevel(urlParts, response);
            break;
        case '/get_email_notifications':
            handleGetMinerNotifications(urlParts, response);
            break;
        case '/set_email_notifications':
            handleSetMinerNotifications(urlParts, response);
            break;
        case '/set_telegram_notifications':
            handleTelegramNotifications(urlParts, response);
            break;
     
        // Miners hashrate (used for charts)
        case '/miners_hashrate':
            if (!authorize(request, response)) {
                return;
            }
            handleGetMinersHashrate(response);
            break;

        // Pool Administration
        case '/admin_stats':
            if (!authorize(request, response))
                return;
            handleAdminStats(response);
            break;
        case '/admin_monitoring':
            if (!authorize(request, response)) {
                return;
            }
            handleAdminMonitoring(response);
            break;
        case '/admin_log':
            if (!authorize(request, response)) {
                return;
            }
            handleAdminLog(urlParts, response);
            break;
        case '/admin_users':
            if (!authorize(request, response)) {
                return;
            }
            handleAdminUsers(response);
            break;
        case '/admin_ports':
            if (!authorize(request, response)) {
                return;
            }
            handleAdminPorts(response);
            break;

        // Test notifications
	case '/test_email_notification':
            if (!authorize(request, response)) {
                return;
            }
	    handleTestEmailNotification(urlParts, response);
            break;
        case '/test_telegram_notification':
            if (!authorize(request, response)) {
                return;
            }
	    handleTestTelegramNotification(urlParts, response);
            break;    
        
        // Default response
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }
}

/**
 * Collect statistics data
 **/
function collectStats(){
    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var redisCommands = [
        ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
        ['zrange', config.coin + ':hashrate', 0, -1],
        ['hgetall', config.coin + ':stats'],
        ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
        ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
        ['hgetall', config.coin + ':shares:roundCurrent'],
        ['hgetall', config.coin + ':stats'],
        ['zcard', config.coin + ':blocks:matured'],
        ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
        ['zcard', config.coin + ':payments:all'],
        ['keys', config.coin + ':payments:*']
    ];

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){
                redisFinished = Date.now();
                var dateNowSeconds = Date.now() / 1000 | 0;

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: replies[3].concat(replies[4]),
                    totalBlocks: parseInt(replies[7]) + (replies[3].length / 2),
                    totalDiff: 0,
                    totalShares: 0,
                    efficiency: 100,
                    payments: replies[8],
                    totalPayments: parseInt(replies[9]),
                    totalMinersPaid: replies[10] && replies[10].length > 0 ? replies[10].length - 1 : 0,
                    miners: 0,
                    workers: 0,
                    hashrate: 0,
                    roundHashes: 0
                };

                var effDiffTotals = 0;
                for (var i = 0; i < data.blocks.length; i++){
                    var block = data.blocks[i].split(':');
                    if (block[5]) {
                        var blockShares = parseInt(block[3]);
                        var blockDiff = parseInt(block[2]);
                        data.totalDiff += blockDiff;
                        data.totalShares += blockShares;
                        effDiffTotals += (blockShares / blockDiff);
                    }
                }
                data.efficiency = Math.round( ( 10000 / ( effDiffTotals / data.totalBlocks ))) / 100;

                minerStats = {};
                minersHashrate = {};

                var hashrates = replies[1];
                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minersHashrate[hashParts[1]] = (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }
        
                var totalShares = 0;

                for (var miner in minersHashrate){
                    var addrParts = utils.getAddressParts(miner);
                    if (!addrParts.workerName) {
                        totalShares += minersHashrate[miner];
                        data.miners ++;
                    } else {
                        data.workers ++;
                    }
            
                    minersHashrate[miner] = Math.round(minersHashrate[miner] / config.api.hashrateWindow);

                    if (!minerStats[miner]) { minerStats[miner] = {}; }
                    minerStats[miner]['hashrate'] = minersHashrate[miner];
                }

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);

                data.roundHashes = 0;
        
                if (replies[5]){
                    for (var miner in replies[5]){
                        var roundHashes = 0;
                        if (config.poolServer.slushMining.enabled) {
                            roundHashes = parseInt(replies[5][miner]) / Math.pow(Math.E, ((data.lastBlockFound - dateNowSeconds) / config.poolServer.slushMining.weight)); //TODO: Abstract: If something different than lastBlockfound is used for scoreTime, this needs change.
                        }
                        else {
                            roundHashes = parseInt(replies[5][miner]);
                        }
            
                        data.roundHashes += roundHashes;

                        if (!minerStats[miner]) { minerStats[miner] = {}; }
                        minerStats[miner]['roundHashes'] = roundHashes;
                    }
                }

                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash:  blockHeader.hash
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                cnAlgorithm: config.cnAlgorithm || 'cryptonight',
                cnVariant: config.cnVariant || 0,
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                networkFee: config.blockUnlocker.networkFee || 0,
                coin: config.coin,
                coinUnits: config.coinUnits,
                coinDifficultyTarget: config.coinDifficultyTarget,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                donation: donations,
                version: version,
                paymentsInterval: config.payments.interval,
                minPaymentThreshold: config.payments.minPayment,
                transferFee: config.payments.transferFee,
                denominationUnit: config.payments.denomination,
                blockTime: config.poolServer.slushMining.blockTime,
                slushMiningEnabled: config.poolServer.slushMining.enabled,
                weight: config.poolServer.slushMining.weight,
                priceSource: config.prices ? config.prices.source : 'cryptonator',
                priceCurrency: config.prices ? config.prices.currency : 'USD',
                paymentIdSeparator: config.poolServer.paymentId && config.poolServer.paymentId.addressSeparator ? config.poolServer.paymentId.addressSeparator : ".",
                fixedDiffEnabled: config.poolServer.fixedDiff.enabled,
                fixedDiffSeparator: config.poolServer.fixedDiff.addressSeparator,
                sendEmails: config.email ? config.email.enabled : false
            });
        },
        charts: charts.getPoolChartsData
    }, function(error, results){
        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = results;
            broadcastLiveStats();
        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

/**
 * Broadcast live statistics
 **/
function broadcastLiveStats(){
    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    // Live statistics
    var processAddresses = {};
    for (var key in liveConnections){
        var addrOffset = key.indexOf('+');
        var address = key.substr(0, addrOffset);
        if (!processAddresses[address]) processAddresses[address] = [];
        processAddresses[address].push(liveConnections[key]);
    }
    
    for (var address in processAddresses) {
        var data = currentStats;

        data.miner = {};
        if (address && minerStats[address]){
            data.miner = minerStats[address];
        }

        var destinations = processAddresses[address];
        sendLiveStats(data, destinations);
    }

    // Workers Statistics
    var processAddresses = {};
    for (var key in addressConnections){
        var addrOffset = key.indexOf('+');
        var address = key.substr(0, addrOffset);
        if (!processAddresses[address]) processAddresses[address] = [];
        processAddresses[address].push(addressConnections[key]);
    }
    
    for (var address in processAddresses) {
        broadcastWorkerStats(address, processAddresses[address]);
    }
}

/**
 * Broadcast worker statistics
 **/
function broadcastWorkerStats(address, destinations) {
    var redisCommands = [
        ['hgetall', config.coin + ':workers:' + address],
        ['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES'],
        ['keys', config.coin + ':unique_workers:' + address + '+*']
    ];
    redisClient.multi(redisCommands).exec(function(error, replies){
        if (error || !replies || !replies[0]){
            sendLiveStats({error: 'Not found'}, destinations);
            return;
        }

        var stats = replies[0];
        stats.hashrate = minerStats[address] && minerStats[address]['hashrate'] ? minerStats[address]['hashrate'] : 0;
        stats.roundHashes = minerStats[address] && minerStats[address]['roundHashes'] ? minerStats[address]['roundHashes'] : 0;

        var paymentsData = replies[1];
      
        var workersData = [];
        for (var j=0; j<replies[2].length; j++) {
            var key = replies[2][j];
            var keyParts = key.split(':');
            var miner = keyParts[2];
            var addrParts = utils.getAddressParts(miner);
            if (addrParts.workerName) {
                var workerData = {
                    name: addrParts.workerName,
                    hashrate: minerStats[miner] && minerStats[miner]['hashrate'] ? minerStats[miner]['hashrate'] : 0
                };
                workersData.push(workerData);
            }
        }

        charts.getUserChartsData(address, paymentsData, function(error, chartsData) {
            var redisCommands = [];
            for (var i in workersData){
                redisCommands.push(['hgetall', config.coin + ':unique_workers:' + address + '+' + workersData[i].name]);
            }
            redisClient.multi(redisCommands).exec(function(error, replies){
                for (var i in workersData) {
                    if (!replies[i]) continue;
                    workersData[i].lastShare = replies[i]['lastShare'] ? parseInt(replies[i]['lastShare']) : 0;
                    workersData[i].hashes = replies[i]['hashes'] ? parseInt(replies[i]['hashes']) : 0;
                }

                var data = {
                    stats: stats,
                    payments: paymentsData,
                    charts: chartsData,
                    workers: workersData
                };

                sendLiveStats(data, destinations);
            });
        });
    });
}

/**
 * Send live statistics to specified destinations
 **/
function sendLiveStats(data, destinations){
    if (!destinations) return ;

    var dataJSON = JSON.stringify(data);
    for (var i in destinations) {
        destinations[i].end(dataJSON);
    }
}

/**
 * Return pool statistics
 **/
function handleStats(urlParts, request, response){
    var data = currentStats;

    data.miner = {};
    var address = urlParts.query.address;
    if (address && minerStats[address]) {
        data.miner = minerStats[address];
    }

    var dataJSON = JSON.stringify(data);

    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': dataJSON.length
    });
    response.end(dataJSON);
}

/**
 * Return miner (worker) statistics
 **/
function handleMinerStats(urlParts, response){
    var address = urlParts.query.address;
    var longpoll = (urlParts.query.longpoll === 'true');
    
    if (longpoll){
        response.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive'
        });
        
        redisClient.exists(config.coin + ':workers:' + address, function(error, result){
            if (!result){
                response.end(JSON.stringify({error: 'Not found'}));
                return;
            }
        
            var address = urlParts.query.address;
            var uid = Math.random().toString();
            var key = address + '+' + uid;
        
            response.on("finish", function() {
                delete addressConnections[key];
            });
            response.on("close", function() {
                delete addressConnections[key];
            });

            addressConnections[key] = response;
        });
    }
    else{
        redisClient.multi([
            ['hgetall', config.coin + ':workers:' + address],
            ['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES'],
            ['keys', config.coin + ':unique_workers:' + address + '+*']
        ]).exec(function(error, replies){
            if (error || !replies[0]){
                var dataJSON = JSON.stringify({error: 'Not found'});
                response.writeHead("200", {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'Content-Length': dataJSON.length
                });
                response.end(dataJSON);
                return;
            }
        
            var stats = replies[0];
            stats.hashrate = minerStats[address] && minerStats[address]['hashrate'] ? minerStats[address]['hashrate'] : 0;
            stats.roundHashes = minerStats[address] && minerStats[address]['roundHashes'] ? minerStats[address]['roundHashes'] : 0;

            var paymentsData = replies[1];
        
            var workersData = [];
            for (var i=0; i<replies[2].length; i++) {
                var key = replies[2][i];
                var keyParts = key.split(':');
                var miner = keyParts[2];
                var addrParts = utils.getAddressParts(miner);
                if (addrParts.workerName) {
                    var workerData = {
                        name: addrParts.workerName,
                        hashrate: minerStats[miner] && minerStats[miner]['hashrate'] ? minerStats[miner]['hashrate'] : 0
                    };
                    workersData.push(workerData);
                }
            }

            charts.getUserChartsData(address, paymentsData, function(error, chartsData) {
                var redisCommands = [];
                for (var i in workersData){
                    redisCommands.push(['hgetall', config.coin + ':unique_workers:' + address + '+' + workersData[i].name]);
                }
                redisClient.multi(redisCommands).exec(function(error, replies){
                    for (var i in workersData){
                        if (!replies[i]) continue;
                        workersData[i].lastShare = replies[i]['lastShare'] ? parseInt(replies[i]['lastShare']) : 0;
                        workersData[i].hashes = replies[i]['hashes'] ? parseInt(replies[i]['hashes']) : 0;
                    }
            
                    var dataJSON = JSON.stringify({
                        stats: stats,
                        payments: paymentsData,
                        charts: chartsData,
                        workers: workersData
                    });
            
                    response.writeHead("200", {
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                        'Content-Type': 'application/json',
                        'Content-Length': dataJSON.length
                    });
                    response.end(dataJSON);
                });
            });
        });
    }
}

/**
 * Return payments history
 **/
function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
        paymentKey = ':payments:' + urlParts.query.address;

    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){
            var reply;

            if (err)
                reply = JSON.stringify({error: 'Query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);
        }
    )
}

/**
 * Return blocks data
 **/
function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'Query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}

/**
 * Return top 10 miners
 **/
function handleTopMiners(response) {
    async.waterfall([
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'lastShare', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var minersData = [];
                for (var i in redisData) {
                    var keyParts = workerKeys[i].split(':');
                    var address = keyParts[keyParts.length-1];
                    var data = redisData[i];
                    minersData.push({
                        miner: address.substring(0,7)+'****'+address.substring(address.length-7),
                        hashrate: minersHashrate[address] && minerStats[address]['hashrate'] ? minersHashrate[address] : 0,
                        lastShare: data[0],
                        hashes: data[1]
                    });
                }
                callback(null, minersData);
            });
        }
    ], function(error, data) {
        if(error) {
            response.end(JSON.stringify({error: 'Error collecting top 10 miners stats'}));
            return;
        }

        data.sort(compareTopMiners);
        data = data.slice(0,10);

        var reply = JSON.stringify(data);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);
    });
}

function compareTopMiners(a,b) {
    var v1 = a.hashrate ? parseInt(a.hashrate) : 0;
    var v2 = b.hashrate ? parseInt(b.hashrate) : 0;
    if (v1 > v2) return -1;
    if (v1 < v2) return 1;
    return 0;
}

/**
 * Miner settings: minimum payout level
 **/
 
// Get current minimum payout level
function handleGetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Return current miner payout level
    redisClient.hget(config.coin + ':workers:' + address, 'minPayoutLevel', function(error, value){
        if (error){
            response.end(JSON.stringify({'status': 'Unable to get the current minimum payout level from database'}));
            return;
        }
    
        var minLevel = config.payments.minPayment / config.coinUnits;
        if (minLevel < 0) minLevel = 0;

        var currentLevel = value / config.coinUnits;
        if (currentLevel < minLevel) currentLevel = minLevel;

        response.end(JSON.stringify({'status': 'done', 'level': currentLevel}));
    });
}

// Set minimum payout level
function handleSetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;
    var ip = urlParts.query.ip;
    var level = urlParts.query.level;

    // Check the minimal required parameters for this handle.
    if (ip === undefined || address === undefined || level === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') !== -1 || address.indexOf('*') !== -1) {
        response.end(JSON.stringify({'status': 'Remove the wildcard from your miner address'}));
        return;
    }

    level = parseFloat(level);
    if (isNaN(level)) {
        response.end(JSON.stringify({'status': 'Your minimum payout level doesn\'t look like a number'}));
        return;
    }

    var minLevel = config.payments.minPayment / config.coinUnits;
    if (minLevel < 0) minLevel = 0;

    if (level < minLevel) {
        response.end(JSON.stringify({'status': 'The minimum payout level is ' + minLevel}));
        return;
    }

    // Only do a modification if we have seen the IP address in combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, function (error, found) {
        if (!found || error) {
          response.end(JSON.stringify({'status': 'We haven\'t seen that IP for your address'}));
          return;
        }

        var payoutLevel = level * config.coinUnits;
        redisClient.hset(config.coin + ':workers:' + address, 'minPayoutLevel', payoutLevel, function(error, value){
            if (error){
                response.end(JSON.stringify({'status': 'An error occurred when updating the value in our database'}));
                return;
            }

            log('info', logSystem, 'Updated minimum payout level for ' + address + ' to: ' + payoutLevel);
            response.end(JSON.stringify({'status': 'done'}));
        });
    });
}

/**
 * Miner settings: email notifications
 **/

// Get destination for email notifications
function handleGetMinerNotifications(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Return current email for notifications
    redisClient.hget(config.coin + ':notifications', address, function(error, value){
        if (error){
            response.end(JSON.stringify({'email': 'Unable to get current email from database'}));
            return;
        }
        response.end(JSON.stringify({'email': value}));
    });
}

// Set email notifications
function handleSetMinerNotifications(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var email = urlParts.query.email;
    var address = urlParts.query.address;
    var ip = urlParts.query.ip;
    var action = urlParts.query.action;

    // Check the minimal required parameters for this handle.
    if (ip === undefined || address === undefined || action === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') !== -1 || address.indexOf('*') !== -1) {
        response.end(JSON.stringify({'status': 'Remove the wildcard from your input'}));
        return;
    }

    // Check the action
    if (action === undefined || action === '' || (action != 'enable' && action != 'disable')) {
        response.end(JSON.stringify({'status': 'Invalid action'}));
        return;
    }
    
    // Now only do a modification if we have seen the IP address in combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, function (error, found) {
        if (!found || error) {
          response.end(JSON.stringify({'status': 'We haven\'t seen that IP for your address'}));
          return;
        }

        if (action === "enable") {
            if (email === undefined) {
                response.end(JSON.stringify({'status': 'No email address specified'}));
                return;
            }
            redisClient.hset(config.coin + ':notifications', address, email, function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'Unable to add email address in database'}));
                    return;
                }

                log('info', logSystem, 'Enable email notifications to ' + email + ' for address: ' + address);
                notifications.sendToMiner(address, 'emailAdded', {
                    'ADDRESS': address,
                    'EMAIL': email
                });
            });
            response.end(JSON.stringify({'status': 'done'}));
        }
        else if (action === "disable") {
            redisClient.hdel(config.coin + ':notifications', address, function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'Unable to remove email address from database'}));
                    return;
                }
                log('info', logSystem, 'Disabled email notifications for address: ' + address);
            });
            response.end(JSON.stringify({'status': 'done'}));
        }
    });
}

/**
 * Miner settings: telegram notifications
 **/

// Enable/disable telegram notifications
function handleTelegramNotifications(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var chatId = urlParts.query.chatId;
    var address = urlParts.query.address;
    var action = urlParts.query.action;

    // Check chat id
    if (chatId === undefined || chatId === '') {
        response.end(JSON.stringify({'status': 'No chat id specified'}));
        return;
    }
    
    // Check address
    if (address === undefined || address === '') {
        response.end(JSON.stringify({'status': 'No miner address specified'}));
        return;
    }

    // Check the action
    if (action === undefined || action === '' || (action != 'enable' && action != 'disable')) {
        response.end(JSON.stringify({'status': 'Invalid action'}));
        return;
    }

    // Check if miner exists
    redisClient.exists(config.coin + ':workers:' + address, function(error, result){
        if (!result){
            response.end(JSON.stringify({status: 'Miner not found in database'}));
            return;
        }

        // Enable
        if (action === "enable") {
            redisClient.hset(config.coin + ':telegram', address, chatId, function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'Unable to enable telegram notifications'}));
                    return;
                }

                log('info', logSystem, 'Enabled telegram notifications to ' + chatId + ' for address: ' + address);
            });
            response.end(JSON.stringify({'status': 'done'}));
        }
    
        // Disable
        else if (action === "disable") {
            redisClient.hdel(config.coin + ':telegram', address, function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'Unable to disable telegram notifications'}));
                    return;
                }
                log('info', logSystem, 'Disabled telegram notifications for address: ' + address);
            });
            response.end(JSON.stringify({'status': 'done'}));
        }
    });
}

/**
 * Return miners hashrate
 **/
function handleGetMinersHashrate(response) {
    var data = {};
    for (var miner in minersHashrate){
        var addrParts = utils.getAddressParts(miner);
        if (addrParts.workerName) continue;
        data[miner] = minersHashrate[miner];
    }

    var reply = JSON.stringify({
        minersHashrate: data
    });

    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

/**
 * Authorize access to a secured API call
 **/
function authorize(request, response){
    var remoteAddress = request.connection.remoteAddress;
    if(config.api.trustProxyIP && request.headers['x-forwarded-for']){
      remoteAddress = request.headers['x-forwarded-for'];
    }
    
    if(remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1' || remoteAddress === '::1') {
        return true;
    }

    response.setHeader('Access-Control-Allow-Origin', '*');

    var cookies = parseCookies(request);
    if(cookies.sid && cookies.sid === authSid) {
        return true;
    }

    var sentPass = url.parse(request.url, true).query.password;

    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    log('warn', logSystem, 'Admin authorized');
    response.statusCode = 200;

    var cookieExpire = new Date( new Date().getTime() + 60*60*24*1000);
    response.setHeader('Set-Cookie', 'sid=' + authSid + '; path=/; expires=' + cookieExpire.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');

    return true;
}

/**
 * Administration: return pool statistics
 **/
function handleAdminStats(response){
    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'Error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}

/**
 * Administration: users list
 **/
function handleAdminUsers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'balance', 'paid', 'lastShare', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var workersData = {};
                for(var i in redisData) {
                    var keyParts = workerKeys[i].split(':');
                    var address = keyParts[keyParts.length-1];
                    var data = redisData[i];
                    workersData[address] = {
                        pending: data[0],
                        paid: data[1],
                        lastShare: data[2],
                        hashes: data[3],
                        hashrate: minerStats[address] && minerStats[address]['hashrate'] ? minerStats[address]['hashrate'] : 0,
                        roundHashes: minerStats[address] && minerStats[address]['roundHashes'] ? minerStats[address]['roundHashes'] : 0
                    };
                }
                callback(null, workersData);
            });
        }
        ], function(error, workersData) {
            if(error) {
                response.end(JSON.stringify({error: 'Error collecting users stats'}));
                return;
            }
            response.end(JSON.stringify(workersData));
        }
    );
}

/**
 * Administration: pool monitoring
 **/
function handleAdminMonitoring(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}

/**
 * Administration: log file data
 **/
function handleAdminLog(urlParts, response){
    var file = urlParts.query.file;
    var filePath = config.logging.files.directory + '/' + file;
    if(!file.match(/^\w+\.log$/)) {
        response.end('wrong log file');
    }
    response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response);
}

/**
 * Administration: pool ports usage
 **/
function handleAdminPorts(response){
    async.waterfall([
        function(callback) {
            redisClient.keys(config.coin + ':ports:*', callback);
        },
        function(portsKeys, callback) {
            var redisCommands = portsKeys.map(function(k) {
                return ['hmget', k, 'port', 'users'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var portsData = {};
                for (var i in redisData) {
                    var port = portsKeys[i];

                    var data = redisData[i];
                    portsData[port] = {
                        port: data[0],
                        users: data[1]
                    };
                }
                callback(null, portsData);
            });
        }
    ], function(error, portsData) {
        if(error) {
            response.end(JSON.stringify({error: 'Error collecting Ports stats'}));
            return;
        }
        response.end(JSON.stringify(portsData));
    });
}

/**
 * Administration: test email notification
 **/
function handleTestEmailNotification(urlParts, response) {
    var email = urlParts.query.email;
    if (!config.email) {
        response.end(JSON.stringify({'status': 'Email system is not configured'}));
        return;
    }
    if (!config.email.enabled) {
        response.end(JSON.stringify({'status': 'Email system is not enabled'}));
        return;
    }
    if (!email) {
        response.end(JSON.stringify({'status': 'No email specified'}));
        return;
    }
    log('info', logSystem, 'Sending test e-mail notification to %s', [email]);
    notifications.sendToEmail(email, 'test', {});
    response.end(JSON.stringify({'status': 'done'}));
}

/**
 * Administration: test telegram notification
 **/
function handleTestTelegramNotification(urlParts, response) {
    if (!config.telegram) {
        response.end(JSON.stringify({'status': 'Telegram is not configured'}));
        return;
    }
    if (!config.telegram.enabled) {
        response.end(JSON.stringify({'status': 'Telegram is not enabled'}));
        return;
    }
    if (!config.telegram.token) {
        response.end(JSON.stringify({'status': 'No telegram bot token specified in configuration'}));
        return;
    }
    if (!config.telegram.channel) {
        response.end(JSON.stringify({'status': 'No telegram channel specified in configuration'}));
        return;
    }	    
    log('info', logSystem, 'Sending test telegram channel notification');
    notifications.sendToTelegramChannel('test', {});
    response.end(JSON.stringify({'status': 'done'}));
}

/**
 * RPC monitoring of daemon and wallet
 **/

// Start RPC monitoring
function startRpcMonitoring(rpc, module, method, interval) {
    setInterval(function() {
        rpc(method, {}, function(error, response) {
            var stat = {
                lastCheck: new Date() / 1000 | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response)
            };
            if(error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }
            var key = getMonitoringDataKey(module);
            var redisCommands = [];
            for(var property in stat) {
                redisCommands.push(['hset', key, property, stat[property]]);
            }
            redisClient.multi(redisCommands).exec();
        });
    }, interval * 1000);
}

// Return monitoring data key
function getMonitoringDataKey(module) {
    return config.coin + ':status:' + module;
}

// Initialize monitoring
function initMonitoring() {
    var modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet
    };
    for(var module in config.monitoring) {
        var settings = config.monitoring[module];
        if(settings.checkInterval) {
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval);
        }
    }
}

// Get monitoring data
function getMonitoringData(callback) {
    var modules = Object.keys(config.monitoring);
    var redisCommands = [];
    for(var i in modules) {
        redisCommands.push(['hgetall', getMonitoringDataKey(modules[i])])
    }
    redisClient.multi(redisCommands).exec(function(error, results) {
        var stats = {};
        for(var i in modules) {
            if(results[i]) {
                stats[modules[i]] = results[i];
            }
        }
        callback(error, stats);
    });
}

/**
 * Return pool public ports
 **/
function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

/**
 * Return list of pool logs file
 **/
function getLogFiles(callback) {
    var dir = config.logging.files.directory;
    fs.readdir(dir, function(error, files) {
        var logs = {};
        for(var i in files) {
            var file = files[i];
            var stats = fs.statSync(dir + '/' + file);
            logs[file] = {
                size: stats.size,
                changed: Date.parse(stats.mtime) / 1000 | 0
            }
        }
        callback(error, logs);
    });
}

/**
 * Check if a miner has been seen with specified IP address
 **/
function minerSeenWithIPForAddress(address, ip, callback) {
    var ipv4_regex = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    if (ipv4_regex.test(ip)) {
        ip = '::ffff:' + ip;
    }
    redisClient.sismember([config.coin + ':workers_ip:' + address, ip], function(error, result) {
        var found = result > 0 ? true : false;
        callback(error, found);
    });
}

/**
 * Parse cookies data
 **/
function parseCookies(request) {
    var list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        list[parts.shift().trim()] = unescape(parts.join('='));
    });
    return list;
}
/**
 * Start pool API
 **/

// Collect statistics for the first time
collectStats();

// Initialize RPC monitoring
initMonitoring();

// Enable to be bind to a certain ip or all by default
var bindIp = config.api.bindIp ? config.api.bindIp : "0.0.0.0";

// Start API on HTTP port
var server = http.createServer(function(request, response){
    if (request.method.toUpperCase() === "OPTIONS"){
        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });
        return(response.end());
    }

    handleServerRequest(request, response);
});

server.listen(config.api.port, bindIp, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});

// Start API on SSL port
if (config.api.ssl){
    if (!config.api.sslCert) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL certificate not configured', [config.api.sslPort]);
    } else if (!config.api.sslKey) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL key not configured', [config.api.sslPort]);
    } else if (!config.api.sslCA) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL certificate authority not configured', [config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslCert)) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL certificate file not found (configuration error)', [config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslKey)) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL key file not found (configuration error)', [config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslCA)) {
        log('error', logSystem, 'Could not start API listening on port %d (SSL): SSL certificate authority file not found (configuration error)', [config.api.sslPort]);
    } else {
        var options = {
            key: fs.readFileSync(config.api.sslKey),
            cert: fs.readFileSync(config.api.sslCert),
            ca: fs.readFileSync(config.api.sslCA),
            honorCipherOrder: true
        };
    
        var ssl_server = https.createServer(options, function(request, response){
            if (request.method.toUpperCase() === "OPTIONS"){
                response.writeHead("204", "No Content", {
                    "access-control-allow-origin": '*',
                    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "access-control-allow-headers": "content-type, accept",
                    "access-control-max-age": 10, // Seconds.
                    "content-length": 0,
                    "strict-transport-security": "max-age=604800"
                });
                return(response.end());
            }

            handleServerRequest(request, response);
        });

        ssl_server.listen(config.api.sslPort, bindIp, function(){
            log('info', logSystem, 'API started & listening on port %d (SSL)', [config.api.sslPort]);
        });
    }
}
