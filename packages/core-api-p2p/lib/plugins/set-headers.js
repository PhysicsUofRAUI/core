'use strict';

const config = require('@arkecosystem/core-plugin-manager').get('config')

/**
 * [description]
 * @param  {[type]} server
 * @param  {Object} options
 * @return {void}
 */
const register = async (server, options) => {
  const headers = {
    nethash: config.network.nethash,
    version: config.server.version,
    port: config.server.port,
    os: require('os').platform()
  }

  const requiredHeaders = ['nethash', 'version', 'port', 'os']

  server.ext({
    type: 'onPreResponse',
    method: async (request, h) => {
      if (request.response.isBoom) {
        requiredHeaders.forEach((key) => (request.response.output.headers[key] = headers[key]))
      } else {
        requiredHeaders.forEach((key) => request.response.header(key, headers[key]))
      }

      return h.continue
    }
  })
}

/**
 * The struct used by hapi.js.
 * @type {Object}
 */
exports.plugin = {
  name: 'hapi-p2p-set-headers',
  version: '1.0.0',
  register
}
