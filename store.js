const fs = require('fs');
const path = require('path');

const CODES_FILE = path.join(__dirname, 'codes.json');
const REDIS_URL = process.env.REDIS_URL;

let redis = null;
if (REDIS_URL) {
  const Redis = require('ioredis');
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
}

const REDIS_KEY = 'codes';

async function readCodes() {
  if (redis) {
    const data = await redis.get(REDIS_KEY);
    return data ? JSON.parse(data) : {};
  }
  return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
}

async function writeCodes(codes) {
  if (redis) {
    await redis.set(REDIS_KEY, JSON.stringify(codes));
    return;
  }
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}

module.exports = { readCodes, writeCodes };
