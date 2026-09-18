// Connection manager for the MXW01: serializes jobs, keeps the link up between
// jobs and drops it after an idle period (the printer only accepts one central,
// so holding the connection blocks the phone app - hence the idle timeout).

const { EventEmitter } = require("events");
const { ThermalPrinterClient, NodeBluetoothAdapter } = require("mxw01-thermal-printer");

/**
 * Ask BlueZ to connect to `address` over LE, bypassing its bearer selection.
 * Needed on BlueZ < 5.79 where the MXW01's bogus "BR/EDR supported" flag makes
 * plain Connect() page classic Bluetooth (see docs/BLUETOOTH.md). Requires
 * Experimental = true in /etc/bluetooth/main.conf. Only meaningful with the
 * dbus noble binding; a no-op elsewhere.
 */
async function bluezConnectDevice(address, { adapter = "hci0", addressType = "public", timeoutMs = 30000 } = {}) {
  const dbus = require("dbus-next");
  const bus = dbus.systemBus();
  const deadline = Date.now() + timeoutMs;
  let timer;
  try {
    const obj = await bus.getProxyObject("org.bluez", "/org/bluez/" + adapter);
    const iface = obj.getInterface("org.bluez.Adapter1");
    const call = iface.ConnectDevice({
      Address: new dbus.Variant("s", address),
      AddressType: new dbus.Variant("s", addressType),
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ConnectDevice timed out")), timeoutMs); });
    try {
      await Promise.race([call, timeout]);
    } catch (err) {
      if (!/AlreadyConnected|AlreadyExists|InProgress/.test(err.message)) throw err;
    }
    clearTimeout(timer);

    // ConnectDevice returns when the LE link is up; BlueZ resolves GATT a
    // moment later. noble only skips its own Device1.Connect() (which BlueZ
    // would try over BR/EDR on this printer) when ServicesResolved is already
    // true, so wait for it here.
    const devPath = `/org/bluez/${adapter}/dev_${address.replace(/:/g, "_")}`;
    const dev = await bus.getProxyObject("org.bluez", devPath);
    const props = dev.getInterface("org.freedesktop.DBus.Properties");
    while (Date.now() < deadline) {
      const [connected, resolved] = await Promise.all([
        props.Get("org.bluez.Device1", "Connected").then((v) => v.value),
        props.Get("org.bluez.Device1", "ServicesResolved").then((v) => v.value),
      ]);
      if (!connected) throw new Error("LE link dropped right after connecting");
      if (resolved) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("connected, but GATT services were not resolved in time");
  } finally {
    clearTimeout(timer);
    bus.disconnect();
  }
}

class PrinterManager extends EventEmitter {
  constructor({ idleDisconnectSec = 120, scanTimeoutSec = 30, address = "", adapter = "hci0", log = () => {} } = {}) {
    super();
    this.idleDisconnectSec = idleDisconnectSec;
    this.scanTimeoutSec = scanTimeoutSec;
    this.address = address;
    this.adapter = adapter;
    this.log = log;
    this.client = null;
    this.deviceName = null;
    this.busy = false;
    this.queueLength = 0;
    this.lastStatus = null;
    this.lastInfo = null; // { battery, temperatureC, firmware, at }
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
      lastInfo: this.lastInfo,
      lastError: this.lastError,
      lastJob: this.lastJob,
      idleDisconnectSec: this.idleDisconnectSec,
      address: this.address,
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

    // Two attempts: the printer occasionally drops the link right after a
    // connect or stops advertising for a few seconds after a burst of jobs.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this._connectOnce();
      } catch (err) {
        lastErr = err;
        this.log(`connect attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr;
  }

  async _connectOnce() {
    const adapter = new NodeBluetoothAdapter();
    const client = new ThermalPrinterClient(adapter);
    client.on("connected", (e) => { this.deviceName = e.device.name; });
    client.on("disconnected", () => {
      if (this.client === client) { this.client = null; this._clearIdle(); this.emit("change"); }
    });
    client.on("stateChange", (e) => { this.lastStatus = e.state; });
    client.on("error", (e) => { this.log("printer error: " + e.error.message); });

    if (this.address && (process.env.NOBLE_BINDINGS || "dbus") === "dbus") {
      this.log(`asking BlueZ for an LE connection to ${this.address}...`);
      try {
        await bluezConnectDevice(this.address, { adapter: this.adapter, timeoutMs: this.scanTimeoutSec * 1000 });
      } catch (err) {
        this.log("ConnectDevice failed (" + err.message + "); falling back to a normal scan");
      }
    }

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

  /**
   * Send a single-byte command (0x00 payload) and wait for the printer's reply
   * payload. Uses the library's own notification dispatcher; the CRC of a lone
   * 0x00 payload byte is 0x00, so the packet can be written out by hand.
   */
  async _query(client, cmd, timeoutMs = 4000) {
    const p = client.printer;
    if (!p) throw new Error("not connected");
    const reply = p.stateManager.waitForNotification(cmd, timeoutMs);
    await p.controlWrite(Uint8Array.of(0x22, 0x21, cmd, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff));
    return reply;
  }

  /** Battery %, head temperature and firmware version (see docs/PROTOCOL notes in README). */
  async _readInfo(client) {
    const info = { ...(this.lastInfo || {}), at: new Date().toISOString() };
    try { info.battery = (await this._query(client, 0xab))[0]; } catch { /* keep previous */ }
    try {
      const st = await this._query(client, 0xa1);
      if (st.length > 4) info.temperatureC = st[4];
    } catch { /* keep previous */ }
    if (!info.firmware) {
      try { info.firmware = Buffer.from(await this._query(client, 0xb1)).toString("latin1").replace(/[^\x20-\x7e]/g, ""); } catch { /* optional */ }
    }
    this.lastInfo = info;
    return info;
  }

  print(imageData, popts, label = "print") {
    return this.run(label, async (client) => {
      await client.print(imageData, popts);
      this.lastStatus = client.printerState;
      await this._readInfo(client);
    });
  }

  status() {
    return this.run("status", async (client) => {
      const state = await client.getStatus();
      this.lastStatus = state;
      const info = await this._readInfo(client);
      return { ...state, ...info };
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

const FLAGS = ["printing", "paper_jam", "out_of_paper", "cover_open", "battery_low", "overheat"];
function describeState(state) {
  if (!state) return "unknown";
  const problems = FLAGS.filter((k) => state[k] && k !== "printing").map((k) => k.replace("_", " "));
  const extra = [];
  if (typeof state.battery === "number") extra.push(`battery ${state.battery}%`);
  if (typeof state.temperatureC === "number") extra.push(`${state.temperatureC}°C`);
  if (state.firmware) extra.push(`fw ${state.firmware}`);
  return (state.printing ? "printing" : "idle") + (problems.length ? ", " + problems.join(", ") : ", no problems") + (extra.length ? " — " + extra.join(", ") : "");
}

module.exports = { PrinterManager, describeState, bluezConnectDevice };
