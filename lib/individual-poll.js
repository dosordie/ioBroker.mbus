'use strict';

// Runtime-selectable polling interval per M-Bus device.
//
// The original adapter copies every configured device updateInterval into an
// internal structure during startup. To make that interval switchable at
// runtime without modifying the upstream main.js, this module temporarily sets
// the configured per-device interval to 0 before main.js initializes. The
// original adapter still performs its normal initial read. Afterwards this
// module schedules subsequent reads through the already existing updateNow
// state.
//
// Poll_intervall_inividuell = false -> adapter defaultUpdateInterval
// Poll_intervall_inividuell = true  -> configured interval of this device

const CONTROL_STATE = 'Poll_intervall_inividuell';

let installed = false;
let adapter;
let prepared = false;
const devices = new Map();
const namespaceToDevice = new Map();
const timers = new Map();
const subscribed = new Set();

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
            individualEnabled: false
        });

        // Disable the original per-device recurring timer. main.js still does
        // its normal initial poll for every configured device.
        cfg.updateInterval = 0;
    }

    if (a.log) {
        a.log.info('Runtime poll interval switch enabled: standard=' + standardInterval + 's; ' +
            devices.size + ' device(s) use Poll_intervall_inividuell');
    }
}

function clearTimer(deviceId) {
    const timer = timers.get(deviceId);
    if (timer) clearTimeout(timer);
    timers.delete(deviceId);
}

function clearAllTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
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
    const interval = effectiveInterval(device);

    if (adapter && adapter.log) {
        adapter.log.debug('M-Bus ' + device.namespace + ' next poll in ' + interval + 's (' +
            (device.individualEnabled ? 'individual' : 'standard') + ')');
    }

    if (interval <= 0) return;

    timers.set(device.id, setTimeout(() => {
        timers.delete(device.id);
        pulseUpdateNow(device);

        // Re-arm immediately as a safety net. If updateNow was ignored because
        // the device was already queued/in progress, polling must not stop.
        // A successful getData() will call scheduleNext() again and replace
        // this safety timer with a fresh interval measured from that read.
        scheduleNext(device.id);
    }, interval * 1000));
}

function object(a, id, obj) {
    return new Promise((resolve, reject) => {
        a.setObjectNotExists(id, obj, err => err ? reject(err) : resolve());
    });
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
    if (!adapter || !device || !device.namespace) return false;

    const id = device.namespace + '.' + CONTROL_STATE;
    await object(adapter, id, {
        type: 'state',
        common: {
            name: 'Poll-Intervall individuell',
            role: 'switch.enable',
            type: 'boolean',
            read: true,
            write: true,
            def: false
        },
        native: {
            standardInterval: device.standardInterval,
            individualInterval: device.individualInterval,
            description: 'false = adapter defaultUpdateInterval, true = configured device updateInterval'
        }
    });

    if (!subscribed.has(id)) {
        adapter.subscribeStates(id);
        subscribed.add(id);
    }

    const state = await getState(adapter, id);
    if (!state) {
        device.individualEnabled = false;
        await setState(adapter, id, false, true);
    } else {
        device.individualEnabled = state.val === true;
    }

    return device.individualEnabled;
}

function mapDevice(deviceId, data) {
    const device = devices.get(String(deviceId));
    const info = data && data.SlaveInformation;
    if (!device || !info || !info.Manufacturer || info.Id === undefined) return null;

    const namespace = info.Manufacturer + '-' + info.Id;
    device.namespace = namespace;
    namespaceToDevice.set(namespace, device.id);
    return device;
}

function onReadFinished(deviceId, data) {
    const device = mapDevice(deviceId, data) || devices.get(String(deviceId));
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

    // stateChange IDs are normally fully qualified (mbus.0.<device>.<state>).
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

    // Apply the changed interval immediately to the next scheduled poll.
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

    const oldGetData = MbusMaster.prototype.getData;
    MbusMaster.prototype.getData = function (id, cb) {
        return oldGetData.call(this, id, (err, data) => {
            cb(err, data);
            if (!err && data) onReadFinished(String(id), data);
            else {
                const device = devices.get(String(id));
                if (device && device.namespace) scheduleNext(device.id);
            }
        });
    };
}

module.exports = {
    install,
    CONTROL_STATE,
    normalizeDefaultInterval,
    normalizeDeviceInterval
};
