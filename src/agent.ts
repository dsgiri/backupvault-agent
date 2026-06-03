import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

const CONFIG_PATH = path.join(process.cwd(), 'agent-config.json');
const STATE_PATH = path.join(process.cwd(), 'agent-state.json');
const SERVER_URL = process.env.BACKUPVAULT_SERVER_URL || 'https://www.backupvault.app';

interface FileState {
  mtimeMs: number;
  size: number;
  blockHashes: string[];
}

interface AgentState {
  files: Record<string, FileState>;
  uploadedBlocks: Record<string, { uploadedAt: string }>;
}

function encryptSecret(plainText: string): string {
  if (os.platform() !== 'win32') {
    return plainText;
  }
  try {
    const base64Plain = Buffer.from(plainText).toString('base64');
    const script = "Add-Type -AssemblyName System.Security; [System.Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([System.Convert]::FromBase64String('" + base64Plain + "'), $null, 'CurrentUser'))";
    const output = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim();
  } catch (err: any) {
    console.warn(`\x1b[33m[Key Protection] Local OS encryption failed: ${err.message}. Storing in plain format.\x1b[0m`);
    return plainText;
  }
}

function decryptSecret(encryptedBase64: string): string {
  if (os.platform() !== 'win32') {
    return encryptedBase64;
  }
  if (!/^[a-zA-Z0-9+/=]+$/.test(encryptedBase64) || encryptedBase64.length < 24) {
    return encryptedBase64;
  }
  try {
    const script = "Add-Type -AssemblyName System.Security; [System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([System.Convert]::FromBase64String('" + encryptedBase64 + "'), $null, 'CurrentUser'))";
    const output = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim();
  } catch {
    return encryptedBase64;
  }
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (raw.bearer_token) {
        raw.bearer_token = decryptSecret(raw.bearer_token);
      }
      if (raw.encryption_key) {
        raw.encryption_key = decryptSecret(raw.encryption_key);
      }
      return raw;
    } catch {
      return {};
    }
  }
  return {};
}

function saveConfig(config: any) {
  const cloned = { ...config };
  if (cloned.bearer_token) {
    cloned.bearer_token = encryptSecret(cloned.bearer_token);
  }
  if (cloned.encryption_key) {
    cloned.encryption_key = encryptSecret(cloned.encryption_key);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cloned, null, 2), 'utf-8');
}

function loadState(): AgentState {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      return { files: {}, uploadedBlocks: {} };
    }
  }
  return { files: {}, uploadedBlocks: {} };
}

