const {
  objectExists,
  putObject,
  getObjectBuffer,
  getObjectMetadata,
} = require("../storage/s3Client");

async function checkCache(derivedKey) {
  return objectExists(derivedKey);
}

async function getFromCache(derivedKey, opts = {}) {
  return getObjectBuffer(derivedKey, opts);
}

async function getCacheMetadata(derivedKey) {
  return getObjectMetadata(derivedKey);
}

async function saveToCache(derivedKey, buffer, contentType) {
  return putObject(derivedKey, buffer, contentType);
}

module.exports = { checkCache, getFromCache, getCacheMetadata, saveToCache };
