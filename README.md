# BackupVault Agent

The lightweight client-side daemon utility that securely encrypts, compresses, and streams point-in-time file snapshots to the **BackupVault** platform.

This agent is designed for high-security environments, executing AES-256 zero-knowledge encryption locally before any blocks leave the machine.

---

## Technical Stack & Execution

This agent is built as a lightweight Node.js utility running TypeScript:
* **AES-256-GCM Encryption**: Key generation is performed locally. The private key never leaves your system.
* **Block-Level Deduplication**: Compiles directory file structures and calculates SHA-256 block checksums to sync only modified segments.
* **Auto-Ingestion Client**: Connects via HTTPS to the central platform endpoint APIs.

---

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/dsgiri/backupvault-agent.git
   cd backupvault-agent
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables (Optional):**
   Create a `.env` file in the root directory to customize the target platform server URL (defaults to production `https://www.backupvault.app`):
   ```env
   BACKUPVAULT_SERVER_URL=http://localhost:3000
   ```

---

## Command Reference

### 1. View Agent Status
Check if this machine is registered or view existing endpoint UUID and local key hashes:
```bash
npx tsx src/agent.ts status
```

### 2. Handshake Registration
Register this physical device with your B2B organization vault using the bootstrap token from your billing panel:
```bash
npx tsx src/agent.ts register <bootstrap_token>
```
*This invalidates the setup token, binds the machine OS metadata/MAC address, and receives a secure, unique `bearer_token` stored locally in `agent-config.json`.*

### 3. Run a Backup Sync
Sync a folder or directory to your secure cloud storage partition:
```bash
npx tsx src/agent.ts backup <folder_path>
```
*Calculates block sizes, scans for alterations, encrypts data locally with your key, and submits the integrity verification telemetry reports.*
