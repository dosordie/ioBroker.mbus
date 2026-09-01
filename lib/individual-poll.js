'use strict';

// Runtime-selectable polling interval per M-Bus device.
//
// Poll_intervall_inividuell = false -> adapter defaultUpdateInterval
// Poll_intervall_inividuell = true  -> configured interval of this device
//
// The upstream recurring device timer is disabled. This module owns exactly one
// one-shot timer per device. A timer only requests the next poll; it does NOT
// re-arm itself. The next timer starts only after MbusMaster.close() has fully
// completed. Because this module is installed after sharky775-highres, that
// means a SHARKY cycle includes normal M-Bus read + high-resolution RAM read +
// application reset before the next interval starts.

const CONTROL_STATE = 'Poll_intervall_inividuell';
const DEFAULT_VERSION = 2;

let installed = false;
let adapter;
let prepared = false;
const devices = new Map();
const namespaceToDevice = new Map();
const timers = new Map();
const subscribed = new Set();
const cyclesInProgress = new Set();

function normalizeDefaultInterval(value) {
    if (value && value !== '0' && value !== 0) {
        return parseInt(value, 10) || 3600;
    }
    return 0;
}

function normalizeDeviceInterval(value, fallback) {
    if (value === '' || value === undefined || value === null) return fallback;
    if (value && value !== '0' && value !== 0) return parseInt(value, 10) || fallback;
    return 0;
}

function prepare(a) {
    if (prepared) return;
    prepared = true;
    adapter = a;

    const standardInterval = normalizeDefaultInterval(a.config && a.config.defaultUpdateInterval);
    const configuredDevices = a.config && Array.isArray(a.config.devices) ? a.config.devices : [];

    for (const cfg of configuredDevices) {
        const id = String(cfg.id);
        const individualInterval = normalizeDeviceInterval(cfg.updateInterval, standardInterval);
        devices.set(id, {
            id,
            namespace: null,
            standardInterval,
            individualInterval,
            individualEnabled: true
        });

        // main.js must not create a second recurring timer. It still performs
        // the normal initialization read for every configured device.
        cfg.updateInterval = 0;
    }

    if (a.log) {
        a.log.info('Runtime poll interval switch enabled: default=individual; standard=' + standardInterval + 's; ' +
            devices.size + ' device(s). Poll interval starts after each complete device cycle.');
        for (const device of devices.values()) {
            a.log.info('Runtime poll M-Bus-ID ' + device.id + ': individual=' + device.individualInterval +
                's, standard=' + device.standardInterval + 's, initial mode=individual');
        }
    }
}

function clearTimer(deviceId) {
    const timer = timers.get(String(deviceId));
    if (timer) clearTimeout(timer);
    timers.delete(String(deviceId));
}

function clearAllTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    cyclesInProgress.clear();
}

function effectiveInterval(device) {
    return device.individualEnabled ? device.individualInterval : device.standardInterval;
}

function pulseUpdateNow(device) {
    if (!adapter || !device || !device.namespace) return;

    const id = device.namespace + '.updateNow';
    adapter.setState(id, {val: true, ack: false}, err => {
        if (err && adapter.log) adapter.log.debug('Could not trigger ' + id + ': ' + err);
        setTimeout(() => {
            if (!adapter) return;
            adapter.setState(id, {val: false, ack: true}, () => {});
        }, 100);
    });
}

function scheduleNext(deviceId) {
    const device = devices.get(String(deviceId));
    if (!device || !device.namespace) return;

    clearTimer(device.id);

    // If the device is currently being processed, close() will schedule the
    // timer after the complete cycle. This avoids a timer expiring while a
    // SHARKY high-resolution read/reset is still running.
    if (cyclesInProgress.has(device.id)) {
        if (adapter && adapter.log) {
            adapter.log.debug('M-Bus ' + device.namespace + ' poll timer waits for current device cycle to finish');
        }
        return;
    }

    const interval = effectiveInterval(device);

    if (adapter && adapter.log) {
        adapter.log.debug('M-Bus ' + device.namespace + ' next poll in ' + interval + 's (' +
            (device.individualEnabled ? 'individual' : 'standard') + ', after completed cycle)');
    }

    if (interval <= 0) return;

    timers.set(device.id, setTimeout(() => {
        // One shot only. Do not re-arm here. A successful/failed device cycle
        // will re-arm after close() has completely finished.
        timers.delete(device.id);
        pulseUpdateNow(device);
    }, interval * 1000));
}

function object(a, id, obj) {
    return new Promise((resolve, reject) => {
        a.setObjectNotExists(id, obj, err => err ? reject(err) : resolve());
    });
}

function extendObject(a, id, obj) {
    return new Promise((resolve, reject) => {
        a.extendObject(id, obj, err => err ? reject(err) : resolve());
    });
}

function getObject(a, id) {
    return new Promise(resolve => a.getObject(id, (err, obj) => resolve(err ? null : obj)));
}

function getState(a, id) {
    return new Promise(resolve => a.getState(id, (err, state) => resolve(err ? null : state)));
}

function setState(a, id, val, ack) {
    return new Promise((resolve, reject) => {
        a.setState(id, {val, ack}, err => err ? reject(err) : resolve());
    });
}

