const tls = require('tls');
const util = require('util');
const zlib = require('zlib');
const cert = require('./../lib/cert');

/**
 * Get a stream transform to decompress an HTTP response (or null, if none required).
 *
 * NOTE: Does not handle 'compress', but in practice no-one has used that since the 90's.
 *
 * @param {http.ServerResponse} response - The server response to get a decompressor for.
 * @returns {*} - A stream.Transform, or null if no decompression required.
 */
function decompressorFor(response) {
  const contentEncoding = response.headers['content-encoding'];

  switch (contentEncoding) {
    case 'x-gzip':
    case 'gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    default:
      return null;
  }
}

/**
 * Transform the server's response and send it to the proxy client.
 *
 * @param {http.ServerResponse} clientRes - Response to the client.
 * @param {http.IncomingMessage} response - Response from the server.
 * @param {function} transform - How to transform the server's response.
 */
function sendModifiedResponse(clientRes, response, transform) {
  let dataPipe = response;
  const decompressor = decompressorFor(response);
  const chunks = [];

  if (decompressor) {
    dataPipe = dataPipe.pipe(decompressor);
  }

  dataPipe.on('data', function(chunk) {
    chunks.push(chunk);
  });

  dataPipe.on('end', function () {
    const origContent = Buffer.concat(chunks);

    transform(origContent, function (modifiedContent) {
      modifiedContent = new Buffer(modifiedContent);
      response.headers['content-length'] = modifiedContent.length;
      // The response has been de-chunked and uncompressed, so delete
      // these headers from the response.
      delete response.headers['content-encoding'];
      delete response.headers['content-transfer-encoding'];
      clientRes.writeHead(response.statusCode, response.headers);
      clientRes.end(modifiedContent);
    });
  });
}

/**
 * Transform the server's response and send it to the proxy client.
 *
 * @param {http.ServerResponse} clientRes - Response to the client.
 * @param {http.IncomingMessage} response - Response from the server.
 * @param {function} transform - How to transform the server's response.
 */
// TODO: Move logic into sendModifiedResponse
function sendModifiedJsonResponse(clientRes, response, transform) {
  let dataPipe = response;
  const decompressor = decompressorFor(response);
  const chunks = [];

  if (decompressor) {
    dataPipe = dataPipe.pipe(decompressor);
  }

  dataPipe.on('data', function(chunk) {
    chunks.push(chunk);
  });

  dataPipe.on('end', function () {
    const origContent = Buffer.concat(chunks);

    transform(origContent, function (modifiedContent) {
      modifiedContent = new Buffer(JSON.stringify(modifiedContent));
      response.headers['content-length'] = modifiedContent.length;
      // The response has been de-chunked and uncompressed, so delete
      // these headers from the response.
      delete response.headers['content-encoding'];
      delete response.headers['content-transfer-encoding'];
      clientRes.writeHead(response.statusCode, response.headers);
      clientRes.end(modifiedContent);
    });
  });
}

/**
 * Send a server response to the proxy client as-is, without modification.
 *
 * @param {http.ServerResponse} clientRes - Response to the client.
 * @param {http.IncomingMessage} response - Response from the server (to send).
 */
function sendOriginalResponse(clientRes, response) {
  clientRes.writeHead(response.statusCode, response.headers);
  response.pipe(clientRes);
}

/**
 * Return an SNICallback to dynamically generate certificates signed by a CA.
 *
 * This allows you to install 'dummy.crt' as a root cert once, and then access all TLS sites
 * without any further warnings from your browser.
 *
 * NOTE: This only works in node 0.12; in older versions it is not possible to generate certs
 *       asynchronously, because there was no callback argument for SNICallback.
 * NOTE: The OpenSSL command must be in your $PATH for the 'pem' library to work.
 * NOTE: No cache eviction is implemented, this will eventually run out of memory if
 *       implemented "as is" in a long-running process.
 */
function makeSNICallback(caCert, caKey) {
  let serial = Math.floor(Date.now() / 1000);
  const cache = {};

  const ver = process.version.match(/^v(\d+)\.(\d+)/);
  const canUseSNI = ver[1] > 1 || ver[2] >= 12; // >= 0.12.0

  if(!canUseSNI) {
    console.log('Per-site certificate generation is: ' + (canUseSNI ? 'ENABLED' : 'DISABLED'));
    console.log('Feature requires SNI support (node >= v0.12), running version is: ' + ver[0]);

    return undefined;
  }

  const createCertificateAsync = util.promisify(cert.generateForHost);

  return function SNICallback(servername, cb) {
    if(!cache.hasOwnProperty(servername)) {
      // Slow path, put a promise for the cert into cache. Need to increment
      // the serial or browsers will complain.
      console.log('Generating new TLS certificate for: ' + servername);

      cache[servername] = createCertificateAsync(servername, servername, caCert, caKey, serial++).then(function (pem) {
        return tls.createSecureContext({
          key: pem.privateKey,
          cert: pem.certificate,
          ca: caCert,
          honorCipherOrder: true
        }).context;
      });
    }

    cache[servername].then(function (ctx) {
      cb(null, ctx);
    }).catch(function (err) {
      console.log('Error generating TLS certificate: ', err);
      cb(err, null);
    });
  }
}

/**
 * Parses a JSON string and returns an object
 * sometimes JSON.parse is failing, so this function includes a workaround
 *
 * @param content
 * @return Object
 */
function jsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    return new Function('return ' + content)();
  }
}

module.exports = {
  sendModifiedResponse: sendModifiedResponse,
  sendModifiedJsonResponse: sendModifiedJsonResponse,
  sendOriginalResponse: sendOriginalResponse,
  makeSNICallback: makeSNICallback,
  jsonParse: jsonParse
};
