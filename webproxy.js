var http = require('http');
var net = require('net');
var modules = {
    url: require('url'),
    fs: require('fs'),
    path: require('path')
};
var settings = require('./config/hostfilters.json');

var debugging = settings.debug || 0;
var defaultPort = settings.port || 8888;

var regex_hostport = /^([^:]+)(:([0-9]+))?$/;

function merge(data, newData, defaults) {
    if (data == null || newData == null) {
        return;
    }
    
    if (typeof(newData) === 'object') {
        var keys = Object.keys(newData);
        keys.forEach(function(key) {
            if (newData[key] == null) {
                return;
            }
            if (!data.hasOwnProperty(key)) {
                var initial = null;
                if (typeof newData[key] === 'object') {
                    initial = {};
                    if (Array.isArray(newData)) {
                        initial = [];
                    }
                }
                data[key] = (defaults ? defaults[key] : initial) || initial;
            }
            if (typeof newData[key] === 'object') {
                merge(data[key], newData[key], defaults ? defaults[key] : undefined);
                return;
            }
            data[key] = newData[key];
        });
        return;
    }
    console.warn('merge: data is of type', typeof data, 'and can not be modified!');
}

modules.fs.watch('./config/hostfilters.json', { persistent: false }, function(event, filename) {
    console.log('File change detected', event, filename);
    try {
        modules.fs.readFile('./config/hostfilters.json', { encoding: 'utf8' }, function(err, data) {
            if (err) {
                throw err;
            }
            
            var newSettings = JSON.parse(data);
            console.log('settings: old', settings, 'new', newSettings);
            settings = {};
            merge(settings, newSettings);
            
            console.log('debug type:', typeof newSettings.debug);
            if (typeof newSettings.debug === 'number') {
                debugging = newSettings.debug;
            }
        });
    } catch(ignore) {}
});

function debug(level) {
    return !(debugging < level);
}

function getHostPortFromString(hostString, defaultPort) {
    var host = hostString;
    var port = defaultPort;

    var result = regex_hostport.exec(hostString);
    if (result != null) {
        host = result[1];
        if (result[2] != null) {
            port = result[3];
        }
    }

    return ([host, port]);
}

// handle a HTTP proxy request
function httpUserRequest(userRequest, userResponse) {
    var restrictDebug = userRequest.url.match(/\/ws\/target/);
    
    if (!restrictDebug && debug(1)) {
        console.log('  > request: %s', userRequest.url);
    }

    var uri = modules.url.parse(userRequest.url).pathname;
    var filename = modules.path.join(process.cwd(), 'ssl', uri);
    if (userRequest.headers.host === 'localhost.com' && modules.fs.existsSync(filename)) {
        userResponse.writeHead(200, {
            'Content-Type': 'application/x-x509-ca-cert',
            'Content-Description': 'File Transfer',
            'Content-Disposition: attachment': 'filename=' + modules.path.basename(filename),
            'Expires': '0',
            'Cache-Control': 'must-revalidate, post-check=0, pre-check=0',
            'Pragma': 'public'
        });

        var fileStream = modules.fs.createReadStream(filename);
        fileStream.pipe(userResponse);
        return;
    }

    var httpVersion = userRequest['httpVersion'];
    var hostport = getHostPortFromString(userRequest.headers['host'], 80);

    // have to extract the path from the requested URL
    var path = userRequest.url;
    var result = /^[a-zA-Z]+:\/\/[^\/]+(\/.*)?$/.exec(userRequest.url);
    if (result) {
        if (result[1].length > 0) {
            path = result[1];
        } else {
            path = "/";
        }
    }

    var options = {
        'host': hostport[0],
        'port': hostport[1],
        'method': userRequest.method,
        'path': path,
        'agent': userRequest.agent,
        'auth': userRequest.auth,
        'headers': userRequest.headers
    };

    if (!restrictDebug && debug(2)) {
        console.log('  > options: %s', JSON.stringify(options, null, 2));
    }

    var proxyRequest = http.request(
        options,
        function (proxyResponse) {
            if (!restrictDebug && debug(2)) {
                console.log('  > request headers: %s', JSON.stringify(options['headers'], null, 2));
            }

            if (!restrictDebug && debug(2)) {
                console.log('  < response %d headers: %s', proxyResponse.statusCode, JSON.stringify(proxyResponse.headers, null, 2));
            }

            userResponse.writeHead(
                proxyResponse.statusCode,
                proxyResponse.headers
            );

            proxyResponse.on(
                'data',
                function (chunk) {
                    if (!restrictDebug && debug(3)) {
                        console.log('  < chunk = %d bytes', chunk.length);
                    }
                    userResponse.write(chunk);
                }
            );

            proxyResponse.on(
                'end',
                function () {
                    if (!restrictDebug && debug(3)) {
                        console.log('  < END');
                    }
                    userResponse.end();
                }
            );
        }
    );

    proxyRequest.on(
        'error',
        function (error) {
            userResponse.writeHead(500);
            userResponse.write(
                "<h1>500 Error</h1>\r\n" +
                "<p>Error was <pre>" + error + "</pre></p>\r\n" +
                "</body></html>\r\n"
            );
            userResponse.end();
        }
    );

    userRequest.addListener(
        'data',
        function (chunk) {
            if (!restrictDebug && debug(3)) {
                console.log('  > chunk = %d bytes', chunk.length);
            }
            proxyRequest.write(chunk);
        }
    );

    userRequest.addListener(
        'end',
        function () {
            proxyRequest.end();
        }
    );
}

