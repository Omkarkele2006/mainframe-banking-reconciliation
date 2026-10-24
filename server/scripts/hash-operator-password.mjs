import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Run this helper in an interactive terminal so the password is not echoed.\n');
  process.exit(1);
}

process.stdout.write('Enter operator password (12+ chars; input hidden): ');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
let password = '';
process.stdin.on('data', (input) => {
  for (const character of input) {
    if (character === '\u0003') { process.stdout.write('\nCancelled.\n'); process.exit(1); }
    if (character === '\r' || character === '\n') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (password.length < 12 || password.length > 1024) {
        password = '';
        process.stderr.write('Password must be between 12 and 1024 characters.\n');
        process.exit(1);
      }
      const salt = randomBytes(24);
      const hash = scryptSync(password, salt, 64);
      password = '';
      process.stdout.write(`APP_OPERATOR_PASSWORD_SCRYPT=scrypt$${salt.toString('hex')}$${hash.toString('hex')}\n`);
      process.exit(0);
    }
    if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
    else if (character >= ' ' && character !== '\u007f') password += character;
  }
});