async function ensureControlState(device) {
    if (!adapter || !device || !device.namespace) return true;

    const id = device.namespace + '.' + CONTROL_STATE;
    const existingObject = await getObject(adapter, id);
    const migrateToTrue = !existingObject || !existingObject.native || existingObject.native.pollDefaultVersion !== DEFAULT_VERSION;

    await object(adapter, id, {
        type: 'state',
        common: {
            name: 'Poll-Intervall individuell',
            role: 'switch.enable',
            type: 'boolean',
            read: true,
            write: true,
            def: true
        },
        native: {
            standardInterval: device.standardInterval,
            individualInterval: device.individualInterval,
            pollDefaultVersion: DEFAULT_VERSION,
            description: 'false = adapter defaultUpdateInterval, true = configured device updateInterval'
        }
    });

    // 2.7.5 originally created this state with default=false. Migrate that old
    // object once to the requested default=true. The marker prevents later
    // restarts from overwriting a deliberate user choice.
    if (existingObject && migrateToTrue) {
        await extendObject(adapter, id, {
            common: {def: true},
            native: {
                standardInterval: device.standardInterval,
                individualInterval: device.individualInterval,
                pollDefaultVersion: DEFAULT_VERSION,
                description: 'false = adapter defaultUpdateInterval, true = configured device updateInterval'
            }
        });
    }

    if (!subscribed.has(id)) {
        adapter.subscribeStates(id);
        subscribed.add(id);
    }

    const state = await getState(adapter, id);
    if (!state || migrateToTrue) {
        device.individualEnabled = true;
        await setState(adapter, id, true, true);
    } else {
        device.individualEnabled = state.val === true;
    }

    return device.individualEnabled;
}

function mapDevice(deviceId, data) {
    const device = devices.get(String(deviceId));
    const info = data && data.SlaveInformation;
    if (!device || !info || !info.Manufacturer || info.Id === undefined) return device || null;

    const namespace = info.Manufacturer + '-' + info.Id;
    device.namespace = namespace;
    namespaceToDevice.set(namespace, device.id);
    return device;
}

function finishCycle(deviceId, data) {
    const id = String(deviceId);
    const device = mapDevice(id, data) || devices.get(id);
    cyclesInProgress.delete(id);
    if (!device || !device.namespace || !adapter) return;

    ensureControlState(device)
        .then(() => scheduleNext(device.id))
        .catch(err => {
            if (adapter && adapter.log) adapter.log.debug('Poll interval state setup failed for ' + device.id + ': ' + err.message);
            scheduleNext(device.id);
        });
}

function handleStateChange(a, id, state) {
    if (!state || state.ack || !id) return;

    const suffix = '.' + CONTROL_STATE;
    if (!id.endsWith(suffix)) return;

    let relativeId = id;
    if (a.namespace && relativeId.startsWith(a.namespace + '.')) {
        relativeId = relativeId.slice(a.namespace.length + 1);
    }

    const namespace = relativeId.slice(0, -suffix.length);
    const deviceId = namespaceToDevice.get(namespace);
    const device = deviceId ? devices.get(deviceId) : null;
    if (!device) return;

    device.individualEnabled = state.val === true;
    a.setState(namespace + '.' + CONTROL_STATE, {val: device.individualEnabled, ack: true}, () => {});

    if (a.log) {
        a.log.info('M-Bus ' + namespace + ' polling switched to ' +
            (device.individualEnabled ? 'individual ' + device.individualInterval + 's' : 'standard ' + device.standardInterval + 's'));
    }

    // If idle, apply the changed interval immediately. If a device cycle is
    // running, its close() completion will start the timer with the new mode.
    scheduleNext(device.id);
}

function install() {
    if (installed) return;
    installed = true;

    const utils = require('@iobroker/adapter-core');
    const MbusMaster = require('node-mbus');

    const oldOn = utils.Adapter.prototype.on;
    utils.Adapter.prototype.on = function (name, fn) {
        if (!adapter && (this.name === 'mbus' || String(this.namespace || '').startsWith('mbus.'))) adapter = this;

        if (name === 'ready') {
            const a = this;
            return oldOn.call(this, name, function () {
                prepare(a);
                return fn.apply(this, arguments);
            });
        }

        if (name === 'stateChange') {
            const a = this;
            return oldOn.call(this, name, function (id, state) {
                handleStateChange(a, id, state);
                return fn.apply(this, arguments);
            });
        }

        if (name === 'unload') {
            return oldOn.call(this, name, function () {
                clearAllTimers();
                return fn.apply(this, arguments);
            });
        }

        return oldOn.call(this, name, fn);
    };

    // Remember which device is being processed, but do not start its next timer
    // at getData() completion. SHARKY still has proprietary work to do in close().
    const oldGetData = MbusMaster.prototype.getData;
    MbusMaster.prototype.getData = function (id, cb) {
        const deviceId = String(id);
        clearTimer(deviceId);
        cyclesInProgress.add(deviceId);

        return oldGetData.call(this, id, (err, data) => {
            const device = mapDevice(deviceId, data);
            this.__individualPollPending = {
                id: deviceId,
                data: data || null
            };
            cb(err, data);
        });
    };

    // IMPORTANT: individual-poll must be installed AFTER sharky775-highres.
    // oldClose then points at the SHARKY close wrapper. Its callback is invoked
    // only after normal close + optional high-resolution read + application reset.
    const oldClose = MbusMaster.prototype.close;
    MbusMaster.prototype.close = function (cb) {
        const master = this;
        return oldClose.call(master, err => {
            const pending = master.__individualPollPending;
            master.__individualPollPending = null;

            if (pending) finishCycle(pending.id, pending.data);
            if (cb) cb(err);
        });
    };
}

module.exports = {
    install,
    CONTROL_STATE,
    normalizeDefaultInterval,
    normalizeDeviceInterval
};