function isNumber(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

function main() {
    var port = 8888; // default port if none on command line

    // check for any command line arguments
    for (var argn = 2; argn < process.argv.length; argn++) {
        if (process.argv[argn] === '-p') {
            port = parseInt(process.argv[argn + 1]);
            argn++;
            continue;
        }

        if (process.argv[argn] === '-d') {
            debugging = 1;
            if (argn + 1 < process.argv.length && isNumber(process.argv[argn + 1])) {
                debugging = parseInt(process.argv[argn + 1]);
            }
            continue;
        }
    }

    if (debug(1)) {
        console.log('server listening on port ' + port);
    }

    // start HTTP server with custom request handler callback function
    var server = http.createServer(httpUserRequest).listen(port);

    // add handler for HTTPS (which issues a CONNECT to the proxy)
    server.addListener(
        'connect',
        function (request, socketRequest, bodyhead) {
            var url = request['url'];
            var httpVersion = request['httpVersion'];
            
            var restrictDebug = url.match(/\/ws\/target/);

            var hostport = getHostPortFromString(url, 443);
            if (settings.filters) {
                if (settings.filters.hasOwnProperty(hostport[0])) {
                    if (debug(3)) {
                        console.log('  = should connect to site (%s:%s)', hostport[0], hostport[1]);
                    }
                    // port needs to be changed first in case host also's going to change
                    if (settings.filters[hostport[0]].port) {
                        hostport[1] = settings.filters[hostport[0]].port;
                    }
                    if (settings.filters[hostport[0]].host) {
                        hostport[0] = settings.filters[hostport[0]].host;
                    }
                }
            }

            if (!restrictDebug && debug(1)) {
                console.log('  = will connect to %s:%s', hostport[0], hostport[1]);
                console.log('  = header: %s', bodyhead);
            }

            // set up TCP connection
            var proxySocket = new net.Socket();
            proxySocket.connect(
                parseInt(hostport[1]), hostport[0],
                function () {
                    if (!restrictDebug && debug(1))
                        console.log('  < connected to %s/%s', hostport[0], hostport[1]);

                    if (!restrictDebug && debug(2))
                        console.log('  > writing head of length %d', bodyhead.length);

                    proxySocket.write(bodyhead);

                    // tell the caller the connection was successfully established
                    socketRequest.write("HTTP/" + httpVersion + " 200 Connection established\r\n\r\n");
                }
            );

            proxySocket.on(
                'data',
                function (chunk) {
                    if (debug(3)) {
                        console.log('  < data length = %d', chunk.length);
                    }

                    socketRequest.write(chunk);
                }
            );

            proxySocket.on(
                'end',
                function () {
                    if (debug(3))
                        console.log('  < end');

                    socketRequest.end();
                }
            );

            socketRequest.on(
                'data',
                function (chunk) {
                    if (debug(3))
                        console.log('  > data length = %d', chunk.length);

                    proxySocket.write(chunk);
                }
            );

            socketRequest.on(
                'end',
                function () {
                    if (debug(3))
                        console.log('  > end');

                    proxySocket.end();
                }
            );

            proxySocket.on(
                'error',
                function (err) {
                    socketRequest.write("HTTP/" + httpVersion + " 500 Connection error\r\n\r\n");
                    if (debug(2)) {
                        console.log('  < ERR: %s', err);
                    }
                    socketRequest.end();
                }
            );

            socketRequest.on(
                'error',
                function (err) {
                    if (debug(2)) {
                        console.log('  > ERR: %s', err);
                    }
                    proxySocket.end();
                }
            );
        }
    ); // HTTPS connect listener
}

main();