// Connection manager for the MXW01: serializes jobs, keeps the link up between
// jobs and drops it after an idle period (the printer only accepts one central,
// so holding the connection blocks the phone app - hence the idle timeout).

const { EventEmitter } = require("events");
const { ThermalPrinterClient, NodeBluetoothAdapter } = require("mxw01-thermal-printer");

class PrinterManager extends EventEmitter {
  constructor({ idleDisconnectSec = 120, scanTimeoutSec = 30, log = () => {} } = {}) {
    super();
    this.idleDisconnectSec = idleDisconnectSec;
    this.scanTimeoutSec = scanTimeoutSec;
    this.log = log;
    this.client = null;
    this.deviceName = null;
    this.busy = false;
    this.queueLength = 0;
    this.lastStatus = null;
    this.lastError = null;
    this.lastJob = null;
    this._chain = Promise.resolve();
    this._idleTimer = null;
  }

  get connected() {
    return !!(this.client && this.client.isConnected);
  }

  snapshot() {
    return {
      connected: this.connected,
      deviceName: this.deviceName,
      busy: this.busy,
      queueLength: this.queueLength,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      lastJob: this.lastJob,
      idleDisconnectSec: this.idleDisconnectSec,
    };
  }

  /** Run fn(client) with the printer connected; jobs run one at a time. */
  run(label, fn) {
    this.queueLength++;
    this.emit("change");
    const task = this._chain.then(async () => {
      this.queueLength--;
      this.busy = true;
      this.lastError = null;
      this._clearIdle();
      this.emit("change");
      try {
        const client = await this._ensureConnected();
        const result = await fn(client);
        this.lastJob = { label, at: new Date().toISOString(), ok: true };
        return result;
      } catch (err) {
        this.lastError = err.message || String(err);
        this.lastJob = { label, at: new Date().toISOString(), ok: false, error: this.lastError };
        throw err;
      } finally {
        this.busy = false;
        this._armIdle();
        this.emit("change");
      }
    });
    // keep the chain alive even when a job fails
    this._chain = task.catch(() => {});
    return task;
  }

  async _ensureConnected() {
    if (this.connected) return this.client;
    this.client = null;

    const adapter = new NodeBluetoothAdapter();
    const client = new ThermalPrinterClient(adapter);
    client.on("connected", (e) => { this.deviceName = e.device.name; });
    client.on("disconnected", () => {
      if (this.client === client) { this.client = null; this._clearIdle(); this.emit("change"); }
    });
    client.on("stateChange", (e) => { this.lastStatus = e.state; });
    client.on("error", (e) => { this.log("printer error: " + e.error.message); });

    this.log("connecting...");
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`printer not found within ${this.scanTimeoutSec}s`)), this.scanTimeoutSec * 1000);
    });
    try {
      await Promise.race([client.connect(), timeout]);
    } catch (err) {
      try { await client.disconnect(); } catch {}
      throw err;
    } finally {
      clearTimeout(timer);
    }
    this.client = client;
    this.log("connected to " + this.deviceName);
    this.emit("change");
    return client;
  }

  print(imageData, popts, label = "print") {
    return this.run(label, async (client) => {
      await client.print(imageData, popts);
      this.lastStatus = client.printerState;
    });
  }

  status() {
    return this.run("status", async (client) => {
      const state = await client.getStatus();
      this.lastStatus = state;
      return state;
    });
  }

  connect() {
    return this.run("connect", async () => {});
  }

  async disconnect() {
    this._clearIdle();
    const client = this.client;
    this.client = null;
    if (client) {
      try { await client.disconnect(); } catch {}
      this.log("disconnected");
    }
    this.emit("change");
  }

  _armIdle() {
    this._clearIdle();
    if (!this.connected) return;
    if (this.idleDisconnectSec <= 0) { this.disconnect(); return; }
    this._idleTimer = setTimeout(() => this.disconnect(), this.idleDisconnectSec * 1000);
    this._idleTimer.unref?.();
  }

  _clearIdle() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
}

function describeState(state) {
  if (!state) return "unknown";
  const problems = Object.entries(state).filter(([k, v]) => v && k !== "printing").map(([k]) => k.replace("_", " "));
  return (state.printing ? "printing" : "idle") + (problems.length ? ", " + problems.join(", ") : ", no problems");
}

module.exports = { PrinterManager, describeState };