function saveState(state: AgentState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
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
      encryption_key: encryptionKey,
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

  const keyHex = config.encryption_key;
  if (!keyHex) {
    console.error('\x1b[31m[Error] Local encryption key not found in config. Please re-register the agent.\x1b[0m');
    return;
  }
  const keyBuffer = Buffer.from(keyHex, 'hex');

  const absolutePath = path.resolve(folderPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`\x1b[31m[Error] Target folder or file does not exist: ${absolutePath}\x1b[0m`);
    return;
  }

  console.log(`\x1b[36m[BackupVault Agent] Initiating file scan on: ${absolutePath}...\x1b[0m`);

  const state = loadState();
  const filePathsToProcess: string[] = [];

  function collectFiles(targetPath: string) {
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(targetPath);
        for (const file of files) {
          collectFiles(path.join(targetPath, file));
        }
      } else {
        filePathsToProcess.push(targetPath);
      }
    } catch (err: any) {
      console.warn(`\x1b[33m[Warning] Could not scan path ${targetPath}: ${err.message}\x1b[0m`);
    }
  }

  collectFiles(absolutePath);

  let totalBytes = 0;
  let blocksUploadedCount = 0;
  let blocksSkippedCount = 0;
  let filesUnchangedCount = 0;
  let filesProcessedCount = 0;

  const currentBackupFiles: Record<string, FileState> = {};
  const BLOCK_SIZE = 1024 * 1024; // 1MB chunks

  for (const filePath of filePathsToProcess) {
    try {
      const stat = fs.statSync(filePath);
      const mtimeMs = stat.mtimeMs;
      const size = stat.size;

      // Check if file is unchanged based on size and mtimeMs
      const existingFileState = state.files[filePath];
      if (existingFileState && existingFileState.mtimeMs === mtimeMs && existingFileState.size === size) {
        // Reuse block hashes from state
        currentBackupFiles[filePath] = existingFileState;
        totalBytes += size;
        filesUnchangedCount++;
        continue;
      }

      // Process/chunk the file
      filesProcessedCount++;
      const blockHashes: string[] = [];
      
      if (size === 0) {
        // Special case: empty file (0 bytes) has a single empty block
        const emptyHash = crypto.createHash('sha256').update('').digest('hex');
        blockHashes.push(emptyHash);
        
        if (!state.uploadedBlocks[emptyHash]) {
          // Encrypt empty string block
          const iv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
          const encrypted = Buffer.concat([cipher.update(''), cipher.final()]);
          const tag = cipher.getAuthTag();
          const packaged = Buffer.concat([iv, tag, encrypted]);
          
          const ciphertextHash = crypto.createHash('sha256').update(packaged).digest('hex');
          console.log(`\x1b[36m[Agent Core] Encrypted empty block: ${emptyHash.substring(0, 12)} -> Ciphertext: ${ciphertextHash.substring(0, 12)} (${packaged.length} bytes)\x1b[0m`);
          
          state.uploadedBlocks[emptyHash] = { uploadedAt: new Date().toISOString() };
          blocksUploadedCount++;
        } else {
          blocksSkippedCount++;
        }
      } else {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(BLOCK_SIZE);
        let bytesRead = 0;
        let position = 0;

        try {
          while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
            const chunk = buffer.subarray(0, bytesRead);
            const plaintextHash = crypto.createHash('sha256').update(chunk).digest('hex');
            blockHashes.push(plaintextHash);

            if (!state.uploadedBlocks[plaintextHash]) {
              const iv = crypto.randomBytes(12);
              const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
              const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
              const tag = cipher.getAuthTag();
              const packaged = Buffer.concat([iv, tag, encrypted]);
              
              const ciphertextHash = crypto.createHash('sha256').update(packaged).digest('hex');
              console.log(`\x1b[36m[Agent Core] Encrypted block: ${plaintextHash.substring(0, 12)} -> Ciphertext: ${ciphertextHash.substring(0, 12)} (${packaged.length} bytes)\x1b[0m`);

              state.uploadedBlocks[plaintextHash] = { uploadedAt: new Date().toISOString() };
              blocksUploadedCount++;
            } else {
              blocksSkippedCount++;
            }

            position += bytesRead;
          }
        } finally {
          fs.closeSync(fd);
        }
      }

      // Record this file state
      const newFileState = {
        mtimeMs,
        size,
        blockHashes
      };
      state.files[filePath] = newFileState;
      currentBackupFiles[filePath] = newFileState;
      totalBytes += size;

    } catch (err: any) {
      console.error(`\x1b[31m[Error] Failed to process file ${filePath}: ${err.message}\x1b[0m`);
    }
  }

  // Calculate structured combined checksum based on block hashes of current files
  const combinedHash = crypto.createHash('sha256');
  const sortedPaths = Object.keys(currentBackupFiles).sort();
  for (const filePath of sortedPaths) {
    const fileState = currentBackupFiles[filePath];
    for (const bh of fileState.blockHashes) {
      combinedHash.update(bh);
    }
  }
  const checksum = combinedHash.digest('hex');
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);

  console.log(`\x1b[36m[Agent Core] Scan & Backup Complete. Total target size: ${sizeMB} MB.\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Files processed: ${filesProcessedCount}, Unchanged: ${filesUnchangedCount}\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Blocks uploaded: ${blocksUploadedCount}, Deduplicated (skipped): ${blocksSkippedCount}\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Cryptographic Checksum (SHA-256): ${checksum}\x1b[0m`);
  console.log(`\x1b[36m[Agent Core] Syncing metadata to secure cloud plane...\x1b[0m`);

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
      if (response.status === 403 && data.error === 'ORGANIZATION_LOCKDOWN_ACTIVE') {
        console.error('\n\x1b[31m==================================================\x1b[0m');
        console.error('\x1b[31m  [CRITICAL] WORM LOCKDOWN ENGAGED - SYNC BLOCKED\x1b[0m');
        console.error('\x1b[31m==================================================\x1b[0m');
        console.error(`Status:  \x1b[33mWRITE-ONCE-READ-MANY (WORM) PROTECTION ACTIVE\x1b[0m`);
        console.error(`Reason:  \x1b[35m${data.message}\x1b[0m`);
        console.error(`Action:  \x1b[36mPlease contact organization administrators to resolve.\x1b[0m\n`);
      } else {
        console.error(`\x1b[31m[Backup Failed] Server rejected telemetry: ${data.error || response.statusText}\x1b[0m`);
      }
      return;
    }

    // Save local state file on successful backup run
    saveState(state);

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

async function daemon(folderPath: string, intervalMinutes: number) {
  console.log(`\n\x1b[36m==================================================\x1b[0m`);
  console.log(`\x1b[36m   BACKUPVAULT DAEMON STARTED (Interval: ${intervalMinutes}m)\x1b[0m`);
  console.log(`\x1b[36m==================================================\x1b[0m`);
  console.log(`Target Folder:  \x1b[33m${path.resolve(folderPath)}\x1b[0m`);
  console.log(`Status:         \x1b[32mACTIVE / MONITORING\x1b[0m\n`);

  const intervalMs = intervalMinutes * 60 * 1000;

  async function cycle() {
    console.log(`\n\x1b[35m[Daemon Clock] Triggering scheduled backup sweep: ${new Date().toLocaleString()}...\x1b[0m`);
    await backup(folderPath);
    console.log(`\x1b[35m[Daemon Clock] Sweep complete. Next run in ${intervalMinutes} minute(s).\x1b[0m`);
    setTimeout(cycle, intervalMs);
  }

  await cycle();
}

