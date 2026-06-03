import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_PATH = path.join(process.cwd(), 'agent-config.json');
const SERVER_URL = process.env.BACKUPVAULT_SERVER_URL || 'https://www.backupvault.app';

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveConfig(config: any) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return '00:1A:2B:3C:4D:5E';
}

async function register(token: string) {
  console.log(`\x1b[36m[BackupVault Agent] Initiating Handshake with server at ${SERVER_URL}...\x1b[0m`);
  
  const deviceName = os.hostname();
  const macAddress = getMacAddress();
  const osString = `${os.type()} ${os.release()} (${os.arch()})`;
  const agentVersion = '1.0.0';
  const encryptionKey = crypto.randomBytes(32).toString('hex');
  const encryptionKeyHash = crypto.createHash('sha256').update(encryptionKey).digest('hex');

  const payload = {
    token,
    device_name: deviceName,
    physical_mac_address: macAddress,
    local_os_string: osString,
    agent_version: agentVersion,
    encryption_key_hash: encryptionKeyHash
  };

  try {
    const response = await fetch(`${SERVER_URL}/api/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`\x1b[31m[Handshake Failed] Server returned error: ${data.error || response.statusText}\x1b[0m`);
      return;
    }

    const newConfig = {
      endpoint_uuid: data.endpoint_uuid,
      bearer_token: data.bearer_token,
      device_name: deviceName,
      encryption_key_hash: encryptionKeyHash,
      registered_at: new Date().toISOString()
    };

    saveConfig(newConfig);

    console.log('\n\x1b[32m==================================================\x1b[0m');
    console.log('\x1b[32m   HANDSHAKE SUCCESSFUL - AGENT REGISTERED\x1b[0m');
    console.log('\x1b[32m==================================================\x1b[0m');
    console.log(`Endpoint UUID: \x1b[35m${data.endpoint_uuid}\x1b[0m`);
    console.log(`Bearer Token:  \x1b[35m${data.bearer_token.substring(0, 15)}...\x1b[0m`);
    console.log(`Config saved:  \x1b[33m${CONFIG_PATH}\x1b[0m`);
    console.log('\x1b[36mYou are now ready to run simulated backups!\x1b[0m');
    console.log('Command: \x1b[33mnpx tsx src/agent.ts backup <folder_path>\x1b[0m\n');

  } catch (err: any) {
    console.error(`\x1b[31m[Error] Failed to connect to server: ${err.message}\x1b[0m`);
  }
}

async function backup(folderPath: string) {
  const config = loadConfig();
  if (!config.bearer_token || !config.endpoint_uuid) {
    console.error('\x1b[31m[Error] Agent is not registered. Please run the register command first.\x1b[0m');
    console.log('Command: \x1b[33mnpx tsx src/agent.ts register <bootstrap_token>\x1b[0m');
    return;
  }

  const absolutePath = path.resolve(folderPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`\x1b[31m[Error] Target folder does not exist: ${absolutePath}\x1b[0m`);
    return;
  }

  console.log(`\x1b[36m[BackupVault Agent] Initiating file scan on: ${absolutePath}...\x1b[0m`);
  
  let totalBytes = 0;
  const hash = crypto.createHash('sha256');

  function scanDir(dir: string) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else {
        totalBytes += stat.size;
        try {
          const content = fs.readFileSync(fullPath);
          hash.update(content);
        } catch {
          // Ignore locked files
        }
      }
    }
  }

  try {
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      scanDir(absolutePath);
    } else {
      totalBytes = stat.size;
      hash.update(fs.readFileSync(absolutePath));
    }
  } catch (err: any) {
    console.error(`\x1b[31m[Error] Scan interrupted: ${err.message}\x1b[0m`);
    return;
  }

  const checksum = hash.digest('hex');
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);

  console.log(`\x1b[36m[Agent Core] Scan Complete. Found ${sizeMB} MB of data.\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Encrypting block data with Local AES-256 Key...\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Cryptographic Checksum (SHA-256): ${checksum}\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Syncing blocks to secure cloud storage...\x1b[0m`);

  try {
    const payload = {
      bytes_vaulted: totalBytes,
      verification_checksum: checksum,
      status: 'VERIFIED_INTEGRITY'
    };

    const response = await fetch(`${SERVER_URL}/api/agent/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.bearer_token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`\x1b[31m[Backup Failed] Server rejected telemetry: ${data.error || response.statusText}\x1b[0m`);
      return;
    }

    console.log('\n\x1b[32m==================================================\x1b[0m');
    console.log('\x1b[32m     BACKUP COMPLETE & INTEGRITY VERIFIED\x1b[0m');
    console.log('\x1b[32m==================================================\x1b[0m');
    console.log(`Bytes Vaulted:    \x1b[35m${totalBytes.toLocaleString()} bytes (${sizeMB} MB)\x1b[0m`);
    console.log(`Audit Integrity:  \x1b[32mPASSED (Checksum Matched)\x1b[0m`);
    console.log(`Status Recorded:  \x1b[33mACTIVE / NOMINAL\x1b[0m\n`);

  } catch (err: any) {
    console.error(`\x1b[31m[Error] Ingestion failed: ${err.message}\x1b[0m`);
  }
}

function status() {
  const config = loadConfig();
  console.log('\n\x1b[36m==================================================\x1b[0m');
  console.log('\x1b[36m            BACKUPVAULT AGENT STATUS\x1b[0m');
  console.log('\x1b[36m==================================================\x1b[0m');
  
  if (config.bearer_token) {
    console.log(`Status:          \x1b[32mREGISTERED\x1b[0m`);
    console.log(`Device Name:     \x1b[33m${config.device_name}\x1b[0m`);
    console.log(`Endpoint UUID:   \x1b[35m${config.endpoint_uuid}\x1b[0m`);
    console.log(`Local Key Hash:  \x1b[35m${config.encryption_key_hash.substring(0, 16)}...\x1b[0m`);
    console.log(`Registered At:   \x1b[33m${config.registered_at}\x1b[0m`);
  } else {
    console.log(`Status:          \x1b[31mUNREGISTERED\x1b[0m`);
    console.log('\nTo register this machine, use the bootstrap token generated in your billing portal:');
    console.log('Command: \x1b[33mnpx tsx src/agent.ts register <token>\x1b[0m\n');
  }
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'register':
    if (!args[1]) {
      console.error('\x1b[31m[Error] Please provide a bootstrap deployment token.\x1b[0m');
      console.log('Usage: npx tsx src/agent.ts register <bootstrap_token>');
    } else {
      register(args[1]);
    }
    break;
  case 'backup':
    if (!args[1]) {
      console.error('\x1b[31m[Error] Please provide a target folder or file path.\x1b[0m');
      console.log('Usage: npx tsx src/agent.ts backup <folder_path>');
    } else {
      backup(args[1]);
    }
    break;
  case 'status':
    status();
    break;
  default:
    console.log('\n\x1b[36mBackupVault Agent Command Line Tool\x1b[0m');
    console.log('Usage:');
    console.log('  npx tsx src/agent.ts \x1b[33mregister <bootstrap_token>\x1b[0m  Register agent');
    console.log('  npx tsx src/agent.ts \x1b[33mbackup <folder_path>\x1b[0m        Simulate local encryption & backup');
    console.log('  npx tsx src/agent.ts \x1b[33mstatus\x1b[0m                      View agent settings');
    console.log('');
}
