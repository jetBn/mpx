const path = require('path')
const seen = {}

function stripExtension (request) {
  if (typeof request !== 'string' || request === '') return request
  if (!seen[request]) {
    let queryIndex = request.indexOf('?')
    let query = ''
    let resource = request
    if (queryIndex > -1) {
      query = request.slice(queryIndex)
      resource = request.slice(0, queryIndex)
    }
    let parsed = path.parse(resource)
    seen[request] = path.posix.join(parsed.dir, parsed.name) + query
  }
  return seen[request]
}

module.exports = stripExtension
