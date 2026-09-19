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
  constructor({ idleDisconnectSec = 120, scanTimeoutSec = 30, address = "", adapter = "hci0", keepAlive = false, keepAliveIntervalSec = 60, log = () => {} } = {}) {
    super();
    this.idleDisconnectSec = idleDisconnectSec;
    this.keepAlive = keepAlive;
    this.keepAliveIntervalSec = keepAliveIntervalSec;
    this._keepAliveTimer = null;
    this._keepAliveFailures = 0;
    this.deferred = []; // jobs waiting for the printer to come back: { imageData, popts, label, at }
    this.deferMaxHours = 12;
    this.deferMax = 25;
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
    // The library never notices a link dropped by the printer (its adapter
    // does not listen for noble's peripheral "disconnect"), so also check the
    // underlying peripheral state.
    return !!(this.client && this.client.isConnected && (!this._peripheral || this._peripheral.state === "connected"));
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
      keepAlive: this.keepAlive,
      deferredJobs: this.deferred.length,
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
        let client = await this._ensureConnected();
        let result;
        try {
          result = await fn(client);
        } catch (err) {
          if (isLinkError(err)) {
            // The link died under us: reconnect and run the job once more.
            this.log("link lost during job (" + err.message + "); reconnecting");
            await this._dropClient();
            client = await this._ensureConnected();
            result = await fn(client);
          } else {
            if (/Print timeout/i.test(err.message)) await this._dropClient(); // link is suspect; next job reconnects
            throw err;
          }
        }
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
    const attempts = this.keepAlive && this.queueLength === 0 ? 1 : 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
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
      const t0 = Date.now();
      try {
        await bluezConnectDevice(this.address, { adapter: this.adapter, timeoutMs: this.scanTimeoutSec * 1000 });
      } catch (err) {
        // A timeout means the printer is off / out of range: a 30 s scan will not
        // find it either, and every scan leaves D-Bus state behind, so skip it
        // when we are only keeping the link alive. Quick failures (e.g. a stale
        // link) are worth the scan.
        if (this.keepAlive && Date.now() - t0 > 5000) throw new Error("printer not reachable (" + err.message + ")");
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
    this._peripheral = adapter.peripheral || null;
    if (this._peripheral && typeof this._peripheral.once === "function") {
      this._peripheral.once("disconnect", () => {
        if (this.client === client) {
          this.log("link dropped by the printer");
          this.client = null;
          this._peripheral = null;
          this._clearIdle();
          this.emit("change");
        }
      });
    }
    this.log("connected to " + this.deviceName);
    this.emit("change");
    return client;
  }

  /** Forget the current client without treating it as a user-requested disconnect. */
  async _dropClient() {
    const client = this.client;
    this.client = null;
    this._peripheral = null;
    if (client) { try { await client.disconnect(); } catch {} }
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

  /**
   * Print, or — if the printer is unreachable and keep-alive is on — park the
   * job and print it as soon as the printer is back (jobs older than
   * deferMaxHours are dropped). Resolves { deferred: true } when parked.
   */
  async printOrDefer(imageData, popts, label = "print") {
    try {
      await this.print(imageData, popts, label);
      return { deferred: false };
    } catch (err) {
      if (!this.keepAlive || !isLinkError(err)) throw err;
      this.deferred.push({ imageData, popts, label, at: Date.now() });
      while (this.deferred.length > this.deferMax) this.deferred.shift();
      this.log(`printer unreachable; job "${label}" parked (${this.deferred.length} waiting)`);
      this.lastError = null;
      this.emit("change");
      return { deferred: true };
    }
  }

  async _flushDeferred() {
    if (!this.deferred.length) return;
    const cutoff = Date.now() - this.deferMaxHours * 3600e3;
    const jobs = this.deferred.splice(0);
    const fresh = jobs.filter((j) => j.at >= cutoff);
    if (fresh.length !== jobs.length) this.log(`dropped ${jobs.length - fresh.length} parked job(s) older than ${this.deferMaxHours} h`);
    this.log(`printer is back: printing ${fresh.length} parked job(s)`);
    for (const j of fresh) {
      try { await this.print(j.imageData, j.popts, j.label); }
      catch (err) { this.log(`parked job "${j.label}" failed: ${err.message}`); this.deferred.push(j); }
    }
    this.emit("change");
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
    const had = !!this.client;
    await this._dropClient();
    if (had) this.log("disconnected");
    this.emit("change");
  }

  /**
   * Keep-alive: hold the link permanently and poll the printer's status every
   * keepAliveIntervalSec. On many cat printers the idle auto-power-off timer
   * only runs while nothing is connected, so this keeps the printer ready; it
   * also makes prints start instantly. While it holds the link, the phone app
   * cannot connect. Reconnects with a 30 s backoff when the printer is away.
   */
  setKeepAlive(on, intervalSec = this.keepAliveIntervalSec) {
    this.keepAlive = !!on;
    this.keepAliveIntervalSec = intervalSec;
    clearTimeout(this._keepAliveTimer);
    this._keepAliveTimer = null;
    if (this.keepAlive) {
      this._clearIdle();
      this._keepAliveTick();
    } else {
      this._armIdle();
    }
    this.emit("change");
  }

  _keepAliveTick() {
    if (!this.keepAlive) return;
    const schedule = (sec) => {
      clearTimeout(this._keepAliveTimer);
      this._keepAliveTimer = setTimeout(() => this._keepAliveTick(), sec * 1000);
      this._keepAliveTimer.unref?.();
    };
    if (this.busy || this.queueLength > 0) { schedule(5); return; }
    const wasConnected = this.connected;
    this.run("keep-alive", async (client) => {
      const state = await client.getStatus();
      this.lastStatus = state;
      if (!wasConnected) await this._readInfo(client);
    }).then(() => {
      if (this._keepAliveFailures) this.log("keep-alive: printer is back");
      this._keepAliveFailures = 0;
      this._flushDeferred().catch(() => {});
      schedule(this.keepAliveIntervalSec);
    }, (err) => {
      this._keepAliveFailures++;
      // back off while the printer is away: 30 s, 60 s, 120 s (cap)
      const delay = Math.min(120, 30 * Math.pow(2, Math.min(2, this._keepAliveFailures - 1)));
      if (this._keepAliveFailures === 1) this.log("keep-alive: printer unreachable (" + err.message + "); retrying (30 s → 2 min)");
      this.lastError = null; // an absent printer is not an error worth showing in the UI
      schedule(delay);
    });
  }

  _armIdle() {
    this._clearIdle();
    if (this.keepAlive) return;
    if (!this.connected) return;
    if (this.idleDisconnectSec <= 0) { this.disconnect(); return; }
    this._idleTimer = setTimeout(() => this.disconnect(), this.idleDisconnectSec * 1000);
    this._idleTimer.unref?.();
  }

  _clearIdle() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
}

/** Errors that mean the BLE link is gone (as opposed to the printer refusing a job). */
function isLinkError(err) {
  return /characteristic not found|not connected|disconnected|No peripheral|Failed to connect|Device scan timeout|printer not found/i.test(err && err.message || "");
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
