const fs = require('fs');
const path = require('path');

const CODES_FILE = path.join(__dirname, 'codes.json');

function readCodes() {
  return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
}

function writeCodes(codes) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'add': {
    const [code, rubberStamps, mailType, weightGrams] = args;
    if (!code || !rubberStamps) {
      console.log('Usage: node manage.js add CODE "rubber stamps text" [mail_type] [weight_grams]');
      process.exit(1);
    }
    const codes = readCodes();
    const upperCode = code.toUpperCase();
    if (codes[upperCode]) {
      console.log(`Code "${upperCode}" already exists.`);
      process.exit(1);
    }
    codes[upperCode] = {
      rubber_stamps: rubberStamps,
      mail_type: mailType || 'lettermail',
      weight_grams: weightGrams ? Number(weightGrams) : null,
      redeemed: false
    };
    writeCodes(codes);
    console.log(`Added code: ${upperCode}`);
    break;
  }

  case 'remove': {
    const [code] = args;
    if (!code) {
      console.log('Usage: node manage.js remove CODE');
      process.exit(1);
    }
    const codes = readCodes();
    const upperCode = code.toUpperCase();
    if (!codes[upperCode]) {
      console.log(`Code "${upperCode}" not found.`);
      process.exit(1);
    }
    delete codes[upperCode];
    writeCodes(codes);
    console.log(`Removed code: ${upperCode}`);
    break;
  }

  case 'list': {
    const codes = readCodes();
    const entries = Object.entries(codes);
    if (entries.length === 0) {
      console.log('No codes found.');
      break;
    }
    console.log(`${'CODE'.padEnd(20)} ${'RUBBER STAMPS'.padEnd(30)} ${'MAIL TYPE'.padEnd(15)} ${'WEIGHT'.padEnd(10)} STATUS`);
    console.log('-'.repeat(90));
    for (const [code, entry] of entries) {
      const weight = entry.weight_grams ? `${entry.weight_grams}g` : '-';
      const status = entry.redeemed ? 'REDEEMED' : 'AVAILABLE';
      console.log(`${code.padEnd(20)} ${entry.rubber_stamps.padEnd(30)} ${entry.mail_type.padEnd(15)} ${weight.padEnd(10)} ${status}`);
    }
    break;
  }

  case 'reset': {
    const [code] = args;
    if (!code) {
      console.log('Usage: node manage.js reset CODE');
      process.exit(1);
    }
    const codes = readCodes();
    const upperCode = code.toUpperCase();
    if (!codes[upperCode]) {
      console.log(`Code "${upperCode}" not found.`);
      process.exit(1);
    }
    codes[upperCode].redeemed = false;
    writeCodes(codes);
    console.log(`Reset code: ${upperCode}`);
    break;
  }

  default:
    console.log('CODES Manager');
    console.log('Usage:');
    console.log('  node manage.js add CODE "rubber stamps text" [mail_type] [weight_grams]');
    console.log('  node manage.js remove CODE');
    console.log('  node manage.js list');
    console.log('  node manage.js reset CODE');
    break;
}
