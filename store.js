const fs = require('fs');
const path = require('path');

const CODES_FILE = path.join(__dirname, 'codes.json');
const isVercel = !!process.env.VERCEL;

let redis = null;
if (isVercel) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

const REDIS_KEY = 'codes';

async function readCodes() {
  if (redis) {
    const data = await redis.get(REDIS_KEY);
    return data || {};
  }
  return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
}

async function writeCodes(codes) {
  if (redis) {
    await redis.set(REDIS_KEY, codes);
    return;
  }
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}

module.exports = { readCodes, writeCodes };
