const {
  objectExists,
  putObject,
  getObjectBuffer,
} = require("../storage/s3Client");

async function checkCache(derivedKey) {
  return objectExists(derivedKey);
}

async function getFromCache(derivedKey) {
  return getObjectBuffer(derivedKey);
}

async function saveToCache(derivedKey, buffer, contentType) {
  return putObject(derivedKey, buffer, contentType);
}

module.exports = { checkCache, getFromCache, saveToCache };