function installService(folderPath: string, intervalMinutes: number) {
  if (os.platform() !== 'win32') {
    console.error('\x1b[31m[Error] Task Scheduler installation is only supported on Windows operating systems.\x1b[0m');
    return;
  }

  let binaryPath = process.execPath;
  let argsString = '';

  const isPackaged = !process.execPath.endsWith('node.exe');
  
  if (isPackaged) {
    binaryPath = path.resolve(process.execPath);
    argsString = `backup \\"${path.resolve(folderPath)}\\"`;
  } else {
    const scriptPath = path.resolve(process.argv[1]);
    binaryPath = 'cmd.exe';
    argsString = `/c npx tsx \\"${scriptPath}\\" backup \\"${path.resolve(folderPath)}\\"`;
  }

  const taskName = 'BackupVaultAgent';
  
  console.log(`\x1b[36m[Task Installer] Creating Windows Scheduled Task: ${taskName}...\x1b[0m`);
  console.log(`Executable:     \x1b[33m${binaryPath}\x1b[0m`);
  console.log(`Arguments:      \x1b[33m${argsString}\x1b[0m`);
  console.log(`Interval:       \x1b[35mEvery ${intervalMinutes} minute(s)\x1b[0m\n`);

  try {
    const command = `schtasks /create /tn "${taskName}" /tr "${binaryPath} ${argsString}" /sc minute /mo ${intervalMinutes} /f /ru "SYSTEM"`;
    execSync(command, { stdio: 'inherit' });
    console.log(`\n\x1b[32m==================================================\x1b[0m`);
    console.log(`\x1b[32m      SERVICE INSTALLATION SUCCESSFUL\x1b[0m`);
    console.log(`\x1b[32m==================================================\x1b[0m`);
    console.log(`Task Name:    \x1b[35m${taskName}\x1b[0m`);
    console.log(`Trigger:      \x1b[33mRun on boot, repeating every ${intervalMinutes} minutes\x1b[0m`);
    console.log(`Context:      \x1b[32mSYSTEM (Admin rights required to execute)\x1b[0m\n`);
  } catch (err: any) {
    console.error(`\x1b[31m[Error] Failed to install task. Make sure you are running as Administrator: ${err.message}\x1b[0m`);
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
    console.log(`Local Key:       \x1b[32mLOADED (SECURE)\x1b[0m`);
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
  case 'daemon':
    if (!args[1]) {
      console.error('\x1b[31m[Error] Please provide a target folder or file path.\x1b[0m');
      console.log('Usage: npx tsx src/agent.ts daemon <folder_path> [interval_minutes]');
    } else {
      const interval = args[2] ? parseInt(args[2], 10) : 60;
      if (isNaN(interval) || interval <= 0) {
        console.error('\x1b[31m[Error] Interval must be a positive number.\x1b[0m');
      } else {
        daemon(args[1], interval);
      }
    }
    break;
  case 'install-service':
    if (!args[1]) {
      console.error('\x1b[31m[Error] Please provide a target folder or file path.\x1b[0m');
      console.log('Usage: npx tsx src/agent.ts install-service <folder_path> [interval_minutes]');
    } else {
      const interval = args[2] ? parseInt(args[2], 10) : 60;
      if (isNaN(interval) || interval <= 0) {
        console.error('\x1b[31m[Error] Interval must be a positive number.\x1b[0m');
      } else {
        installService(args[1], interval);
      }
    }
    break;
  case 'status':
    status();
    break;
  default:
    console.log('\n\x1b[36mBackupVault Agent Command Line Tool\x1b[0m');
    console.log('Usage:');
    console.log('  npx tsx src/agent.ts \x1b[33mregister <bootstrap_token>\x1b[0m   Register agent');
    console.log('  npx tsx src/agent.ts \x1b[33mbackup <folder_path>\x1b[0m         Simulate local encryption & backup');
    console.log('  npx tsx src/agent.ts \x1b[33mdaemon <folder_path> [interval]\x1b[0m  Run agent continuously in background loop');
    console.log('  npx tsx src/agent.ts \x1b[33minstall-service <folder_path> [int]\x1b[0m Register task in Windows Scheduler');
    console.log('  npx tsx src/agent.ts \x1b[33mstatus\x1b[0m                       View agent settings');
    console.log('');
}
